import { z } from 'zod';
import type { Config } from './config.js';
import { Effect, Schedule, pipe, Option } from 'effect';
import {
  NetworkError,
  TimeoutError,
  RateLimitError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  ParseError,
  ConfluenceError
} from './effects/errors.js';

// Confluence API schemas
const PageSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  space: z.object({
    key: z.string(),
    name: z.string(),
  }),
  version: z.object({
    number: z.number(),
    when: z.string(),
  }),
  body: z.object({
    storage: z.object({
      value: z.string(),
      representation: z.literal('storage'),
    }).optional(),
    view: z.object({
      value: z.string(),
      representation: z.literal('view'),
    }).optional(),
  }).optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
  }),
});

// Schema for search API results - Confluence search API wraps results in 'content'
const SearchResultSchema = z.object({
  content: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    version: z.object({
      number: z.number(),
      when: z.string(),
      by: z.object({
        displayName: z.string(),
      }).optional(),
    }).optional(), // Make version optional for now to debug
    _links: z.object({
      webui: z.string(),
    }),
  }),
});

const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  totalSize: z.number().optional(),
  _links: z.object({
    next: z.string().optional(),
  }).optional(),
});

const SpaceSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
  }),
});

const PageListResponseSchema = z.object({
  results: z.array(PageSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  _links: z.object({
    next: z.string().optional(),
  }).optional(),
});

export type Page = z.infer<typeof PageSchema>;
export type Space = z.infer<typeof SpaceSchema>;

export class ConfluenceClient {
  private config: Config;
  private baseUrl: string;
  // Rate limiting: max 10 requests per second
  private rateLimitSchedule = Schedule.fixed('100 millis');
  // Retry with exponential backoff
  private retrySchedule = Schedule.exponential('100 millis').pipe(
    Schedule.intersect(Schedule.recurs(3))
  );

  constructor(config: Config) {
    this.config = config;
    // Confluence uses the same base URL as Jira
    this.baseUrl = `${config.jiraUrl}/wiki/rest/api`;
  }

  private getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
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
    return SpaceSchema.parse(data);
  }

  async getSpaceContent(spaceKey: string, options?: {
    start?: number;
    limit?: number;
    expand?: string[];
  }): Promise<z.infer<typeof PageListResponseSchema>> {
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
    return PageListResponseSchema.parse(data);
  }

  async getPagesSince(
    spaceKey: string,
    sinceDate: Date,
    onProgress?: (current: number) => void
  ): Promise<string[]> {
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

      const data = await response.json() as {
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
      const ids = data.results.map(result => result.content.id);
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
    limit: number = 10
  ): Promise<{ id: string; title: string; version: { number: number; when: string; by: { displayName: string } }; webUrl: string }[]> {
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
    const parsedData = SearchResponseSchema.parse(data);
    
    return parsedData.results.map((result) => {
      // The search API doesn't always return version info
      // Use lastModified from the search result instead
      const searchResult = result as z.infer<typeof SearchResultSchema> & { lastModified?: string };
      return {
        id: result.content.id,
        title: result.content.title,
        version: {
          number: result.content.version?.number || 0,
          when: result.content.version?.when || searchResult.lastModified || new Date().toISOString(),
          by: {
            displayName: result.content.version?.by?.displayName || 'Unknown'
          }
        },
        webUrl: result.content._links.webui
      };
    });
  }

  async getSpacePagesLightweight(
    spaceKey: string,
    onProgress?: (current: number) => void
  ): Promise<{ id: string; title: string; version: { number: number; when: string }; }[]> {
    const allPages: { id: string; title: string; version: { number: number; when: string }; }[] = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['version', 'space'] // Get version and space info, no body content
      });

      const lightweightPages = response.results.map(page => ({
        id: page.id,
        title: page.title,
        version: page.version
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
    return PageSchema.parse(data);
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
    const parsed = PageListResponseSchema.parse(data);
    return parsed.results;
  }

  /**
   * Effect-based HTTP request with retry logic and proper error handling
   */
  private makeRequestEffect<T>(
    url: string,
    options: RequestInit = {},
    parser?: (data: unknown) => T
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
                  retryAfter ? parseInt(retryAfter) * 1000 : undefined
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
          if (error instanceof NetworkError || 
              error instanceof TimeoutError ||
              error instanceof RateLimitError ||
              error instanceof AuthenticationError ||
              error instanceof NotFoundError ||
              error instanceof ParseError) {
            return error;
          }
          return new NetworkError(`Request failed: ${error}`);
        }
      }),
      Effect.retry(this.retrySchedule)
    );
  }

  /**
   * Effect-based get space with proper error handling
   */
  getSpaceEffect(spaceKey: string): Effect.Effect<Space, ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> {
    return pipe(
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/space/${spaceKey}`;
        return this.makeRequestEffect(url, { method: 'GET' }, (data) => SpaceSchema.parse(data));
      })
    );
  }

  /**
   * Effect-based get page with validation and error handling
   */
  getPageEffect(pageId: string): Effect.Effect<Page, ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> {
    return pipe(
      Effect.sync(() => {
        if (!pageId || pageId.trim().length === 0) {
          throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}?expand=body.storage,body.view,version,space`;
        return this.makeRequestEffect(url, { method: 'GET' }, (data) => PageSchema.parse(data));
      })
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
    }
  ): Effect.Effect<z.infer<typeof PageListResponseSchema>, ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> {
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
        return this.makeRequestEffect(url, { method: 'GET' }, (data) => PageListResponseSchema.parse(data));
      })
    );
  }

  /**
   * Effect-based get all space pages with proper progress tracking
   */
  getAllSpacePagesEffect(
    spaceKey: string,
    onProgress?: (current: number, total: number) => void
  ): Effect.Effect<Page[], ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> {
    return pipe(
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        const getAllPages = (start: number, accumulator: Page[] = []): Effect.Effect<Page[], ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> => {
          return pipe(
            this.getSpaceContentEffect(spaceKey, {
              start,
              limit: 100,
              expand: ['body.storage', 'version', 'space'],
            }),
            Effect.flatMap(response => {
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
            })
          );
        };
        
        return getAllPages(0);
      })
    );
  }

  /**
   * Circuit breaker pattern for handling service unavailability
   */
  private circuitBreakerEffect<T>(
    effect: Effect.Effect<T, NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError>
  ): Effect.Effect<Option.Option<T>, ConfluenceError> {
    return pipe(
      effect,
      Effect.map(result => Option.some(result)),
      Effect.catchAll(error => {
        // If we get too many failures, return None instead of failing
        if (error._tag === 'NetworkError' || error._tag === 'TimeoutError') {
          console.warn(`Confluence service degraded: ${error.message}`);
          return Effect.succeed(Option.none());
        }
        // Re-throw authentication and validation errors
        return Effect.fail(new ConfluenceError(`Confluence operation failed: ${error.message}`, error));
      })
    );
  }

  /**
   * Batch operation with concurrency control
   */
  batchGetPagesEffect(
    pageIds: string[],
    concurrency: number = 5
  ): Effect.Effect<Page[], ValidationError | NetworkError | TimeoutError | RateLimitError | AuthenticationError | NotFoundError | ParseError> {
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
        const effects = pageIds.map(pageId => this.getPageEffect(pageId));
        return Effect.all(effects, { concurrency });
      })
    );
  }
}