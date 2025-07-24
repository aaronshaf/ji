/**
 * Jira Sprint Operations Module
 * Contains all sprint-related operations extracted from jira-client-service.ts
 */

import { Duration, Effect, pipe, Schedule, Schema } from 'effect';
import {
  AuthenticationError,
  type ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.js';
import type { ConfigService, HttpClientService, LoggerService } from '../layers.js';
import type { BoardOperations } from './board-operations.js';
import type { IssueSearchResult, SearchOptions } from './issue-operations.js';
import { IssueSchema, type Sprint, SprintsResponseSchema } from './schemas.js';

// Re-export Sprint type for backward compatibility
export type { Sprint };

// ============= Sprint Operations Interface =============
export interface SprintOperations {
  getActiveSprints(
    boardId: number,
  ): Effect.Effect<
    Sprint[],
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  getAllSprints(
    boardId: number,
  ): Effect.Effect<
    Sprint[],
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  getSprintIssues(
    sprintId: number,
    options?: SearchOptions,
  ): Effect.Effect<
    IssueSearchResult,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  getUserActiveSprints(
    userEmail: string,
  ): Effect.Effect<
    Sprint[],
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  >;
}

// ============= Sprint Operations Implementation =============
export class SprintOperationsImpl implements SprintOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private boardOperations: BoardOperations,
  ) {}

  getActiveSprints(
    boardId: number,
  ): Effect.Effect<
    Sprint[],
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
      this.validateBoardId(boardId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;

        return pipe(
          this.logger.debug('Fetching active sprints', { boardId }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = Schema.decodeUnknownSync(SprintsResponseSchema)(data);
                return result.values;
              },
              catch: (error) => new ParseError('Failed to parse sprints response', 'sprints', String(data), error),
            }),
          ),
          Effect.tap((sprints) =>
            this.logger.debug('Active sprints fetched successfully', { boardId, count: sprints.length }),
          ),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Sprint[],
      | ValidationError
      | NotFoundError
      | NetworkError
      | AuthenticationError
      | ParseError
      | TimeoutError
      | RateLimitError
      | ConfigError,
      never
    >;
  }

  getAllSprints(
    boardId: number,
  ): Effect.Effect<
    Sprint[],
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
      this.validateBoardId(boardId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint`;

        return pipe(
          this.logger.debug('Fetching all sprints', { boardId }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = Schema.decodeUnknownSync(SprintsResponseSchema)(data);
                return result.values;
              },
              catch: (error) => new ParseError('Failed to parse sprints response', 'sprints', String(data), error),
            }),
          ),
          Effect.tap((sprints) =>
            this.logger.debug('All sprints fetched successfully', { boardId, count: sprints.length }),
          ),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Sprint[],
      | ValidationError
      | NotFoundError
      | NetworkError
      | AuthenticationError
      | ParseError
      | TimeoutError
      | RateLimitError
      | ConfigError,
      never
    >;
  }

  getSprintIssues(
    sprintId: number,
    options: SearchOptions = {},
  ): Effect.Effect<
    IssueSearchResult,
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
      this.validateSprintId(sprintId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const params = new URLSearchParams({
          startAt: (options.startAt || 0).toString(),
          maxResults: (options.maxResults || 50).toString(),
        });

        if (options.fields) {
          params.append('fields', options.fields.join(','));
        }

        const url = `${config.jiraUrl}/rest/agile/1.0/sprint/${sprintId}/issue?${params}`;

        return pipe(
          this.logger.debug('Fetching sprint issues', { sprintId, options }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const parsedData = data as {
                  issues?: unknown[];
                  startAt?: number;
                  maxResults?: number;
                  total?: number;
                };
                const issues = (parsedData.issues || []).map((issue: unknown) =>
                  Schema.decodeUnknownSync(IssueSchema)(issue),
                );
                return {
                  values: issues,
                  startAt: parsedData.startAt || 0,
                  maxResults: parsedData.maxResults || issues.length,
                  total: parsedData.total || issues.length,
                  isLast: true, // Simple implementation
                };
              },
              catch: (error) =>
                new ParseError('Failed to parse sprint issues response', 'sprintIssues', String(data), error),
            }),
          ),
          Effect.tap((result) =>
            this.logger.debug('Sprint issues fetched successfully', { sprintId, count: result.values.length }),
          ),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      IssueSearchResult,
      | ValidationError
      | NotFoundError
      | NetworkError
      | AuthenticationError
      | ParseError
      | TimeoutError
      | RateLimitError
      | ConfigError,
      never
    >;
  }

  getUserActiveSprints(
    userEmail: string,
  ): Effect.Effect<
    Sprint[],
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  > {
    return pipe(
      this.validateEmail(userEmail),
      Effect.flatMap(() => this.boardOperations.getUserBoards(userEmail)),
      Effect.flatMap((boards) =>
        Effect.forEach(boards, (board) =>
          pipe(
            this.getActiveSprints(board.id),
            Effect.catchAll(() => Effect.succeed([] as Sprint[])),
          ),
        ),
      ),
      Effect.map((sprintArrays) => {
        // Flatten and deduplicate
        const allSprints = sprintArrays.flat();
        const uniqueSprints = Array.from(new Map(allSprints.map((s) => [s.id, s])).values());
        return uniqueSprints;
      }),
    );
  }

  // ============= Private Helper Methods =============
  private getAuthHeaders(config: { email: string; apiToken: string }): Record<string, string> {
    const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private mapHttpError = (
    error: unknown,
  ): NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError => {
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
    return pipe(Schedule.exponential(Duration.millis(100)), Schedule.intersect(Schedule.recurs(3)), Schedule.jittered);
  }

  private validateBoardId(boardId: number): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!boardId || boardId <= 0) {
        throw new ValidationError('Board ID must be a positive number', 'boardId', boardId);
      }
    });
  }

  private validateSprintId(sprintId: number): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!sprintId || sprintId <= 0) {
        throw new ValidationError('Sprint ID must be a positive number', 'sprintId', sprintId);
      }
    });
  }

  private validateEmail(email: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!email || !email.includes('@')) {
        throw new ValidationError('Invalid email format', 'email', email);
      }
    });
  }
}
