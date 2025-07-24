/**
 * Confluence Search Operations
 * All search and discovery related operations
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
import { createRetrySchedule, getAuthHeaders, validateCQL, validateSpaceKey } from './helpers.js';
import { type Page, SearchResponseSchema } from './schemas.js';
import type { CommonErrors, PageSearchResult, PageSummary, SearchOptions, SpaceContentOptions } from './types.js';

export class SearchOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private baseUrl: string,
  ) {}

  searchContent(
    cql: string,
    options: SearchOptions = {},
  ): Effect.Effect<Array<PageSummary>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      validateCQL(cql),
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
                const result = Schema.decodeUnknownSync(SearchResponseSchema)(data);
                return result.results.map(
                  (searchResult): PageSummary => ({
                    id: searchResult.content.id,
                    title: searchResult.content.title,
                    version: {
                      number: searchResult.content.version?.number || 0,
                      when: searchResult.content.version?.when || searchResult.lastModified || new Date().toISOString(),
                      by: searchResult.content.version?.by,
                    },
                    webUrl: searchResult.content._links.webui,
                    spaceKey: searchResult.content.space?.key,
                  }),
                );
              },
              catch: (error) => new ParseError('Failed to parse search response', 'searchResults', String(data), error),
            }),
          ),
          Effect.tap((results) => this.logger.debug('Content search completed', { cql, count: results.length })),
        );
      }),
    );
  }

  getRecentlyUpdatedPages(
    spaceKey: string,
    limit: number = 10,
  ): Effect.Effect<PageSummary[], ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      validateSpaceKey(spaceKey),
      Effect.flatMap(() => {
        const cql = `space="${spaceKey}" and type=page order by lastmodified desc`;
        return this.searchContent(cql, { limit });
      }),
    );
  }

  getPagesSince(
    spaceKey: string,
    sinceDate: Date,
  ): Stream.Stream<string, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(validateSpaceKey(spaceKey)),
      Stream.flatMap(() => {
        const formattedDate = sinceDate.toISOString().replace('T', ' ').substring(0, 16);
        const cql = `space="${spaceKey}" and type=page and lastmodified > "${formattedDate}" order by lastmodified desc`;

        return Stream.paginateEffect(0, (start: number) =>
          pipe(
            this.searchContent(cql, { start, limit: 100 }),
            Effect.map(
              (results) =>
                [
                  results.map((r) => r.id),
                  results.length < 100 ? Option.none<number>() : Option.some(start + 100),
                ] as const,
            ),
          ),
        );
      }),
      Stream.flatMap((ids) => Stream.fromIterable(ids)),
    );
  }

  getSpacePagesLightweight(
    spaceKey: string,
    getSpaceContent: (
      spaceKey: string,
      options?: SpaceContentOptions,
    ) => Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError>,
  ): Stream.Stream<PageSummary, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(validateSpaceKey(spaceKey)),
      Stream.flatMap(() =>
        Stream.paginateEffect(0, (start: number) =>
          pipe(
            getSpaceContent(spaceKey, {
              start,
              limit: 100,
              expand: ['version', 'space'],
            }),
            Effect.map(
              (result) =>
                [
                  result.values.map(
                    (page: Page): PageSummary => ({
                      id: page.id,
                      title: page.title,
                      version: page.version,
                      webUrl: page._links.webui,
                      spaceKey: page.space.key,
                    }),
                  ),
                  result.isLast ? Option.none<number>() : Option.some(start + 100),
                ] as const,
            ),
          ),
        ),
      ),
      Stream.flatMap((summaries) => Stream.fromIterable(summaries)),
      Stream.rechunk(50),
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
