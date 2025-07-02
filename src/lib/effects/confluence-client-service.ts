/**
 * Effect-based Confluence Client Service
 * Replaces the traditional ConfluenceClient with a fully Effect-based implementation
 * Handles all Confluence API interactions with proper error handling and retry strategies
 */

import { Effect, Layer, Context, pipe, Schedule, Duration, Option, Stream } from 'effect';
import { z } from 'zod';
import { HttpClientService, HttpClientServiceTag, ConfigService, ConfigServiceTag, LoggerService, LoggerServiceTag } from './layers.js';
import { 
  NetworkError, 
  AuthenticationError, 
  NotFoundError, 
  ValidationError,
  RateLimitError,
  TimeoutError,
  ParseError,
  ConfigError
} from './errors.js';

// ============= Confluence API Schemas =============
const PageSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  space: z.object({
    key: z.string(),
    name: z.string(),
    id: z.string().optional(),
    type: z.string().optional(),
  }),
  version: z.object({
    number: z.number(),
    when: z.string(),
    by: z.object({
      displayName: z.string(),
      userKey: z.string().optional(),
      accountId: z.string().optional(),
    }).optional(),
    message: z.string().optional(),
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
    atlas_doc_format: z.object({
      value: z.string(),
      representation: z.literal('atlas_doc_format'),
    }).optional(),
  }).optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
    base: z.string().optional(),
  }),
  ancestors: z.array(z.object({
    id: z.string(),
    title: z.string(),
  })).optional(),
});

const SpaceSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  description: z.object({
    plain: z.object({
      value: z.string(),
      representation: z.literal('plain'),
    }).optional(),
  }).optional(),
  homepage: z.object({
    id: z.string(),
    title: z.string(),
  }).optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
    base: z.string().optional(),
  }),
  permissions: z.array(z.object({
    operation: z.string(),
    targetType: z.string(),
  })).optional(),
});

const PageListResponseSchema = z.object({
  results: z.array(PageSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  _links: z.object({
    base: z.string().optional(),
    context: z.string().optional(),
    next: z.string().optional(),
    prev: z.string().optional(),
  }).optional(),
});

const SpaceListResponseSchema = z.object({
  results: z.array(SpaceSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  _links: z.object({
    base: z.string().optional(),
    context: z.string().optional(),
    next: z.string().optional(),
    prev: z.string().optional(),
  }).optional(),
});

const SearchResultSchema = z.object({
  content: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    space: z.object({
      key: z.string(),
      name: z.string(),
    }).optional(),
    version: z.object({
      number: z.number(),
      when: z.string(),
      by: z.object({
        displayName: z.string(),
      }).optional(),
    }).optional(),
    _links: z.object({
      webui: z.string(),
      self: z.string().optional(),
    }),
  }),
  url: z.string().optional(),
  lastModified: z.string().optional(),
});

const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  totalSize: z.number().optional(),
  _links: z.object({
    base: z.string().optional(),
    context: z.string().optional(),
    next: z.string().optional(),
    prev: z.string().optional(),
  }).optional(),
});

const AttachmentSchema = z.object({
  id: z.string(),
  type: z.literal('attachment'),
  status: z.string(),
  title: z.string(),
  version: z.object({
    number: z.number(),
    when: z.string(),
    by: z.object({
      displayName: z.string(),
    }).optional(),
  }),
  container: z.object({
    id: z.string(),
    title: z.string(),
  }),
  metadata: z.object({
    mediaType: z.string(),
    fileSize: z.number().optional(),
    comment: z.string().optional(),
  }).optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
    download: z.string(),
  }),
});

// ============= Exported Types =============
export type Page = z.infer<typeof PageSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;

export interface SearchOptions {
  start?: number;
  limit?: number;
  expand?: string[];
  spaceKey?: string;
  type?: 'page' | 'blogpost' | 'attachment' | 'comment';
}

export interface PaginatedResult<T> {
  values: T[];
  start: number;
  limit: number;
  size: number;
  totalSize?: number;
  isLast: boolean;
}

export interface PageSearchResult extends PaginatedResult<Page> {}
export interface SpaceSearchResult extends PaginatedResult<Space> {}

