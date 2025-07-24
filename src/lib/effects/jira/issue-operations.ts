/**
 * Jira Issue Operations Module
 * Contains all issue-related operations extracted from jira-client-service.ts
 */

import { Duration, Effect, Option, pipe, Schedule, Schema, Stream } from 'effect';
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
import { type Issue, IssueSchema, SearchResultSchema } from './schemas.js';

// Re-export Issue type for backward compatibility
export type { Issue };

export interface SearchOptions {
  startAt?: number;
  maxResults?: number;
  fields?: string[];
  expand?: string[];
}

export interface PaginatedResult<T> {
  values: T[];
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
}

export interface IssueSearchResult extends PaginatedResult<Issue> {}

// ============= Configuration =============
export const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'reporter',
  'priority',
  'project',
  'created',
  'updated',
  // Common sprint custom fields
  'customfield_10020',
  'customfield_10021',
  'customfield_10016',
  'customfield_10018',
  'customfield_10019',
];

// ============= Issue Operations Mixin =============
export interface IssueOperations {
  getIssue(
    issueKey: string,
  ): Effect.Effect<
    Issue,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  searchIssues(
    jql: string,
    options?: SearchOptions,
  ): Effect.Effect<
    IssueSearchResult,
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  >;

  getAllProjectIssues(
    projectKey: string,
    jql?: string,
  ): Stream.Stream<
    Issue,
    | ValidationError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
    | NotFoundError
  >;

  assignIssue(
    issueKey: string,
    accountId: string,
  ): Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  >;

