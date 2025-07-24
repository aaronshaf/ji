/**
 * Effect-based Jira Client Service
 * Replaces the traditional JiraClient with a fully Effect-based implementation
 * Handles all Jira API interactions with proper error handling and retry strategies
 */

import { Context, Effect, Layer, type Option, pipe, type Stream } from 'effect';
import type {
  AuthenticationError,
  ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import { BatchOperationsImpl } from './jira/batch-operations.js';
import { BoardOperationsImpl, type BoardSearchResult } from './jira/board-operations.js';
import {
  type Issue,
  IssueOperationsImpl,
  type IssueSearchResult,
  type SearchOptions,
} from './jira/issue-operations.js';
import { ProjectOperationsImpl } from './jira/project-operations.js';
import type { Board, JiraUser, Project, Sprint } from './jira/schemas.js';
import { SprintOperationsImpl } from './jira/sprint-operations.js';
import { UserOperationsImpl } from './jira/user-operations.js';
import {
  type ConfigService,
  ConfigServiceTag,
  type HttpClientService,
  HttpClientServiceTag,
  type LoggerService,
  LoggerServiceTag,
} from './layers.js';

export type { BoardSearchResult } from './jira/board-operations.js';
// Re-export types from operation modules
export type { Issue, IssueSearchResult, SearchOptions } from './jira/issue-operations.js';
export type { Board, JiraUser, Project, Sprint } from './jira/schemas.js';

export interface PaginatedResult<T> {
  values: T[];
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
}
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
  private userOps: UserOperationsImpl;
  private boardOps: BoardOperationsImpl;
  private sprintOps: SprintOperationsImpl;
  private projectOps: ProjectOperationsImpl;
  private batchOps: BatchOperationsImpl;

  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
  ) {
    this.issueOps = new IssueOperationsImpl(http, config, logger);
    this.userOps = new UserOperationsImpl(http, config, logger, this.issueOps.searchIssues.bind(this.issueOps));
    this.boardOps = new BoardOperationsImpl(http, config, logger, this.userOps);
    this.sprintOps = new SprintOperationsImpl(http, config, logger, this.boardOps);
    this.projectOps = new ProjectOperationsImpl(http, config, logger);
    this.batchOps = new BatchOperationsImpl(this.issueOps, logger);
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

  // ============= User Operations (delegated to UserOperationsImpl) =============
  getCurrentUser(): Effect.Effect<
    JiraUser,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return this.userOps.getCurrentUser();
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
    return this.userOps.getUserByEmail(email);
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
    return this.userOps.getUserActiveProjects(userEmail);
  }

  // ============= Board Operations (delegated to BoardOperationsImpl) =============
  getBoards(
    options: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' } = {},
  ): Effect.Effect<
    BoardSearchResult,
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return this.boardOps.getBoards(options);
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
    return this.boardOps.getBoardsForProject(projectKey);
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
    return this.boardOps.getUserBoards(userEmail);
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
    return this.boardOps.getBoardConfiguration(boardId);
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
    return this.boardOps.getBoardIssues(boardId, options);
  }

  // ============= Sprint Operations (delegated to SprintOperationsImpl) =============
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
    return this.sprintOps.getActiveSprints(boardId);
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
    return this.sprintOps.getAllSprints(boardId);
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
    return this.sprintOps.getSprintIssues(sprintId, options);
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
    return this.sprintOps.getUserActiveSprints(userEmail);
  }

  // ============= Project Operations (delegated to ProjectOperationsImpl) =============
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
    return this.projectOps.getProject(projectKey);
  }

  getAllProjects(): Effect.Effect<
    Project[],
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return this.projectOps.getAllProjects();
  }

  // ============= Batch Operations (delegated to BatchOperationsImpl) =============
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
    return this.batchOps.batchGetIssues(issueKeys);
  }

  batchAssignIssues(
    assignments: Array<{ issueKey: string; accountId: string }>,
  ): Effect.Effect<
    Array<{ issueKey: string; success: boolean; error?: string }>,
    ValidationError | NetworkError | AuthenticationError
  > {
    return this.batchOps.batchAssignIssues(assignments);
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