export interface PageSummary {
  id: string;
  title: string;
  version: {
    number: number;
    when: string;
    by?: {
      displayName: string;
    };
  };
  webUrl: string;
  spaceKey?: string;
}

export interface SpaceContentOptions {
  start?: number;
  limit?: number;
  expand?: string[];
  depth?: 'all' | 'root';
  status?: 'current' | 'trashed' | 'draft';
}

export interface ContentCreationOptions {
  type: 'page' | 'blogpost';
  title: string;
  space: { key: string };
  body: {
    storage: {
      value: string;
      representation: 'storage';
    };
  };
  ancestors?: Array<{ id: string }>;
}

export interface ContentUpdateOptions {
  version: { number: number };
  title?: string;
  body?: {
    storage: {
      value: string;
      representation: 'storage';
    };
  };
  status?: 'current' | 'draft';
}

// ============= Error Type Aliases =============
type CommonErrors = NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError;
type AllErrors = CommonErrors | ValidationError | NotFoundError;

// ============= Confluence Client Service Interface =============
export interface ConfluenceClientService {
  // Space operations
  readonly getSpace: (spaceKey: string) => Effect.Effect<Space, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly getAllSpaces: (options?: SearchOptions) => Effect.Effect<SpaceSearchResult, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | NotFoundError | ConfigError>;
  readonly getSpacePermissions: (spaceKey: string) => Effect.Effect<Array<{ operation: string; targetType: string }>, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  
  // Content retrieval
  readonly getPage: (pageId: string, expand?: string[]) => Effect.Effect<Page, AllErrors>;
  readonly getPageByTitle: (spaceKey: string, title: string) => Effect.Effect<Option.Option<Page>, ValidationError | CommonErrors | NotFoundError>;
  readonly getSpaceContent: (spaceKey: string, options?: SpaceContentOptions) => Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError>;
  readonly getAllSpacePages: (spaceKey: string) => Stream.Stream<Page, ValidationError | CommonErrors | NotFoundError>;
  readonly getChildPages: (pageId: string, expand?: string[]) => Effect.Effect<Page[], AllErrors>;
  readonly getPageAncestors: (pageId: string) => Effect.Effect<Array<{ id: string; title: string }>, AllErrors>;
  
  // Content search and discovery
  readonly searchContent: (cql: string, options?: SearchOptions) => Effect.Effect<Array<PageSummary>, ValidationError | CommonErrors | NotFoundError>;
  readonly getRecentlyUpdatedPages: (spaceKey: string, limit?: number) => Effect.Effect<PageSummary[], ValidationError | CommonErrors | NotFoundError>;
  readonly getPagesSince: (spaceKey: string, sinceDate: Date) => Stream.Stream<string, ValidationError | CommonErrors | NotFoundError>;
  readonly getSpacePagesLightweight: (spaceKey: string) => Stream.Stream<PageSummary, ValidationError | CommonErrors | NotFoundError>;
  
  // Content creation and updates
  readonly createPage: (options: ContentCreationOptions) => Effect.Effect<Page, ValidationError | CommonErrors | NotFoundError>;
  readonly updatePage: (pageId: string, options: ContentUpdateOptions) => Effect.Effect<Page, AllErrors>;
  readonly deletePage: (pageId: string) => Effect.Effect<void, ValidationError | NotFoundError | CommonErrors>;
  readonly movePage: (pageId: string, targetSpaceKey: string, targetParentId?: string) => Effect.Effect<Page, AllErrors>;
  
  // Attachment operations
  readonly getPageAttachments: (pageId: string) => Effect.Effect<Attachment[], AllErrors>;
  readonly downloadAttachment: (attachmentId: string) => Effect.Effect<ArrayBuffer, ValidationError | NotFoundError | CommonErrors>;
  readonly uploadAttachment: (pageId: string, file: File, comment?: string) => Effect.Effect<Attachment, AllErrors>;
  
  // Batch operations
  readonly batchGetPages: (pageIds: string[], concurrency?: number) => Stream.Stream<Page, AllErrors>;
  readonly batchUpdatePages: (updates: Array<{ pageId: string; options: ContentUpdateOptions }>) => Effect.Effect<Array<{ pageId: string; success: boolean; error?: string }>, ValidationError | CommonErrors | NotFoundError>;
  
