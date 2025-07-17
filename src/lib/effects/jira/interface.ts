/**
 * Jira Client Service Interface
 * Defines the contract for all Jira operations
 */

import { Context, type Effect, type Option, type Stream } from 'effect';
import type {
  AuthenticationError,
  ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.js';
import type {
  Board,
  BoardSearchResult,
  Issue,
  IssueSearchResult,
  JiraUser,
  Project,
  SearchOptions,
  Sprint,
} from './types.js';

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