  updateIssue(
    issueKey: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  >;

  createIssue(
    projectKey: string,
    issueType: string,
    summary: string,
    description?: string,
  ): Effect.Effect<
    Issue,
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

// ============= Issue Operations Implementation =============
export class IssueOperationsImpl {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
  ) {}

  getIssue(
    issueKey: string,
  ): Effect.Effect<
    Issue,
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
      this.validateIssueKey(issueKey),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const params = new URLSearchParams({
          fields: ISSUE_FIELDS.join(','),
        });
        const url = `${config.jiraUrl}/rest/api/3/issue/${issueKey}?${params}`;

        return pipe(
          this.logger.debug('Fetching issue', { issueKey }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(IssueSchema)(data),
              catch: (error) => new ParseError('Failed to parse issue response', 'issue', String(data), error),
            }),
          ),
          Effect.tap(() => this.logger.debug('Issue fetched successfully', { issueKey })),
          Effect.retry(this.createRetrySchedule()),
        ) as Effect.Effect<
          Issue,
          NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError,
          never
        >;
      }),
    );
  }

  searchIssues(
    jql: string,
    options: SearchOptions = {},
  ): Effect.Effect<
    IssueSearchResult,
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
      this.validateJQL(jql),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const params = new URLSearchParams({
          jql,
          startAt: (options.startAt || 0).toString(),
          maxResults: (options.maxResults || 50).toString(),
        });

        if (options.fields) {
          params.append('fields', options.fields.join(','));
        } else {
          params.append('fields', ISSUE_FIELDS.join(','));
        }

        if (options.expand) {
          params.append('expand', options.expand.join(','));
        }

        const url = `${config.jiraUrl}/rest/api/3/search?${params}`;

        return pipe(
          this.logger.debug('Searching issues', { jql, options }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = Schema.decodeUnknownSync(SearchResultSchema)(data);
                return {
                  values: result.issues,
                  startAt: result.startAt,
                  maxResults: result.maxResults,
                  total: result.total,
                  isLast: result.startAt + result.issues.length >= result.total,
                };
              },
              catch: (error) => new ParseError('Failed to parse search response', 'searchResult', String(data), error),
            }),
          ),
          Effect.tap((result) =>
            this.logger.debug('Issues searched successfully', { total: result.total, returned: result.values.length }),
          ),
          Effect.retry(this.createRetrySchedule()),
        ) as Effect.Effect<
          IssueSearchResult,
          NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError,
          never
        >;
      }),
    );
  }

  getAllProjectIssues(
    projectKey: string,
    jql?: string,
  ): Stream.Stream<
    Issue,
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
      Stream.fromEffect(this.validateProjectKey(projectKey)),
      Stream.flatMap(() => {
        const searchJql = jql || `project = ${projectKey} ORDER BY updated DESC`;

        return Stream.paginateEffect(0, (startAt: number) =>
          pipe(
            this.searchIssues(searchJql, { startAt, maxResults: 100 }),
            Effect.map(
              (result) => [result.values, result.isLast ? Option.none<number>() : Option.some(startAt + 100)] as const,
            ),
          ),
        );
      }),
      Stream.flatMap((issues) => Stream.fromIterable(issues)),
      Stream.rechunk(50),
    );
  }

  assignIssue(
    issueKey: string,
    accountId: string,
  ): Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  > {
    return pipe(
      Effect.all({
        _: this.validateIssueKey(issueKey),
        __: this.validateAccountId(accountId),
        config: this.config.getConfig,
      }),
      Effect.flatMap(({ config }) => {
        const url = `${config.jiraUrl}/rest/api/3/issue/${issueKey}/assignee`;
        const body = { accountId };

        return pipe(
          this.logger.debug('Assigning issue', { issueKey, accountId }),
          Effect.flatMap(() => this.http.put<void>(url, body, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.tap(() => this.logger.info('Issue assigned successfully', { issueKey, accountId })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      void,
      | ValidationError
      | NotFoundError
      | NetworkError
      | AuthenticationError
      | TimeoutError
      | RateLimitError
      | ConfigError,
      never
    >;
  }

  updateIssue(
    issueKey: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  > {
    return pipe(
      Effect.all({
        _: this.validateIssueKey(issueKey),
        config: this.config.getConfig,
      }),
      Effect.flatMap(({ config }) => {
        const url = `${config.jiraUrl}/rest/api/3/issue/${issueKey}`;
        const body = { fields };

        return pipe(
          this.logger.debug('Updating issue', { issueKey, fields: Object.keys(fields) }),
          Effect.flatMap(() => this.http.put<void>(url, body, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.tap(() => this.logger.info('Issue updated successfully', { issueKey })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      void,
      | ValidationError
      | NotFoundError
      | NetworkError
      | AuthenticationError
      | TimeoutError
      | RateLimitError
      | ConfigError,
      never
    >;
  }

  createIssue(
    projectKey: string,
    issueType: string,
    summary: string,
    description?: string,
  ): Effect.Effect<
    Issue,
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
      Effect.all({
        _: this.validateProjectKey(projectKey),
        __: this.validateNonEmpty(summary, 'summary'),
        config: this.config.getConfig,
      }),
      Effect.flatMap(({ config }) => {
        const url = `${config.jiraUrl}/rest/api/3/issue`;
        const body = {
          fields: {
            project: { key: projectKey },
            issuetype: { name: issueType },
            summary,
            ...(description && { description }),
          },
        };

        return pipe(
          this.logger.debug('Creating issue', { projectKey, issueType, summary }),
          Effect.flatMap(() => this.http.post<unknown>(url, body, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(IssueSchema)(data),
              catch: (error) => new ParseError('Failed to parse created issue response', 'issue', String(data), error),
            }),
          ),
          Effect.tap((issue) => this.logger.info('Issue created successfully', { issueKey: issue.key })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Issue,
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

  private validateIssueKey(issueKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
        throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123', 'issueKey', issueKey);
      }
    });
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

  private validateAccountId(accountId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!accountId || accountId.trim().length === 0) {
        throw new ValidationError('Account ID cannot be empty', 'accountId', accountId);
      }
    });
  }

  private validateJQL(jql: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!jql || jql.trim().length === 0) {
        throw new ValidationError('JQL query cannot be empty', 'jql', jql);
      }
      if (jql.length > 10000) {
        throw new ValidationError('JQL query too long', 'jql', jql);
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
}

// ============= Batch Operations =============
export const batchGetIssues =
  (issueOperations: Pick<IssueOperations, 'getIssue'>, logger: LoggerService) =>
  (
    issueKeys: string[],
  ): Stream.Stream<
    Issue,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  > => {
    return pipe(
      Stream.fromIterable(issueKeys),
      Stream.mapEffect((issueKey) =>
        pipe(
          issueOperations.getIssue(issueKey),
          Effect.catchAll((error) => {
            // Log the error but don't fail the entire stream
            return pipe(
              logger.warn('Failed to fetch issue in batch', { issueKey, error: error.message }),
              Effect.flatMap(() => Effect.fail(error)),
            );
          }),
        ),
      ),
      Stream.rechunk(10), // Process in chunks of 10
    );
  };

export const batchAssignIssues =
  (issueOperations: Pick<IssueOperations, 'assignIssue'>) =>
  (
    assignments: Array<{ issueKey: string; accountId: string }>,
  ): Effect.Effect<
    Array<{ issueKey: string; success: boolean; error?: string }>,
    ValidationError | NetworkError | AuthenticationError
  > => {
    return pipe(
      Effect.forEach(assignments, ({ issueKey, accountId }) =>
        pipe(
          issueOperations.assignIssue(issueKey, accountId),
          Effect.map(() => ({ issueKey, success: true as const })),
          Effect.catchAll((error) =>
            Effect.succeed({
              issueKey,
              success: false as const,
              error: error.message,
            }),
          ),
        ),
      ),
    );
  };
