/**
 * Jira Board Operations Module
 * Contains all board-related operations extracted from jira-client-service.ts
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
import type { IssueSearchResult, SearchOptions } from './issue-operations.js';
import { type Board, BoardsResponseSchema, IssueSchema } from './schemas.js';
import type { UserOperations } from './user-operations.js';

// Re-export Board type for backward compatibility
export type { Board };

export interface PaginatedResult<T> {
  values: T[];
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
}

export interface BoardSearchResult extends PaginatedResult<Board> {}

// ============= Board Operations Interface =============
export interface BoardOperations {
  getBoards(options?: {
    projectKeyOrId?: string;
    type?: 'scrum' | 'kanban';
  }): Effect.Effect<
    BoardSearchResult,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  >;

  getBoardsForProject(
    projectKey: string,
  ): Effect.Effect<
    Board[],
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  >;

  getUserBoards(
    userEmail: string,
  ): Effect.Effect<
    Board[],
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  >;

  getBoardConfiguration(
    boardId: number,
  ): Effect.Effect<
    { columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> },
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  getBoardIssues(
    boardId: number,
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
}

// ============= Board Operations Implementation =============
export class BoardOperationsImpl implements BoardOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private userOperations: UserOperations,
  ) {}

  getBoards(
    options: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' } = {},
  ): Effect.Effect<
    BoardSearchResult,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const params = new URLSearchParams();

        if (options.projectKeyOrId) {
          params.append('projectKeyOrId', options.projectKeyOrId);
        }
        if (options.type) {
          params.append('type', options.type);
        }

        const url = `${config.jiraUrl}/rest/agile/1.0/board${params.toString() ? `?${params}` : ''}`;

        return pipe(
          this.logger.debug('Fetching boards', { options }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = Schema.decodeUnknownSync(BoardsResponseSchema)(data);
                return {
                  values: result.values,
                  startAt: result.startAt,
                  maxResults: result.maxResults,
                  total: result.total,
                  isLast: result.startAt + result.values.length >= result.total,
                };
              },
              catch: (error) => new ParseError('Failed to parse boards response', 'boards', String(data), error),
            }),
          ),
          Effect.tap((result) => this.logger.debug('Boards fetched successfully', { total: result.total })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      BoardSearchResult,
      NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError,
      never
    >;
  }

  getBoardsForProject(
    projectKey: string,
  ): Effect.Effect<
    Board[],
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
      this.validateProjectKey(projectKey),
      Effect.flatMap(() => this.getBoards({ projectKeyOrId: projectKey })),
      Effect.map((result) => result.values),
    );
  }

  getUserBoards(
    userEmail: string,
  ): Effect.Effect<
    Board[],
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
      Effect.flatMap(() => this.userOperations.getUserActiveProjects(userEmail)),
      Effect.flatMap((activeProjects) =>
        Effect.forEach(activeProjects, (projectKey) =>
          pipe(
            this.getBoardsForProject(projectKey),
            Effect.catchAll(() => Effect.succeed([] as Board[])),
          ),
        ),
      ),
      Effect.map((boardArrays) => {
        // Flatten and deduplicate
        const allBoards = boardArrays.flat();
        const uniqueBoards = allBoards.filter(
          (board, index, array) => array.findIndex((b) => b.id === board.id) === index,
        );
        return uniqueBoards.sort((a, b) => a.name.localeCompare(b.name));
      }),
    );
  }

  getBoardConfiguration(
    boardId: number,
  ): Effect.Effect<
    { columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> },
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
        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/configuration`;

        return pipe(
          this.logger.debug('Fetching board configuration', { boardId }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const parsedData = data as { columnConfig?: { columns?: unknown[] } };
                return {
                  columns: parsedData.columnConfig?.columns || [],
                };
              },
              catch: (error) =>
                new ParseError('Failed to parse board configuration response', 'boardConfig', String(data), error),
            }),
          ),
          Effect.tap(() => this.logger.debug('Board configuration fetched successfully', { boardId })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      { columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> },
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

  getBoardIssues(
    boardId: number,
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
      this.validateBoardId(boardId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const params = new URLSearchParams({
          startAt: (options.startAt || 0).toString(),
          maxResults: (options.maxResults || 50).toString(),
        });

        if (options.fields) {
          params.append('fields', options.fields.join(','));
        }

        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/issue?${params}`;

        return pipe(
          this.logger.debug('Fetching board issues', { boardId, options }),
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
                new ParseError('Failed to parse board issues response', 'boardIssues', String(data), error),
            }),
          ),
          Effect.tap((result) =>
            this.logger.debug('Board issues fetched successfully', { boardId, count: result.values.length }),
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

  private validateProjectKey(projectKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!projectKey || projectKey.length === 0) {
        throw new ValidationError('Project key cannot be empty', 'projectKey', projectKey);
      }
      if (!/^[A-Z][A-Z0-9]*$/.test(projectKey)) {
        throw new ValidationError('Invalid project key format', 'projectKey', projectKey);
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

  private validateBoardId(boardId: number): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!boardId || boardId <= 0) {
        throw new ValidationError('Board ID must be a positive number', 'boardId', boardId);
      }
    });
  }
}
