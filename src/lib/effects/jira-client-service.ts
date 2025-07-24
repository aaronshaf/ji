/**
 * Effect-based Jira Client Service
 * Replaces the traditional JiraClient with a fully Effect-based implementation
 * Handles all Jira API interactions with proper error handling and retry strategies
 */

import { Context, Duration, Effect, Layer, Option, pipe, Schedule, Schema, type Stream } from 'effect';
import {
  AuthenticationError,
  type ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import {
  batchAssignIssues,
  batchGetIssues,
  type Issue,
  IssueOperationsImpl,
  type IssueSearchResult,
  type SearchOptions,
} from './jira/issue-operations.js';
import {
  type Board,
  BoardsResponseSchema,
  IssueSchema,
  type JiraUser,
  type Project,
  ProjectSchema,
  type Sprint,
  SprintsResponseSchema,
  UserSchema,
} from './jira/schemas.js';
import {
  type ConfigService,
  ConfigServiceTag,
  type HttpClientService,
  HttpClientServiceTag,
  type LoggerService,
  LoggerServiceTag,
} from './layers.js';

// Re-export Issue type and interfaces from issue-operations
export type { Issue, IssueSearchResult, SearchOptions } from './jira/issue-operations.js';
export type { Board, JiraUser, Project, Sprint } from './jira/schemas.js';

export interface PaginatedResult<T> {
  values: T[];
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
}
export interface BoardSearchResult extends PaginatedResult<Board> {}
export interface SprintSearchResult extends PaginatedResult<Sprint> {}

// ============= Jira Client Service Interface =============
export interface JiraClientService {
  // Issue operations
  readonly getIssue: (
    issueKey: string,
  ) => Effect.Effect<
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
  readonly searchIssues: (
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
  >;
  readonly getAllProjectIssues: (
    projectKey: string,
    jql?: string,
  ) => Stream.Stream<
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
  readonly assignIssue: (
    issueKey: string,
    accountId: string,
  ) => Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  >;
  readonly updateIssue: (
    issueKey: string,
    fields: Record<string, unknown>,
  ) => Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  >;
  readonly createIssue: (
    projectKey: string,
    issueType: string,
    summary: string,
    description?: string,
  ) => Effect.Effect<
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

  // User operations
  readonly getCurrentUser: () => Effect.Effect<
    JiraUser,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  >;
  readonly getUserByEmail: (
    email: string,
  ) => Effect.Effect<
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
  readonly getUserActiveProjects: (
    userEmail: string,
  ) => Effect.Effect<
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

  // Board operations
  readonly getBoards: (options?: {
    projectKeyOrId?: string;
    type?: 'scrum' | 'kanban';
  }) => Effect.Effect<
    BoardSearchResult,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  >;
  readonly getBoardsForProject: (
    projectKey: string,
  ) => Effect.Effect<
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
  readonly getUserBoards: (
    userEmail: string,
  ) => Effect.Effect<
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
  readonly getBoardConfiguration: (
    boardId: number,
  ) => Effect.Effect<
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
  readonly getBoardIssues: (
    boardId: number,
    options?: SearchOptions,
  ) => Effect.Effect<
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

  // Sprint operations
  readonly getActiveSprints: (
    boardId: number,
  ) => Effect.Effect<
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
  readonly getAllSprints: (
    boardId: number,
  ) => Effect.Effect<
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
  readonly getSprintIssues: (
    sprintId: number,
    options?: SearchOptions,
  ) => Effect.Effect<
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
  readonly getUserActiveSprints: (
    userEmail: string,
  ) => Effect.Effect<
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

  // Project operations
  readonly getProject: (
    projectKey: string,
  ) => Effect.Effect<
    Project,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;
  readonly getAllProjects: () => Effect.Effect<
    Project[],
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  >;

  // Batch operations
  readonly batchGetIssues: (
    issueKeys: string[],
  ) => Stream.Stream<
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
  readonly batchAssignIssues: (
    assignments: Array<{ issueKey: string; accountId: string }>,
  ) => Effect.Effect<
    Array<{ issueKey: string; success: boolean; error?: string }>,
    ValidationError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  >;
}

export class JiraClientServiceTag extends Context.Tag('JiraClientService')<JiraClientServiceTag, JiraClientService>() {}

// ============= Jira Client Service Implementation =============
class JiraClientServiceImpl implements JiraClientService {
  private issueOps: IssueOperationsImpl;

  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
  ) {
    this.issueOps = new IssueOperationsImpl(http, config, logger);
  }

  // ============= Issue Operations (delegated to IssueOperationsImpl) =============
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
    return this.issueOps.getIssue(issueKey);
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
    return this.issueOps.searchIssues(jql, options);
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
    return this.issueOps.getAllProjectIssues(projectKey, jql);
  }

  assignIssue(
    issueKey: string,
    accountId: string,
  ): Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  > {
    return this.issueOps.assignIssue(issueKey, accountId);
  }

  updateIssue(
    issueKey: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<
    void,
    ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  > {
    return this.issueOps.updateIssue(issueKey, fields);
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
    return this.issueOps.createIssue(projectKey, issueType, summary, description);
  }

  // ============= User Operations =============
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

  // ============= Board Operations =============
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
      Effect.flatMap(() => this.getUserActiveProjects(userEmail)),
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

  // ============= Sprint Operations =============
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
      Effect.flatMap(() => this.getUserBoards(userEmail)),
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

  // ============= Project Operations =============
  getProject(
    projectKey: string,
  ): Effect.Effect<
    Project,
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
      this.validateProjectKey(projectKey),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/project/${projectKey}`;

        return pipe(
          this.logger.debug('Fetching project', { projectKey }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(ProjectSchema)(data),
              catch: (error) => new ParseError('Failed to parse project response', 'project', String(data), error),
            }),
          ),
          Effect.tap(() => this.logger.debug('Project fetched successfully', { projectKey })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Project,
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

  getAllProjects(): Effect.Effect<
    Project[],
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/project`;

        return pipe(
          this.logger.debug('Fetching all projects'),
          Effect.flatMap(() => this.http.get<unknown[]>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                if (!Array.isArray(data)) {
                  throw new Error('Projects response is not an array');
                }
                return data.map((project) => Schema.decodeUnknownSync(ProjectSchema)(project));
              },
              catch: (error) => new ParseError('Failed to parse projects response', 'projects', String(data), error),
            }),
          ),
          Effect.tap((projects) => this.logger.debug('All projects fetched successfully', { count: projects.length })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Project[],
      NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError,
      never
    >;
  }

  // ============= Batch Operations =============
  batchGetIssues(
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
  > {
    return batchGetIssues(this.issueOps, this.logger)(issueKeys);
  }

  batchAssignIssues(
    assignments: Array<{ issueKey: string; accountId: string }>,
  ): Effect.Effect<
    Array<{ issueKey: string; success: boolean; error?: string }>,
    ValidationError | NetworkError | AuthenticationError
  > {
    return batchAssignIssues(this.issueOps)(assignments);
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

  private validateAccountId(accountId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!accountId || accountId.trim().length === 0) {
        throw new ValidationError('Account ID cannot be empty', 'accountId', accountId);
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

  private validateSprintId(sprintId: number): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!sprintId || sprintId <= 0) {
        throw new ValidationError('Sprint ID must be a positive number', 'sprintId', sprintId);
      }
    });
  }
}

// ============= Service Layer =============
export const JiraClientServiceLive = Layer.effect(
  JiraClientServiceTag,
  pipe(
    Effect.all({
      http: HttpClientServiceTag,
      config: ConfigServiceTag,
      logger: LoggerServiceTag,
    }),
    Effect.map(({ http, config, logger }) => new JiraClientServiceImpl(http, config, logger)),
  ),
);

// ============= Helper Functions =============
// Use JiraClientServiceLive directly with Effect.provide() when needed
