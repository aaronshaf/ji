/**
 * Confluence Space Operations
 * All space-related operations
 */

import { Effect, pipe, Schema } from 'effect';
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
import { createRetrySchedule, getAuthHeaders, validateSpaceKey } from './helpers.js';
import { type Space, SpaceListResponseSchema, SpaceSchema } from './schemas.js';
import type {
  CommonErrors,
  PageSearchResult,
  PageSummary,
  SearchOptions,
  SpaceContentOptions,
  SpaceSearchResult,
} from './types.js';

export class SpaceOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private baseUrl: string,
  ) {}

  getSpace(
    spaceKey: string,
  ): Effect.Effect<
    Space,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  > {
    return pipe(
      validateSpaceKey(spaceKey),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/space/${spaceKey}?expand=description.plain,homepage,permissions`;

        return pipe(
          this.logger.debug('Fetching space', { spaceKey }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(SpaceSchema)(data),
              catch: (error) => new ParseError('Failed to parse space response', 'space', String(data), error),
            }),
          ),
          Effect.tap(() => this.logger.debug('Space fetched successfully', { spaceKey })),
        );
      }),
    );
  }

  getAllSpaces(
    options: SearchOptions = {},
  ): Effect.Effect<
    SpaceSearchResult,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | NotFoundError | ConfigError
  > {
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
            const result = Schema.decodeUnknownSync(SpaceListResponseSchema)(data);
            return {
              values: result.results,
              start: result.start,
              limit: result.limit,
              size: result.size,
              isLast: result.results.length < result.limit,
            } as SpaceSearchResult;
          },
          catch: (error) => new ParseError('Failed to parse spaces response', 'spaces', String(data), error),
        }),
      ),
      Effect.tap((result) => this.logger.debug('Spaces fetched successfully', { count: result.values.length })),
    );
  }

  getSpacePermissions(
    spaceKey: string,
  ): Effect.Effect<
    ReadonlyArray<{ operation: string; targetType: string }> | Array<{ operation: string; targetType: string }>,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  > {
    return pipe(
      this.getSpace(spaceKey),
      Effect.map((space) => space.permissions || []),
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
      }),
    );
  }

  getSpaceAnalytics(
    spaceKey: string,
    getSpaceContent: (
      spaceKey: string,
      options?: SpaceContentOptions,
    ) => Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError>,
    getRecentlyUpdatedPages: (
      spaceKey: string,
      limit?: number,
    ) => Effect.Effect<PageSummary[], ValidationError | CommonErrors | NotFoundError>,
  ): Effect.Effect<
    { pageCount: number; recentActivity: number; lastModified?: Date },
    ValidationError | CommonErrors | NotFoundError
  > {
    return pipe(
      validateSpaceKey(spaceKey),
      Effect.flatMap(() =>
        Effect.all({
          totalPages: pipe(
            getSpaceContent(spaceKey, { limit: 0 }),
            Effect.map((result) => result.size),
          ),
          recentPages: pipe(
            getRecentlyUpdatedPages(spaceKey, 10),
            Effect.map((pages) => pages.length),
          ),
          lastModified: pipe(
            getRecentlyUpdatedPages(spaceKey, 1),
            Effect.map((pages) => (pages.length > 0 ? new Date(pages[0].version.when) : undefined)),
          ),
        }),
      ),
      Effect.map(({ totalPages, recentPages, lastModified }) => ({
        pageCount: totalPages,
        recentActivity: recentPages,
        lastModified,
      })),
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
