/**
 * Confluence Content Operations
 * All content-related operations (pages, creation, updates)
 */

import { Effect, Option, pipe, Schema, Stream } from 'effect';
import {
  AuthenticationError,
  type ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  type ValidationError,
} from '../errors.js';
import type { ConfigService, HttpClientService, LoggerService } from '../layers.js';
import {
  createRetrySchedule,
  getAuthHeaders,
  validateContentCreationOptions,
  validateContentUpdateOptions,
  validateNonEmpty,
  validatePageId,
  validateSpaceKey,
} from './helpers.js';
import { type Page, PageListResponseSchema, PageSchema } from './schemas.js';
import type {
  AllErrors,
  CommonErrors,
  ContentCreationOptions,
  ContentUpdateOptions,
  PageSearchResult,
  PageSummary,
  SearchOptions,
  SpaceContentOptions,
} from './types.js';

export class ContentOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private baseUrl: string,
    private searchContent: (cql: string, options?: SearchOptions) => Effect.Effect<PageSummary[], AllErrors>,
  ) {}

  // ============= Content Retrieval =============
  getPage(
    pageId: string,
    expand: string[] = ['body.storage', 'version', 'space', 'ancestors'],
  ): Effect.Effect<Page, AllErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          expand: expand.join(','),
        });

        const url = `${this.baseUrl}/content/${pageId}?${params}`;

        return pipe(
          this.logger.debug('Fetching page', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(PageSchema)(data),
              catch: (error) => new ParseError('Failed to parse page response', 'page', String(data), error),
            }),
          ),
          Effect.tap(() => this.logger.debug('Page fetched successfully', { pageId })),
        );
      }),
    );
  }

  getPageByTitle(
    spaceKey: string,
    title: string,
  ): Effect.Effect<Option.Option<Page>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      validateSpaceKey(spaceKey),
      Effect.flatMap(() => validateNonEmpty(title, 'title')),
      Effect.flatMap(() => {
        const cql = `space="${spaceKey}" and type=page and title="${title.replace(/"/g, '\\"')}"`;

        return pipe(
          this.searchContent(cql, { limit: 1 }),
          Effect.flatMap((results) => {
            if (results.length === 0) {
              return Effect.succeed(Option.none());
            }

            return pipe(this.getPage(results[0].id), Effect.map(Option.some));
          }),
        );
      }),
    );
  }

  getSpaceContent(
    spaceKey: string,
    options: SpaceContentOptions = {},
  ): Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      validateSpaceKey(spaceKey),
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
                const result = Schema.decodeUnknownSync(PageListResponseSchema)(data);
                return {
                  values: result.results,
                  start: result.start,
                  limit: result.limit,
                  size: result.size,
                  isLast: result.results.length < result.limit || !result._links?.next,
                };
              },
              catch: (error) =>
                new ParseError('Failed to parse space content response', 'spaceContent', String(data), error),
            }),
          ),
          Effect.tap((result) =>
            this.logger.debug('Space content fetched successfully', { spaceKey, count: result.values.length }),
          ),
        );
      }),
    );
  }

  getAllSpacePages(spaceKey: string): Stream.Stream<Page, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(validateSpaceKey(spaceKey)),
      Stream.flatMap(() =>
        Stream.paginateEffect(0, (start: number) =>
          pipe(
            this.getSpaceContent(spaceKey, {
              start,
              limit: 100,
              expand: ['body.storage', 'version', 'space'],
            }),
            Effect.map(
              (result) => [result.values, result.isLast ? Option.none<number>() : Option.some(start + 100)] as const,
            ),
          ),
        ),
      ),
      Stream.flatMap((pages) => Stream.fromIterable(pages)),
      Stream.rechunk(50),
    );
  }

  getChildPages(
    pageId: string,
    expand: string[] = ['body.storage', 'version', 'space'],
  ): Effect.Effect<readonly Page[] | Page[], AllErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          expand: expand.join(','),
        });

        const url = `${this.baseUrl}/content/${pageId}/child/page?${params}`;

        return pipe(
          this.logger.debug('Fetching child pages', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = Schema.decodeUnknownSync(PageListResponseSchema)(data);
                return result.results;
              },
              catch: (error) =>
                new ParseError('Failed to parse child pages response', 'childPages', String(data), error),
            }),
          ),
          Effect.tap((pages) => this.logger.debug('Child pages fetched successfully', { pageId, count: pages.length })),
        );
      }),
    );
  }

  getPageAncestors(
    pageId: string,
  ): Effect.Effect<ReadonlyArray<{ id: string; title: string }> | Array<{ id: string; title: string }>, AllErrors> {
    return pipe(
      this.getPage(pageId, ['ancestors']),
      Effect.map((page) => page.ancestors || []),
    );
  }

  // ============= Content Creation and Updates =============
  createPage(options: ContentCreationOptions): Effect.Effect<Page, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      validateContentCreationOptions(options),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content`;

        return pipe(
          this.logger.debug('Creating page', { title: options.title, spaceKey: options.space.key }),
          Effect.flatMap(() =>
            this.makeRequest<unknown>(url, {
              method: 'POST',
              body: JSON.stringify(options),
            }),
          ),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(PageSchema)(data),
              catch: (error) => new ParseError('Failed to parse created page response', 'page', String(data), error),
            }),
          ),
          Effect.tap((page) => this.logger.info('Page created successfully', { pageId: page.id, title: page.title })),
        );
      }),
    );
  }

  updatePage(pageId: string, options: ContentUpdateOptions): Effect.Effect<Page, AllErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => validateContentUpdateOptions(options)),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}`;

        return pipe(
          this.logger.debug('Updating page', { pageId }),
          Effect.flatMap(() =>
            this.makeRequest<unknown>(url, {
              method: 'PUT',
              body: JSON.stringify(options),
            }),
          ),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(PageSchema)(data),
              catch: (error) => new ParseError('Failed to parse updated page response', 'page', String(data), error),
            }),
          ),
          Effect.tap((page) => this.logger.info('Page updated successfully', { pageId: page.id, title: page.title })),
        );
      }),
    );
  }

  deletePage(pageId: string): Effect.Effect<void, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}`;

        return pipe(
          this.logger.warn('Deleting page', { pageId }),
          Effect.flatMap(() => this.makeRequest<void>(url, { method: 'DELETE' })),
          Effect.tap(() => this.logger.info('Page deleted successfully', { pageId })),
        );
      }),
    );
  }

  movePage(pageId: string, targetSpaceKey: string, targetParentId?: string): Effect.Effect<Page, AllErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => validateSpaceKey(targetSpaceKey)),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}/move`;
        const body = {
          space: { key: targetSpaceKey },
          ...(targetParentId && { parent: { id: targetParentId } }),
        };

        return pipe(
          this.logger.debug('Moving page', { pageId, targetSpaceKey, targetParentId }),
          Effect.flatMap(() =>
            this.makeRequest<unknown>(url, {
              method: 'PUT',
              body: JSON.stringify(body),
            }),
          ),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(PageSchema)(data),
              catch: (error) => new ParseError('Failed to parse moved page response', 'page', String(data), error),
            }),
          ),
          Effect.tap((page) => this.logger.info('Page moved successfully', { pageId: page.id, targetSpaceKey })),
        );
      }),
    );
  }

  // ============= Private Helper Methods =============
  private makeRequest<T>(
    url: string,
    options: RequestInit = {},
  ): Effect.Effect<
    T,
    NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ParseError | ConfigError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = getAuthHeaders(config);

        return pipe(
          this.http.request<T>(url, {
            ...options,
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              ...options.headers,
            },
          }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(createRetrySchedule()),
        ) as Effect.Effect<
          T,
          NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ParseError | ConfigError,
          never
        >;
      }),
    );
  }

  private mapHttpError = (
    error: unknown,
  ): NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError => {
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
}
