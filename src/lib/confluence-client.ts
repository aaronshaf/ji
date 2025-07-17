import { Effect, Option, pipe, Schedule, Schema } from 'effect';
import type { Config } from './config.js';
import {
  AuthenticationError,
  ConfluenceError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from './effects/errors.js';

// Confluence API interfaces
interface ConfluenceLinks {
  self?: string;
  base?: string;
  next?: string;
  prev?: string;
  webui?: string;
}

// Simplified Confluence API schemas
const PageSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  title: Schema.String,
  space: Schema.Unknown, // Space structure varies
  version: Schema.Unknown, // Version structure varies
  body: Schema.Unknown.pipe(Schema.optional), // Body structure varies
  _links: Schema.Unknown, // Links structure varies
});

const SearchResultSchema = Schema.Struct({
  content: Schema.Unknown, // Content structure varies
});

const SearchResponseSchema = Schema.Struct({
  results: Schema.Array(SearchResultSchema),
  start: Schema.Number,
  limit: Schema.Number,
  size: Schema.Number,
  totalSize: Schema.Number.pipe(Schema.optional),
  _links: Schema.Unknown.pipe(Schema.optional),
});

const SpaceSchema = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  type: Schema.String,
  status: Schema.String,
  _links: Schema.Unknown,
});

const PageListResponseSchema = Schema.Struct({
  results: Schema.Array(PageSchema),
  start: Schema.Number,
  limit: Schema.Number,
  size: Schema.Number,
  _links: Schema.Unknown.pipe(Schema.optional),
});

// Define interfaces instead of deriving from schemas
export interface Page {
  id: string;
  type: string;
  status: string;
  title: string;
  space: {
    key: string;
    name: string;
  };
  version: {
    number: number;
    when: string;
  };
  body?: {
    storage?: {
      value: string;
      representation: string;
    };
    view?: {
      value: string;
      representation: string;
    };
  };
  _links: {
    self: string;
    webui: string;
  };
}

export interface Space {
  key: string;
  name: string;
  type: string;
  status: string;
  _links: {
    self: string;
    webui: string;
  };
}

export class ConfluenceClient {
  private config: Config;
  private baseUrl: string;
  // Rate limiting: max 10 requests per second
  private rateLimitSchedule = Schedule.fixed('100 millis');
  // Retry with exponential backoff
  private retrySchedule = Schedule.exponential('100 millis').pipe(Schedule.intersect(Schedule.recurs(3)));

