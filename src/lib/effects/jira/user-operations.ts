/**
 * Jira User Operations Module
 * Contains all user-related operations extracted from jira-client-service.ts
 */

import { Duration, Effect, Option, pipe, Schedule, Schema } from 'effect';
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
import { type JiraUser, UserSchema } from './schemas.js';

// Re-export JiraUser type for backward compatibility
export type { JiraUser };

// ============= User Operations Interface =============
export interface UserOperations {
  getCurrentUser(): Effect.Effect<
    JiraUser,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  >;

  getUserByEmail(
    email: string,
  ): Effect.Effect<
    Option.Option<JiraUser>,
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  >;

  getUserActiveProjects(
    userEmail: string,
  ): Effect.Effect<
    string[],
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
    | ValidationError
  >;
}

// ============= User Operations Implementation =============
export class UserOperationsImpl implements UserOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private searchIssues: (
      jql: string,
      options?: SearchOptions,
    ) => Effect.Effect<
      IssueSearchResult,
      | ValidationError
      | NetworkError
      | AuthenticationError
      | ParseError
      | TimeoutError
      | RateLimitError
      | ConfigError
      | NotFoundError
    >,
  ) {}

  getCurrentUser(): Effect.Effect<
    JiraUser,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/myself`;

        return pipe(
          this.logger.debug('Fetching current user'),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(UserSchema)(data),
              catch: (error) => new ParseError('Failed to parse user response', 'user', String(data), error),
            }),
          ),
          Effect.tap((user) => this.logger.debug('Current user fetched successfully', { accountId: user.accountId })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      JiraUser,
      NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError,
      never
    >;
  }

  getUserByEmail(
    email: string,
  ): Effect.Effect<
    Option.Option<JiraUser>,
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
      this.validateEmail(email),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;

        return pipe(
          this.logger.debug('Searching user by email', { email }),
          Effect.flatMap(() => this.http.get<unknown[]>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                if (!Array.isArray(data) || data.length === 0) {
                  return Option.none();
                }
                const user = Schema.decodeUnknownSync(UserSchema)(data[0]);
                return Option.some(user);
              },
              catch: (error) =>
                new ParseError('Failed to parse user search response', 'userSearch', String(data), error),
            }),
          ),
          Effect.tap((userOption) =>
            this.logger.debug('User search completed', {
              email,
              found: Option.isSome(userOption),
            }),
          ),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Option.Option<JiraUser>,
      | ValidationError
      | NetworkError
      | AuthenticationError
      | ParseError
      | TimeoutError
      | RateLimitError
      | ConfigError
      | NotFoundError,
      never
    >;
  }

  getUserActiveProjects(
    userEmail: string,
  ): Effect.Effect<
    string[],
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
    | ValidationError
  > {
    return pipe(
      this.validateEmail(userEmail),
      Effect.flatMap(() => {
        const jql = `assignee = "${userEmail}" AND updated >= -30d ORDER BY updated DESC`;

        return pipe(
          this.searchIssues(jql, { maxResults: 100 }),
          Effect.map((result) => {
            const projectKeys = new Set<string>();
            result.values.forEach((issue) => {
              const projectKey = issue.key.split('-')[0];
              projectKeys.add(projectKey);
            });
            return Array.from(projectKeys);
          }),
        );
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

  private validateEmail(email: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!email || !email.includes('@')) {
        throw new ValidationError('Invalid email format', 'email', email);
      }
    });
  }
}