  // Analytics and monitoring
  readonly getSpaceAnalytics: (spaceKey: string) => Effect.Effect<{ pageCount: number; recentActivity: number; lastModified?: Date }, ValidationError | CommonErrors | NotFoundError>;
  readonly validateSpaceAccess: (spaceKey: string) => Effect.Effect<boolean, ValidationError | CommonErrors | NotFoundError>;
}

export class ConfluenceClientServiceTag extends Context.Tag('ConfluenceClientService')<
  ConfluenceClientServiceTag,
  ConfluenceClientService
>() {}

// ============= Confluence Client Service Implementation =============
class ConfluenceClientServiceImpl implements ConfluenceClientService {
  private baseUrl: string = '';
  
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService
  ) {}
  
  // ============= Space Operations =============
  getSpace(spaceKey: string): Effect.Effect<Space, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/space/${spaceKey}?expand=description.plain,homepage,permissions`;
        
        return pipe(
          this.logger.debug('Fetching space', { spaceKey }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => SpaceSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse space response', 'space', String(data), error)
            })
          ),
          Effect.tap(() => this.logger.debug('Space fetched successfully', { spaceKey }))
        );
      })
    );
  }
  
  getAllSpaces(options: SearchOptions = {}): Effect.Effect<SpaceSearchResult, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | NotFoundError | ConfigError> {
    return pipe(
      this.initializeBaseUrl(),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          start: (options.start || 0).toString(),
          limit: (options.limit || 25).toString(),
          expand: options.expand?.join(',') || 'description.plain,homepage',
        });
        
        const url = `${this.baseUrl}/space?${params}`;
        
        return pipe(
          this.logger.debug('Fetching all spaces', { options }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = SpaceListResponseSchema.parse(data);
                return {
                  values: result.results,
                  start: result.start,
                  limit: result.limit,
                  size: result.size,
                  isLast: result.results.length < result.limit
                } as SpaceSearchResult;
              },
              catch: (error) => new ParseError('Failed to parse spaces response', 'spaces', String(data), error)
            })
          ),
          Effect.tap((result) => this.logger.debug('Spaces fetched successfully', { count: result.values.length }))
        );
      })
    );
  }
  
  getSpacePermissions(spaceKey: string): Effect.Effect<Array<{ operation: string; targetType: string }>, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.getSpace(spaceKey),
      Effect.map((space) => space.permissions || [])
    );
  }
  
  // ============= Content Retrieval =============
  getPage(pageId: string, expand: string[] = ['body.storage', 'version', 'space', 'ancestors']): Effect.Effect<Page, AllErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          expand: expand.join(',')
        });
        
        const url = `${this.baseUrl}/content/${pageId}?${params}`;
        
        return pipe(
          this.logger.debug('Fetching page', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => PageSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse page response', 'page', String(data), error)
            })
          ),
          Effect.tap(() => this.logger.debug('Page fetched successfully', { pageId }))
        );
      })
    );
  }
  
  getPageByTitle(spaceKey: string, title: string): Effect.Effect<Option.Option<Page>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() => this.validateNonEmpty(title, 'title')),
      Effect.flatMap(() => {
        const cql = `space="${spaceKey}" and type=page and title="${title.replace(/"/g, '\\"')}"`;
        
        return pipe(
          this.searchContent(cql, { limit: 1 }),
          Effect.flatMap((results) => {
            if (results.length === 0) {
              return Effect.succeed(Option.none());
            }
            
            return pipe(
              this.getPage(results[0].id),
              Effect.map(Option.some)
            );
          })
        );
      })
    );
  }
  
  getSpaceContent(spaceKey: string, options: SpaceContentOptions = {}): Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          start: (options.start || 0).toString(),
          limit: (options.limit || 25).toString(),
          expand: options.expand?.join(',') || 'body.storage,version,space',
        });
        
        if (options.depth) {
          params.append('depth', options.depth);
        }
        if (options.status) {
          params.append('status', options.status);
        }
        
        const url = `${this.baseUrl}/space/${spaceKey}/content/page?${params}`;
        
        return pipe(
          this.logger.debug('Fetching space content', { spaceKey, options }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = PageListResponseSchema.parse(data);
                return {
                  values: result.results,
                  start: result.start,
                  limit: result.limit,
                  size: result.size,
                  isLast: result.results.length < result.limit || !result._links?.next
                };
              },
              catch: (error) => new ParseError('Failed to parse space content response', 'spaceContent', String(data), error)
            })
          ),
          Effect.tap((result) => this.logger.debug('Space content fetched successfully', { spaceKey, count: result.values.length }))
        );
      })
    );
  }
  
  getAllSpacePages(spaceKey: string): Stream.Stream<Page, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.validateSpaceKey(spaceKey)),
      Stream.flatMap(() =>
        Stream.paginateEffect(0, (start: number) =>
          pipe(
            this.getSpaceContent(spaceKey, { 
              start, 
              limit: 100, 
              expand: ['body.storage', 'version', 'space'] 
            }),
            Effect.map((result) => [
              result.values,
              result.isLast ? Option.none<number>() : Option.some(start + 100)
            ] as const)
          )
        )
      ),
      Stream.flatMap((pages) => Stream.fromIterable(pages)),
      Stream.rechunk(50)
    );
  }
  
  getChildPages(pageId: string, expand: string[] = ['body.storage', 'version', 'space']): Effect.Effect<Page[], AllErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          expand: expand.join(',')
        });
        
        const url = `${this.baseUrl}/content/${pageId}/child/page?${params}`;
        
        return pipe(
          this.logger.debug('Fetching child pages', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = PageListResponseSchema.parse(data);
                return result.results;
              },
              catch: (error) => new ParseError('Failed to parse child pages response', 'childPages', String(data), error)
            })
          ),
          Effect.tap((pages) => this.logger.debug('Child pages fetched successfully', { pageId, count: pages.length }))
        );
      })
    );
  }
  
  getPageAncestors(pageId: string): Effect.Effect<Array<{ id: string; title: string }>, AllErrors> {
    return pipe(
      this.getPage(pageId, ['ancestors']),
      Effect.map((page) => page.ancestors || [])
    );
  }
  
  // ============= Content Search and Discovery =============
  searchContent(cql: string, options: SearchOptions = {}): Effect.Effect<Array<PageSummary>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.validateCQL(cql),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          cql: cql,
          start: (options.start || 0).toString(),
          limit: (options.limit || 25).toString(),
        });
        
        if (options.expand) {
          params.append('expand', options.expand.join(','));
        }
        
        const url = `${this.baseUrl}/search?${params}`;
        
        return pipe(
          this.logger.debug('Searching content', { cql, options }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = SearchResponseSchema.parse(data);
                return result.results.map((searchResult): PageSummary => ({
                  id: searchResult.content.id,
                  title: searchResult.content.title,
                  version: {
                    number: searchResult.content.version?.number || 0,
                    when: searchResult.content.version?.when || searchResult.lastModified || new Date().toISOString(),
                    by: searchResult.content.version?.by
                  },
                  webUrl: searchResult.content._links.webui,
                  spaceKey: searchResult.content.space?.key
                }));
              },
              catch: (error) => new ParseError('Failed to parse search response', 'searchResults', String(data), error)
            })
          ),
          Effect.tap((results) => this.logger.debug('Content search completed', { cql, count: results.length }))
        );
      })
    );
  }
  
  getRecentlyUpdatedPages(spaceKey: string, limit: number = 10): Effect.Effect<PageSummary[], ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() => {
        const cql = `space="${spaceKey}" and type=page order by lastmodified desc`;
        return this.searchContent(cql, { limit });
      })
    );
  }
  
  getPagesSince(spaceKey: string, sinceDate: Date): Stream.Stream<string, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.validateSpaceKey(spaceKey)),
      Stream.flatMap(() => {
        const formattedDate = sinceDate.toISOString().replace('T', ' ').substring(0, 16);
        const cql = `space="${spaceKey}" and type=page and lastmodified > "${formattedDate}" order by lastmodified desc`;
        
        return Stream.paginateEffect(0, (start: number) =>
          pipe(
            this.searchContent(cql, { start, limit: 100 }),
            Effect.map((results) => [
              results.map(r => r.id),
              results.length < 100 ? Option.none<number>() : Option.some(start + 100)
            ] as const)
          )
        );
      }),
      Stream.flatMap((ids) => Stream.fromIterable(ids))
    );
  }
  
  getSpacePagesLightweight(spaceKey: string): Stream.Stream<PageSummary, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.validateSpaceKey(spaceKey)),
      Stream.flatMap(() =>
        Stream.paginateEffect(0, (start: number) =>
          pipe(
            this.getSpaceContent(spaceKey, { 
              start, 
              limit: 100, 
              expand: ['version', 'space'] 
            }),
            Effect.map((result) => [
              result.values.map((page): PageSummary => ({
                id: page.id,
                title: page.title,
                version: page.version,
                webUrl: page._links.webui,
                spaceKey: page.space.key
              })),
              result.isLast ? Option.none<number>() : Option.some(start + 100)
            ] as const)
          )
        )
      ),
      Stream.flatMap((summaries) => Stream.fromIterable(summaries)),
      Stream.rechunk(50)
    );
  }
  
  // ============= Content Creation and Updates =============
  createPage(options: ContentCreationOptions): Effect.Effect<Page, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.validateContentCreationOptions(options),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content`;
        
        return pipe(
          this.logger.debug('Creating page', { title: options.title, spaceKey: options.space.key }),
          Effect.flatMap(() => this.makeRequest<unknown>(url, {
            method: 'POST',
            body: JSON.stringify(options)
          })),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => PageSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse created page response', 'page', String(data), error)
            })
          ),
          Effect.tap((page) => this.logger.info('Page created successfully', { pageId: page.id, title: page.title }))
        );
      })
    );
  }
  
  updatePage(pageId: string, options: ContentUpdateOptions): Effect.Effect<Page, AllErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.validateContentUpdateOptions(options)),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}`;
        
        return pipe(
          this.logger.debug('Updating page', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url, {
            method: 'PUT',
            body: JSON.stringify(options)
          })),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => PageSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse updated page response', 'page', String(data), error)
            })
          ),
          Effect.tap((page) => this.logger.info('Page updated successfully', { pageId: page.id, title: page.title }))
        );
      })
    );
  }
  
  deletePage(pageId: string): Effect.Effect<void, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}`;
        
        return pipe(
          this.logger.warn('Deleting page', { pageId }),
          Effect.flatMap(() => this.makeRequest<void>(url, { method: 'DELETE' })),
          Effect.tap(() => this.logger.info('Page deleted successfully', { pageId }))
        );
      })
    );
  }
  
  movePage(pageId: string, targetSpaceKey: string, targetParentId?: string): Effect.Effect<Page, AllErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.validateSpaceKey(targetSpaceKey)),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}/move`;
        const body = {
          space: { key: targetSpaceKey },
          ...(targetParentId && { parent: { id: targetParentId } })
        };
        
        return pipe(
          this.logger.debug('Moving page', { pageId, targetSpaceKey, targetParentId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url, {
            method: 'PUT',
            body: JSON.stringify(body)
          })),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => PageSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse moved page response', 'page', String(data), error)
            })
          ),
          Effect.tap((page) => this.logger.info('Page moved successfully', { pageId: page.id, targetSpaceKey }))
        );
      })
    );
  }
  
  // ============= Attachment Operations =============
  getPageAttachments(pageId: string): Effect.Effect<Attachment[], AllErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}/child/attachment?expand=version,container,metadata`;
        
        return pipe(
          this.logger.debug('Fetching page attachments', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = data as { results: unknown[] };
                return result.results.map(attachment => AttachmentSchema.parse(attachment));
              },
              catch: (error) => new ParseError('Failed to parse attachments response', 'attachments', String(data), error)
            })
          ),
          Effect.tap((attachments) => this.logger.debug('Page attachments fetched successfully', { pageId, count: attachments.length }))
        );
      })
    );
  }
  
  downloadAttachment(attachmentId: string): Effect.Effect<ArrayBuffer, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      this.validateAttachmentId(attachmentId),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${attachmentId}/download`;
        
        return pipe(
          this.logger.debug('Downloading attachment', { attachmentId }),
          Effect.flatMap(() => this.makeRawRequest(url)),
          Effect.tap(() => this.logger.debug('Attachment downloaded successfully', { attachmentId }))
        );
      })
    );
  }
  
  uploadAttachment(pageId: string, file: File, comment?: string): Effect.Effect<Attachment, AllErrors> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.initializeBaseUrl()),
      Effect.flatMap(() => {
        const formData = new FormData();
        formData.append('file', file);
        if (comment) {
          formData.append('comment', comment);
        }
        
        const url = `${this.baseUrl}/content/${pageId}/child/attachment`;
        
        return pipe(
          this.logger.debug('Uploading attachment', { pageId, fileName: file.name }),
          Effect.flatMap(() => this.makeFormRequest<unknown>(url, formData)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = data as { results: unknown[] };
                return AttachmentSchema.parse(result.results[0]);
              },
              catch: (error) => new ParseError('Failed to parse upload response', 'attachment', String(data), error)
            })
          ),
          Effect.tap((attachment) => this.logger.info('Attachment uploaded successfully', { pageId, attachmentId: attachment.id }))
        );
      })
    );
  }
  
  // ============= Batch Operations =============
  batchGetPages(pageIds: string[], concurrency: number = 5): Stream.Stream<Page, AllErrors> {
    return pipe(
      Stream.fromIterable(pageIds),
      Stream.mapEffect((pageId) =>
        pipe(
          this.getPage(pageId),
          Effect.catchAll((error) => {
            // Log error but don't fail the entire stream
            return pipe(
              this.logger.warn('Failed to fetch page in batch', { pageId, error: error.message }),
              Effect.flatMap(() => Effect.fail(error))
            );
          })
        )
      ),
      Stream.buffer({ capacity: concurrency }),
      Stream.rechunk(10)
    );
  }
  
  batchUpdatePages(updates: Array<{ pageId: string; options: ContentUpdateOptions }>): Effect.Effect<Array<{ pageId: string; success: boolean; error?: string }>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Effect.forEach(updates, ({ pageId, options }) =>
        pipe(
          this.updatePage(pageId, options),
          Effect.map(() => ({ pageId, success: true as const })),
          Effect.catchAll((error) =>
            Effect.succeed({
              pageId,
              success: false as const,
              error: error.message
            })
          )
        )
      )
    );
  }
  
  // ============= Analytics and Monitoring =============
  getSpaceAnalytics(spaceKey: string): Effect.Effect<{ pageCount: number; recentActivity: number; lastModified?: Date }, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() =>
        Effect.all({
          totalPages: pipe(
            this.getSpaceContent(spaceKey, { limit: 0 }),
            Effect.map((result) => result.size)
          ),
          recentPages: pipe(
            this.getRecentlyUpdatedPages(spaceKey, 10),
            Effect.map((pages) => pages.length)
          ),
          lastModified: pipe(
            this.getRecentlyUpdatedPages(spaceKey, 1),
            Effect.map((pages) => 
              pages.length > 0 ? new Date(pages[0].version.when) : undefined
            )
          )
        })
      ),
      Effect.map(({ totalPages, recentPages, lastModified }) => ({
        pageCount: totalPages,
        recentActivity: recentPages,
        lastModified
      }))
    );
  }
  
  validateSpaceAccess(spaceKey: string): Effect.Effect<boolean, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.getSpace(spaceKey),
      Effect.map(() => true),
      Effect.catchAll((error) => {
        if (error._tag === 'NotFoundError' || error._tag === 'AuthenticationError') {
          return Effect.succeed(false);
        }
        return Effect.fail(error);
      })
    );
  }
  
  // ============= Private Helper Methods =============
  private initializeBaseUrl(): Effect.Effect<void, NetworkError | AuthenticationError | ConfigError> {
    if (this.baseUrl) {
      return Effect.succeed(undefined);
    }
    
    return pipe(
      this.config.getConfig,
      Effect.map((config) => {
        this.baseUrl = `${config.jiraUrl}/wiki/rest/api`;
      })
    );
  }
  
  private makeRequest<T>(url: string, options: RequestInit = {}): Effect.Effect<T, NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ParseError | ConfigError> {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = this.getAuthHeaders(config);
        
        return pipe(
          this.http.request<T>(url, {
            ...options,
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              ...options.headers
            }
          }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(this.createRetrySchedule())
        ) as Effect.Effect<T, NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ParseError | ConfigError, never>;
      })
    );
  }
  
  private makeRawRequest(url: string): Effect.Effect<ArrayBuffer, NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError> {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = this.getAuthHeaders(config);
        
        return pipe(
          this.http.request<ArrayBuffer>(url, { headers }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(this.createRetrySchedule())
        ) as Effect.Effect<ArrayBuffer, NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError, never>;
      })
    );
  }
  
  private makeFormRequest<T>(url: string, formData: FormData): Effect.Effect<T, NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError> {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = this.getAuthHeaders(config);
        // Don't set Content-Type for FormData - let the browser set it with boundary
        delete headers['Content-Type'];
        
        return pipe(
          this.http.request<T>(url, {
            method: 'POST',
            headers,
            body: formData as any
          }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(this.createRetrySchedule())
        ) as Effect.Effect<T, NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError, never>;
      })
    );
  }
  
  private getAuthHeaders(config: { email: string; apiToken: string }): Record<string, string> {
    const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
    };
  }
  
  private mapHttpError = (error: unknown): NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError => {
    // This would need to be implemented based on the HttpClientService error types
    if (error instanceof Error) {
      if (error.message.includes('401') || error.message.includes('403')) {
        return new AuthenticationError(error.message);
      }
      if (error.message.includes('404')) {
        return new NotFoundError(error.message);
      }
      if (error.message.includes('429')) {
        return new RateLimitError(error.message);
      }
      if (error.message.includes('timeout')) {
        return new TimeoutError(error.message);
      }
    }
    return new NetworkError(String(error));
  };
  
  private createRetrySchedule(): Schedule.Schedule<unknown, unknown, unknown> {
    return pipe(
      Schedule.exponential(Duration.millis(100)),
      Schedule.intersect(Schedule.recurs(3)),
      Schedule.jittered
    );
  }
  
  // ============= Validation Methods =============
  private validateSpaceKey(spaceKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!spaceKey || spaceKey.trim().length === 0) {
        throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
      }
    });
  }
  
  private validatePageId(pageId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!pageId || pageId.trim().length === 0) {
        throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
      }
    });
  }
  
  private validateAttachmentId(attachmentId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!attachmentId || attachmentId.trim().length === 0) {
        throw new ValidationError('Attachment ID cannot be empty', 'attachmentId', attachmentId);
      }
    });
  }
  
  private validateCQL(cql: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!cql || cql.trim().length === 0) {
        throw new ValidationError('CQL query cannot be empty', 'cql', cql);
      }
      if (cql.length > 10000) {
        throw new ValidationError('CQL query too long', 'cql', cql);
      }
    });
  }
  
  private validateNonEmpty(value: string, fieldName: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!value || value.trim().length === 0) {
        throw new ValidationError(`${fieldName} cannot be empty`, fieldName, value);
      }
    });
  }
  
  private validateContentCreationOptions(options: ContentCreationOptions): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!options) {
        throw new ValidationError('Content creation options are required', 'options', options);
      }
      if (!options.title || options.title.trim().length === 0) {
        throw new ValidationError('Title is required', 'title', options.title);
      }
      if (!options.space?.key) {
        throw new ValidationError('Space key is required', 'space.key', options.space?.key);
      }
      if (!options.body?.storage?.value) {
        throw new ValidationError('Content body is required', 'body.storage.value', options.body?.storage?.value);
      }
    });
  }
  
  private validateContentUpdateOptions(options: ContentUpdateOptions): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!options) {
        throw new ValidationError('Content update options are required', 'options', options);
      }
      if (!options.version?.number || options.version.number <= 0) {
        throw new ValidationError('Valid version number is required', 'version.number', options.version?.number);
      }
    });
  }
}

// ============= Service Layer =============
export const ConfluenceClientServiceLive = Layer.effect(
  ConfluenceClientServiceTag,
  pipe(
    Effect.all({
      http: HttpClientServiceTag,
      config: ConfigServiceTag,
      logger: LoggerServiceTag
    }),
    Effect.map(({ http, config, logger }) => new ConfluenceClientServiceImpl(http, config, logger))
  )
);

// ============= Helper Functions =============
// Use ConfluenceClientServiceLive directly with Effect.provide() when needed