  constructor(config: Config) {
    // Prevent real API calls in test environment unless explicitly allowed
    if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API_CALLS) {
      throw new Error(
        'Real API calls detected in test environment! ' +
          'Tests must use mocks to avoid making real Confluence API calls. ' +
          'If you really need to make real calls, set ALLOW_REAL_API_CALLS=true',
      );
    }
    this.config = config;
    // Confluence uses the same base URL as Jira
    this.baseUrl = `${config.jiraUrl}/wiki/rest/api`;
  }

  private getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async getSpace(spaceKey: string): Promise<Space> {
    const url = `${this.baseUrl}/space/${spaceKey}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch space: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return Schema.decodeUnknownSync(SpaceSchema)(data) as Space;
  }

  async getSpaceContent(
    spaceKey: string,
    options?: {
      start?: number;
      limit?: number;
      expand?: string[];
    },
  ): Promise<{ results: Page[]; start: number; limit: number; size: number; _links?: ConfluenceLinks }> {
    const params = new URLSearchParams({
      start: (options?.start || 0).toString(),
      limit: (options?.limit || 25).toString(),
      expand: options?.expand?.join(',') || 'body.storage,version,space',
    });

    const url = `${this.baseUrl}/space/${spaceKey}/content/page?${params}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch space content: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return Schema.decodeUnknownSync(PageListResponseSchema)(data) as {
      results: Page[];
      start: number;
      limit: number;
      size: number;
      _links?: ConfluenceLinks;
    };
  }

  async getPagesSince(spaceKey: string, sinceDate: Date, onProgress?: (current: number) => void): Promise<string[]> {
    // Use CQL to find pages modified since the given date
    // Returns just the page IDs that need to be synced
    const pageIds: string[] = [];
    let start = 0;
    const limit = 100;

    // Format date for CQL (YYYY-MM-DD HH:MM)
    const formattedDate = sinceDate.toISOString().replace('T', ' ').substring(0, 16);
    const cql = `space="${spaceKey}" and type=page and lastmodified > "${formattedDate}" order by lastmodified desc`;

    while (true) {
      const url = `${this.baseUrl}/search?cql=${encodeURIComponent(cql)}&start=${start}&limit=${limit}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to search pages: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        results: Array<{
          content: {
            id: string;
          };
        }>;
        _links?: {
          next?: string;
        };
      };

      // Extract just the page IDs
      const ids = data.results.map((result) => result.content.id);
      pageIds.push(...ids);

      if (onProgress) {
        onProgress(pageIds.length);
      }

      // Check if there are more results
      if (data.results.length < limit || !data._links?.next) {
        break;
      }

      start += limit;
    }

    return pageIds;
  }

  async getRecentlyUpdatedPages(
    spaceKey: string,
    limit: number = 10,
  ): Promise<
    {
      id: string;
      title: string;
      version: { number: number; when: string; by: { displayName: string } };
      webUrl: string;
    }[]
  > {
    // Use CQL to search for recently modified pages in the space
    const cql = `space="${spaceKey}" and type=page order by lastmodified desc`;
    const url = `${this.baseUrl}/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=version`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to search pages: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const parsedData = Schema.decodeUnknownSync(SearchResponseSchema)(data);

    return parsedData.results.map((result) => {
      // The search API doesn't always return version info
      // Use lastModified from the search result instead
      const searchResult = result as { lastModified?: string; content: unknown };

      // Create a schema for the expected content structure
      const ContentSchema = Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        version: Schema.optional(
          Schema.Struct({
            number: Schema.Number,
            when: Schema.optional(Schema.String),
            by: Schema.optional(
              Schema.Struct({
                displayName: Schema.String,
              }),
            ),
          }),
        ),
        _links: Schema.Struct({
          webui: Schema.String,
        }),
      });

      // Safely decode the content
      const content = Schema.decodeUnknownSync(ContentSchema)(result.content);

      return {
        id: content.id,
        title: content.title,
        version: {
          number: content.version?.number || 0,
          when: content.version?.when || searchResult.lastModified || new Date().toISOString(),
          by: {
            displayName: content.version?.by?.displayName || 'Unknown',
          },
        },
        webUrl: content._links.webui,
      };
    });
  }

  async getSpacePagesLightweight(
    spaceKey: string,
    onProgress?: (current: number) => void,
  ): Promise<{ id: string; title: string; version: { number: number; when: string } }[]> {
    const allPages: { id: string; title: string; version: { number: number; when: string } }[] = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['version', 'space'], // Get version and space info, no body content
      });

      const lightweightPages = response.results.map((page: Page) => ({
        id: page.id,
        title: page.title,
        version: page.version,
      }));

      allPages.push(...lightweightPages);

      // Report progress
      if (onProgress) {
        onProgress(allPages.length);
      }

      if (response.results.length < limit) {
        break;
      }

      start += limit;
    }

    return allPages;
  }

  async getAllPagesMetadata(
    spaceKey: string,
    onProgress?: (current: number, total: number) => void,
  ): Promise<Array<{ id: string; title: string; version: { number: number; when: string } }>> {
    const allMetadata: Array<{ id: string; title: string; version: { number: number; when: string } }> = [];
    let start = 0;
    const limit = 250; // Max for metadata-only requests
    let hasMore = true;
    let estimatedTotal = 0;

    while (hasMore) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['version'], // Only get version info, no content
      });

      // Confluence doesn't provide total count, so we estimate based on pagination
      if (response.results.length === limit) {
        // If we got a full page, assume there are more pages
        estimatedTotal = allMetadata.length + limit;
      } else {
        // This is the last page
        estimatedTotal = allMetadata.length + response.results.length;
      }

      const metadata = response.results.map((page) => ({
        id: page.id,
        title: page.title,
        version: {
          number: page.version.number,
          when: page.version.when,
        },
      }));

      allMetadata.push(...metadata);

      if (onProgress) {
        onProgress(allMetadata.length, estimatedTotal || allMetadata.length);
      }

      if (response._links?.next) {
        start += limit;
      } else {
        hasMore = false;
      }
    }

    return allMetadata;
  }

  async getAllSpacePages(spaceKey: string, onProgress?: (current: number, total: number) => void): Promise<Page[]> {
    const allPages: Page[] = [];
    let start = 0;
    const limit = 100; // Max allowed by API
    let hasMore = true;
    let estimatedTotal = 0;

    while (hasMore) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['body.storage', 'version', 'space'],
      });

      allPages.push(...response.results);

      // The API doesn't give us a total count, so we estimate based on whether there are more pages
      // If we got a full page of results, there are likely more pages
      if (response.results.length === limit) {
        // Estimate there's at least one more full page
        estimatedTotal = allPages.length + limit;
      } else {
        // This is the last page, we know the exact total
        estimatedTotal = allPages.length;
        hasMore = false;
      }

      if (onProgress) {
        onProgress(allPages.length, estimatedTotal);
      }

      // Check if there are more pages
      if (!response._links?.next || response.results.length === 0) {
        hasMore = false;
      }

      start += limit;
    }

    return allPages;
  }

  async getPage(pageId: string): Promise<Page> {
    const url = `${this.baseUrl}/content/${pageId}?expand=body.storage,body.view,version,space`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch page: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return Schema.decodeUnknownSync(PageSchema)(data) as Page;
  }

  async getChildPages(pageId: string): Promise<Page[]> {
    const url = `${this.baseUrl}/content/${pageId}/child/page?expand=body.storage,version,space`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch child pages: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const parsed = Schema.decodeUnknownSync(PageListResponseSchema)(data);
    return parsed.results as Page[];
  }

  /**
   * Effect-based HTTP request with retry logic and proper error handling
   */
  private makeRequestEffect<T>(
    url: string,
    options: RequestInit = {},
    parser?: (data: unknown) => T,
  ): Effect.Effect<T, NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> {
    return pipe(
      Effect.tryPromise({
        try: async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

          try {
            const response = await fetch(url, {
              ...options,
              headers: {
                ...this.getHeaders(),
                ...options.headers,
              },
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              const errorText = await response.text();

              if (response.status === 401 || response.status === 403) {
                throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
              }

              if (response.status === 404) {
                throw new NotFoundError(`Resource not found: ${response.status} - ${errorText}`);
              }

              if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                throw new RateLimitError(
                  `Rate limit exceeded: ${response.status} - ${errorText}`,
                  retryAfter ? parseInt(retryAfter) * 1000 : undefined,
                );
              }

              throw new NetworkError(`HTTP ${response.status}: ${errorText}`);
            }

            const data = await response.json();

            if (parser) {
              try {
                return parser(data);
              } catch (error) {
                throw new ParseError('Failed to parse response', undefined, data, error);
              }
            }

            return data as T;
          } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof DOMException && error.name === 'AbortError') {
              throw new TimeoutError('Request timeout after 30 seconds');
            }
            throw error;
          }
        },
        catch: (error) => {
          if (
            error instanceof NetworkError ||
            error instanceof TimeoutError ||
            error instanceof RateLimitError ||
            error instanceof AuthenticationError ||
            error instanceof NotFoundError ||
            error instanceof ParseError
          ) {
            return error;
          }
          return new NetworkError(`Request failed: ${error}`);
        },
      }),
      Effect.retry(this.retrySchedule),
    );
  }

  /**
   * Effect-based get space with proper error handling
   */
  getSpaceEffect(
    spaceKey: string,
  ): Effect.Effect<
    Space,
    ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError
  > {
    return pipe(
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/space/${spaceKey}`;
        return this.makeRequestEffect(
          url,
          { method: 'GET' },
          (data) => Schema.decodeUnknownSync(SpaceSchema)(data) as Space,
        );
      }),
    );
  }

  /**
   * Effect-based get page with validation and error handling
   */
  getPageEffect(
    pageId: string,
  ): Effect.Effect<
    Page,
    ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError
  > {
    return pipe(
      Effect.sync(() => {
        if (!pageId || pageId.trim().length === 0) {
          throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}?expand=body.storage,body.view,version,space`;
        return this.makeRequestEffect(
          url,
          { method: 'GET' },
          (data) => Schema.decodeUnknownSync(PageSchema)(data) as Page,
        );
      }),
    );
  }

  /**
   * Effect-based get space content with pagination support
   */
  getSpaceContentEffect(
    spaceKey: string,
    options?: {
      start?: number;
      limit?: number;
      expand?: string[];
    },
  ): Effect.Effect<
    { results: Page[]; start: number; limit: number; size: number; _links?: ConfluenceLinks },
    ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError
  > {
    return pipe(
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
        if (options?.start !== undefined && options.start < 0) {
          throw new ValidationError('Start must be non-negative', 'start', options.start);
        }
        if (options?.limit !== undefined && (options.limit <= 0 || options.limit > 200)) {
          throw new ValidationError('Limit must be between 1 and 200', 'limit', options.limit);
        }
      }),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          start: (options?.start || 0).toString(),
          limit: (options?.limit || 25).toString(),
          expand: options?.expand?.join(',') || 'body.storage,version,space',
        });

        const url = `${this.baseUrl}/space/${spaceKey}/content/page?${params}`;
        return this.makeRequestEffect(
          url,
          { method: 'GET' },
          (data) =>
            Schema.decodeUnknownSync(PageListResponseSchema)(data) as {
              results: Page[];
              start: number;
              limit: number;
              size: number;
              _links?: ConfluenceLinks;
            },
        );
      }),
    );
  }

  /**
   * Effect-based get all space pages with proper progress tracking
   */
  getAllSpacePagesEffect(
    spaceKey: string,
    onProgress?: (current: number, total: number) => void,
  ): Effect.Effect<
    Page[],
    ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError
  > {
    return pipe(
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        const getAllPages = (
          start: number,
          accumulator: Page[] = [],
        ): Effect.Effect<
          Page[],
          | ValidationError
          | NetworkError
          | TimeoutError
          | RateLimitError
          | AuthenticationError
          | NotFoundError
          | ParseError
        > => {
          return pipe(
            this.getSpaceContentEffect(spaceKey, {
              start,
              limit: 100,
              expand: ['body.storage', 'version', 'space'],
            }),
            Effect.flatMap((response) => {
              const newPages = [...accumulator, ...response.results];

              // Calculate estimated total
              let estimatedTotal = newPages.length;
              if (response.results.length === 100) {
                estimatedTotal = newPages.length + 100; // Estimate at least one more page
              }

              if (onProgress) {
                onProgress(newPages.length, estimatedTotal);
              }

              // Check if there are more pages
              if (response.results.length === 0 || !response._links?.next) {
                return Effect.succeed(newPages);
              }

              // Recursively fetch next batch
              return getAllPages(start + 100, newPages);
            }),
          );
        };

        return getAllPages(0);
      }),
    );
  }

  /**
   * Circuit breaker pattern for handling service unavailability
   */
  private circuitBreakerEffect<T>(
    effect: Effect.Effect<
      T,
      NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError
    >,
  ): Effect.Effect<Option.Option<T>, ConfluenceError> {
    return pipe(
      effect,
      Effect.map((result) => Option.some(result)),
      Effect.catchAll((error) => {
        // If we get too many failures, return None instead of failing
        if (error._tag === 'NetworkError' || error._tag === 'TimeoutError') {
          console.warn(`Confluence service degraded: ${error.message}`);
          return Effect.succeed(Option.none());
        }
        // Re-throw authentication and validation errors
        return Effect.fail(new ConfluenceError(`Confluence operation failed: ${error.message}`, error));
      }),
    );
  }

  /**
   * Batch operation with concurrency control
   */
  batchGetPagesEffect(
    pageIds: string[],
    concurrency: number = 5,
  ): Effect.Effect<
    Page[],
    ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError
  > {
    return pipe(
      Effect.sync(() => {
        if (!Array.isArray(pageIds) || pageIds.length === 0) {
          throw new ValidationError('Page IDs must be a non-empty array', 'pageIds', pageIds);
        }
        if (concurrency <= 0 || concurrency > 10) {
          throw new ValidationError('Concurrency must be between 1 and 10', 'concurrency', concurrency);
        }
      }),
      Effect.flatMap(() => {
        const effects = pageIds.map((pageId) => this.getPageEffect(pageId));
        return Effect.all(effects, { concurrency });
      }),
    );
  }
}
