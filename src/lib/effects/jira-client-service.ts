/**
 * Effect-based Jira Client Service
 * Replaces the traditional JiraClient with a fully Effect-based implementation
 * Handles all Jira API interactions with proper error handling and retry strategies
 */

import { Effect, Layer, Context, pipe, Schedule, Duration, Option, Stream } from 'effect';
import { z } from 'zod';
import { HttpClientService, HttpClientServiceTag, ConfigService, ConfigServiceTag, LoggerService, LoggerServiceTag } from './layers.js';
import { 
  NetworkError, 
  AuthenticationError, 
  NotFoundError, 
  ValidationError,
  RateLimitError,
  TimeoutError,
  ParseError,
  ConfigError
} from './errors.js';

// ============= Jira API Schemas =============
const IssueSchema = z.object({
  key: z.string(),
  self: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.any().nullable(),
    status: z.object({
      name: z.string(),
    }),
    assignee: z.object({
      displayName: z.string(),
      emailAddress: z.string().email().optional(),
      accountId: z.string(),
    }).nullable(),
    reporter: z.object({
      displayName: z.string(),
      emailAddress: z.string().email().optional(),
      accountId: z.string(),
    }),
    priority: z.object({
      name: z.string(),
    }).nullable(),
    project: z.object({
      key: z.string(),
      name: z.string(),
    }).optional(),
    created: z.string(),
    updated: z.string(),
    // Common sprint custom fields
    customfield_10020: z.any().optional(),
    customfield_10021: z.any().optional(),
    customfield_10016: z.any().optional(),
    customfield_10018: z.any().optional(),
    customfield_10019: z.any().optional(),
  }).catchall(z.any()),
});

const SearchResultSchema = z.object({
  issues: z.array(IssueSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

const BoardSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.enum(['scrum', 'kanban']),
  location: z.object({
    projectKey: z.string().optional(),
    projectName: z.string().optional(),
    projectTypeKey: z.string().optional(),
    avatarURI: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().optional(),
  }).optional(),
  self: z.string(),
});

const BoardsResponseSchema = z.object({
  values: z.array(BoardSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

const SprintSchema = z.object({
  id: z.number(),
  self: z.string(),
  state: z.enum(['active', 'closed', 'future']),
  name: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  completeDate: z.string().optional(),
  originBoardId: z.number(),
  goal: z.string().optional(),
});

const SprintsResponseSchema = z.object({
  values: z.array(SprintSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

const ProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  projectTypeKey: z.string(),
  simplified: z.boolean().optional(),
  style: z.string().optional(),
});

const UserSchema = z.object({
  accountId: z.string(),
  displayName: z.string(),
  emailAddress: z.string().email().optional(),
  active: z.boolean().optional(),
});

// ============= Exported Types =============
export type Issue = z.infer<typeof IssueSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Sprint = z.infer<typeof SprintSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type JiraUser = z.infer<typeof UserSchema>;

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
export interface BoardSearchResult extends PaginatedResult<Board> {}
export interface SprintSearchResult extends PaginatedResult<Sprint> {}

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


// ============= Jira Client Service Interface =============
export interface JiraClientService {
  // Issue operations
  readonly getIssue: (issueKey: string) => Effect.Effect<Issue, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly searchIssues: (jql: string, options?: SearchOptions) => Effect.Effect<IssueSearchResult, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly getAllProjectIssues: (projectKey: string, jql?: string) => Stream.Stream<Issue, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly assignIssue: (issueKey: string, accountId: string) => Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError>;
  readonly updateIssue: (issueKey: string, fields: Record<string, unknown>) => Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError>;
  readonly createIssue: (projectKey: string, issueType: string, summary: string, description?: string) => Effect.Effect<Issue, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  
  // User operations
  readonly getCurrentUser: () => Effect.Effect<JiraUser, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly getUserByEmail: (email: string) => Effect.Effect<Option.Option<JiraUser>, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly getUserActiveProjects: (userEmail: string) => Effect.Effect<string[], NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError | ValidationError>;
  
  // Board operations
  readonly getBoards: (options?: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' }) => Effect.Effect<BoardSearchResult, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly getBoardsForProject: (projectKey: string) => Effect.Effect<Board[], ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly getUserBoards: (userEmail: string) => Effect.Effect<Board[], ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  readonly getBoardConfiguration: (boardId: number) => Effect.Effect<{ columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> }, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly getBoardIssues: (boardId: number, options?: SearchOptions) => Effect.Effect<IssueSearchResult, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  
  // Sprint operations
  readonly getActiveSprints: (boardId: number) => Effect.Effect<Sprint[], ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly getAllSprints: (boardId: number) => Effect.Effect<Sprint[], ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly getSprintIssues: (sprintId: number, options?: SearchOptions) => Effect.Effect<IssueSearchResult, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly getUserActiveSprints: (userEmail: string) => Effect.Effect<Sprint[], ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  
  // Project operations
  readonly getProject: (projectKey: string) => Effect.Effect<Project, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly getAllProjects: () => Effect.Effect<Project[], NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError>;
  
  // Batch operations
  readonly batchGetIssues: (issueKeys: string[]) => Stream.Stream<Issue, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError>;
  readonly batchAssignIssues: (assignments: Array<{ issueKey: string; accountId: string }>) => Effect.Effect<Array<{ issueKey: string; success: boolean; error?: string }>, ValidationError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError>;
}

export class JiraClientServiceTag extends Context.Tag('JiraClientService')<
  JiraClientServiceTag,
  JiraClientService
>() {}

// ============= Jira Client Service Implementation =============
class JiraClientServiceImpl implements JiraClientService {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService
  ) {}
  
  // ============= Issue Operations =============
  getIssue(issueKey: string): Effect.Effect<Issue, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.validateIssueKey(issueKey),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const params = new URLSearchParams({
          fields: ISSUE_FIELDS.join(',')
        });
        const url = `${config.jiraUrl}/rest/api/3/issue/${issueKey}?${params}`;
        
        return pipe(
          this.logger.debug('Fetching issue', { issueKey }),
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => IssueSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse issue response', 'issue', String(data), error)
            })
          ),
          Effect.tap(() => this.logger.debug('Issue fetched successfully', { issueKey })),
          Effect.retry(this.createRetrySchedule())
        ) as Effect.Effect<Issue, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
      })
    );
  }
  
  searchIssues(jql: string, options: SearchOptions = {}): Effect.Effect<IssueSearchResult, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
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
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = SearchResultSchema.parse(data);
                return {
                  values: result.issues,
                  startAt: result.startAt,
                  maxResults: result.maxResults,
                  total: result.total,
                  isLast: result.startAt + result.issues.length >= result.total
                };
              },
              catch: (error) => new ParseError('Failed to parse search response', 'searchResult', String(data), error)
            })
          ),
          Effect.tap((result) => this.logger.debug('Issues searched successfully', { total: result.total, returned: result.values.length })),
          Effect.retry(this.createRetrySchedule())
        ) as Effect.Effect<IssueSearchResult, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
      })
    );
  }
  
  getAllProjectIssues(projectKey: string, jql?: string): Stream.Stream<Issue, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.validateProjectKey(projectKey)),
      Stream.flatMap(() => {
        const searchJql = jql || `project = ${projectKey} ORDER BY updated DESC`;
        
        return Stream.paginateEffect(0, (startAt: number) =>
          pipe(
            this.searchIssues(searchJql, { startAt, maxResults: 100 }),
            Effect.map((result) => [
              result.values,
              result.isLast ? Option.none<number>() : Option.some(startAt + 100)
            ] as const)
          )
        );
      }),
      Stream.flatMap((issues) => Stream.fromIterable(issues)),
      Stream.rechunk(50)
    );
  }
  
  assignIssue(issueKey: string, accountId: string): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      Effect.all({
        _: this.validateIssueKey(issueKey),
        __: this.validateAccountId(accountId),
        config: this.config.getConfig
      }),
      Effect.flatMap(({ config }) => {
        const url = `${config.jiraUrl}/rest/api/3/issue/${issueKey}/assignee`;
        const body = { accountId };
        
        return pipe(
          this.logger.debug('Assigning issue', { issueKey, accountId }),
          Effect.flatMap(() =>
            this.http.put<void>(url, body, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.tap(() => this.logger.info('Issue assigned successfully', { issueKey, accountId })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  updateIssue(issueKey: string, fields: Record<string, unknown>): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      Effect.all({
        _: this.validateIssueKey(issueKey),
        config: this.config.getConfig
      }),
      Effect.flatMap(({ config }) => {
        const url = `${config.jiraUrl}/rest/api/3/issue/${issueKey}`;
        const body = { fields };
        
        return pipe(
          this.logger.debug('Updating issue', { issueKey, fields: Object.keys(fields) }),
          Effect.flatMap(() =>
            this.http.put<void>(url, body, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.tap(() => this.logger.info('Issue updated successfully', { issueKey })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  createIssue(projectKey: string, issueType: string, summary: string, description?: string): Effect.Effect<Issue, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      Effect.all({
        _: this.validateProjectKey(projectKey),
        __: this.validateNonEmpty(summary, 'summary'),
        config: this.config.getConfig
      }),
      Effect.flatMap(({ config }) => {
        const url = `${config.jiraUrl}/rest/api/3/issue`;
        const body = {
          fields: {
            project: { key: projectKey },
            issuetype: { name: issueType },
            summary,
            ...(description && { description })
          }
        };
        
        return pipe(
          this.logger.debug('Creating issue', { projectKey, issueType, summary }),
          Effect.flatMap(() =>
            this.http.post<unknown>(url, body, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => IssueSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse created issue response', 'issue', String(data), error)
            })
          ),
          Effect.tap((issue) => this.logger.info('Issue created successfully', { issueKey: issue.key })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<Issue, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
  }
  
  // ============= User Operations =============
  getCurrentUser(): Effect.Effect<JiraUser, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/myself`;
        
        return pipe(
          this.logger.debug('Fetching current user'),
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => UserSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse user response', 'user', String(data), error)
            })
          ),
          Effect.tap((user) => this.logger.debug('Current user fetched successfully', { accountId: user.accountId })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<JiraUser, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
  }
  
  getUserByEmail(email: string): Effect.Effect<Option.Option<JiraUser>, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      this.validateEmail(email),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
        
        return pipe(
          this.logger.debug('Searching user by email', { email }),
          Effect.flatMap(() =>
            this.http.get<unknown[]>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                if (!Array.isArray(data) || data.length === 0) {
                  return Option.none();
                }
                const user = UserSchema.parse(data[0]);
                return Option.some(user);
              },
              catch: (error) => new ParseError('Failed to parse user search response', 'userSearch', String(data), error)
            })
          ),
          Effect.tap((userOption) => 
            this.logger.debug('User search completed', { 
              email, 
              found: Option.isSome(userOption) 
            })
          ),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<Option.Option<JiraUser>, ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
  }
  
  getUserActiveProjects(userEmail: string): Effect.Effect<string[], NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError | ValidationError> {
    return pipe(
      this.validateEmail(userEmail),
      Effect.flatMap(() => {
        const jql = `assignee = "${userEmail}" AND updated >= -30d ORDER BY updated DESC`;
        
        return pipe(
          this.searchIssues(jql, { maxResults: 100 }),
          Effect.map((result) => {
            const projectKeys = new Set<string>();
            result.values.forEach(issue => {
              const projectKey = issue.key.split('-')[0];
              projectKeys.add(projectKey);
            });
            return Array.from(projectKeys);
          })
        );
      })
    );
  }
  
  // ============= Board Operations =============
  getBoards(options: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' } = {}): Effect.Effect<BoardSearchResult, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
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
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = BoardsResponseSchema.parse(data);
                return {
                  values: result.values,
                  startAt: result.startAt,
                  maxResults: result.maxResults,
                  total: result.total,
                  isLast: result.startAt + result.values.length >= result.total
                };
              },
              catch: (error) => new ParseError('Failed to parse boards response', 'boards', String(data), error)
            })
          ),
          Effect.tap((result) => this.logger.debug('Boards fetched successfully', { total: result.total })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<BoardSearchResult, NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
  }
  
  getBoardsForProject(projectKey: string): Effect.Effect<Board[], ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() => this.getBoards({ projectKeyOrId: projectKey })),
      Effect.map((result) => result.values)
    );
  }
  
  getUserBoards(userEmail: string): Effect.Effect<Board[], ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      this.validateEmail(userEmail),
      Effect.flatMap(() => this.getUserActiveProjects(userEmail)),
      Effect.flatMap((activeProjects) =>
        Effect.forEach(activeProjects, (projectKey) =>
          pipe(
            this.getBoardsForProject(projectKey),
            Effect.catchAll(() => Effect.succeed([] as Board[]))
          )
        )
      ),
      Effect.map((boardArrays) => {
        // Flatten and deduplicate
        const allBoards = boardArrays.flat();
        const uniqueBoards = allBoards.filter((board, index, array) => 
          array.findIndex(b => b.id === board.id) === index
        );
        return uniqueBoards.sort((a, b) => a.name.localeCompare(b.name));
      })
    );
  }
  
  getBoardConfiguration(boardId: number): Effect.Effect<{ columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> }, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.validateBoardId(boardId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/configuration`;
        
        return pipe(
          this.logger.debug('Fetching board configuration', { boardId }),
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const parsedData = data as any;
                return {
                  columns: parsedData.columnConfig?.columns || []
                };
              },
              catch: (error) => new ParseError('Failed to parse board configuration response', 'boardConfig', String(data), error)
            })
          ),
          Effect.tap(() => this.logger.debug('Board configuration fetched successfully', { boardId })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<{ columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> }, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  getBoardIssues(boardId: number, options: SearchOptions = {}): Effect.Effect<IssueSearchResult, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
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
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const parsedData = data as any;
                const issues = (parsedData.issues || []).map((issue: any) => IssueSchema.parse(issue));
                return {
                  values: issues,
                  startAt: parsedData.startAt || 0,
                  maxResults: parsedData.maxResults || issues.length,
                  total: parsedData.total || issues.length,
                  isLast: true // Simple implementation
                };
              },
              catch: (error) => new ParseError('Failed to parse board issues response', 'boardIssues', String(data), error)
            })
          ),
          Effect.tap((result) => this.logger.debug('Board issues fetched successfully', { boardId, count: result.values.length })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<IssueSearchResult, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  // ============= Sprint Operations =============
  getActiveSprints(boardId: number): Effect.Effect<Sprint[], ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.validateBoardId(boardId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
        
        return pipe(
          this.logger.debug('Fetching active sprints', { boardId }),
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = SprintsResponseSchema.parse(data);
                return result.values;
              },
              catch: (error) => new ParseError('Failed to parse sprints response', 'sprints', String(data), error)
            })
          ),
          Effect.tap((sprints) => this.logger.debug('Active sprints fetched successfully', { boardId, count: sprints.length })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<Sprint[], ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  getAllSprints(boardId: number): Effect.Effect<Sprint[], ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.validateBoardId(boardId),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint`;
        
        return pipe(
          this.logger.debug('Fetching all sprints', { boardId }),
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = SprintsResponseSchema.parse(data);
                return result.values;
              },
              catch: (error) => new ParseError('Failed to parse sprints response', 'sprints', String(data), error)
            })
          ),
          Effect.tap((sprints) => this.logger.debug('All sprints fetched successfully', { boardId, count: sprints.length })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<Sprint[], ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  getSprintIssues(sprintId: number, options: SearchOptions = {}): Effect.Effect<IssueSearchResult, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
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
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const parsedData = data as any;
                const issues = (parsedData.issues || []).map((issue: any) => IssueSchema.parse(issue));
                return {
                  values: issues,
                  startAt: parsedData.startAt || 0,
                  maxResults: parsedData.maxResults || issues.length,
                  total: parsedData.total || issues.length,
                  isLast: true // Simple implementation
                };
              },
              catch: (error) => new ParseError('Failed to parse sprint issues response', 'sprintIssues', String(data), error)
            })
          ),
          Effect.tap((result) => this.logger.debug('Sprint issues fetched successfully', { sprintId, count: result.values.length })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<IssueSearchResult, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  getUserActiveSprints(userEmail: string): Effect.Effect<Sprint[], ValidationError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      this.validateEmail(userEmail),
      Effect.flatMap(() => this.getUserBoards(userEmail)),
      Effect.flatMap((boards) =>
        Effect.forEach(boards, (board) =>
          pipe(
            this.getActiveSprints(board.id),
            Effect.catchAll(() => Effect.succeed([] as Sprint[]))
          )
        )
      ),
      Effect.map((sprintArrays) => {
        // Flatten and deduplicate
        const allSprints = sprintArrays.flat();
        const uniqueSprints = Array.from(
          new Map(allSprints.map(s => [s.id, s])).values()
        );
        return uniqueSprints;
      })
    );
  }
  
  // ============= Project Operations =============
  getProject(projectKey: string): Effect.Effect<Project, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/project/${projectKey}`;
        
        return pipe(
          this.logger.debug('Fetching project', { projectKey }),
          Effect.flatMap(() =>
            this.http.get<unknown>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => ProjectSchema.parse(data),
              catch: (error) => new ParseError('Failed to parse project response', 'project', String(data), error)
            })
          ),
          Effect.tap(() => this.logger.debug('Project fetched successfully', { projectKey })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<Project, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError, never>;
  }
  
  getAllProjects(): Effect.Effect<Project[], NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError> {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/project`;
        
        return pipe(
          this.logger.debug('Fetching all projects'),
          Effect.flatMap(() =>
            this.http.get<unknown[]>(url, this.getAuthHeaders(config))
          ),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                if (!Array.isArray(data)) {
                  throw new Error('Projects response is not an array');
                }
                return data.map(project => ProjectSchema.parse(project));
              },
              catch: (error) => new ParseError('Failed to parse projects response', 'projects', String(data), error)
            })
          ),
          Effect.tap((projects) => this.logger.debug('All projects fetched successfully', { count: projects.length })),
          Effect.retry(this.createRetrySchedule())
        );
      })
    ) as Effect.Effect<Project[], NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError, never>;
  }
  
  // ============= Batch Operations =============
  batchGetIssues(issueKeys: string[]): Stream.Stream<Issue, ValidationError | NotFoundError | NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError> {
    return pipe(
      Stream.fromIterable(issueKeys),
      Stream.mapEffect((issueKey) =>
        pipe(
          this.getIssue(issueKey),
          Effect.catchAll((error) => {
            // Log the error but don't fail the entire stream
            return pipe(
              this.logger.warn('Failed to fetch issue in batch', { issueKey, error: error.message }),
              Effect.flatMap(() => Effect.fail(error))
            );
          })
        )
      ),
      Stream.rechunk(10) // Process in chunks of 10
    );
  }
  
  batchAssignIssues(assignments: Array<{ issueKey: string; accountId: string }>): Effect.Effect<Array<{ issueKey: string; success: boolean; error?: string }>, ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      Effect.forEach(assignments, ({ issueKey, accountId }) =>
        pipe(
          this.assignIssue(issueKey, accountId),
          Effect.map(() => ({ issueKey, success: true as const })),
          Effect.catchAll((error) =>
            Effect.succeed({
              issueKey,
              success: false as const,
              error: error.message
            })
          )
        )
      )
    );
  }
  
  // ============= Private Helper Methods =============
  private getAuthHeaders(config: { email: string; apiToken: string }): Record<string, string> {
    const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }
  
  private mapHttpError = (error: unknown): NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError => {
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
    return pipe(
      Schedule.exponential(Duration.millis(100)),
      Schedule.intersect(Schedule.recurs(3)),
      Schedule.jittered
    );
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

// ============= Service Layer =============
export const JiraClientServiceLive = Layer.effect(
  JiraClientServiceTag,
  pipe(
    Effect.all({
      http: HttpClientServiceTag,
      config: ConfigServiceTag,
      logger: LoggerServiceTag
    }),
    Effect.map(({ http, config, logger }) => new JiraClientServiceImpl(http, config, logger))
  )
);

// ============= Helper Functions =============
// Use JiraClientServiceLive directly with Effect.provide() when needed