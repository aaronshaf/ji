import { Schema } from 'effect';
import type { Config } from './config.js';
import { Effect, pipe } from 'effect';

// Simple approach - just validate the basic structure and allow any fields
const IssueSchema = Schema.Struct({
  key: Schema.String,
  self: Schema.String,
  fields: Schema.Any, // Accept any fields structure
});

const SearchResultSchema = Schema.Struct({
  issues: Schema.Array(IssueSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

const BoardSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  type: Schema.String,
  location: Schema.Struct({
    projectKey: Schema.String.pipe(Schema.optional),
    projectName: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
});

const BoardsResponseSchema = Schema.Struct({
  values: Schema.Array(BoardSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

const SprintSchema = Schema.Struct({
  id: Schema.Number,
  self: Schema.String,
  state: Schema.String,
  name: Schema.String,
  startDate: Schema.String.pipe(Schema.optional),
  endDate: Schema.String.pipe(Schema.optional),
  originBoardId: Schema.Number,
  goal: Schema.String.pipe(Schema.optional),
});

const SprintsResponseSchema = Schema.Struct({
  values: Schema.Array(SprintSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

// Define proper Issue interface instead of deriving from schema
export interface Issue {
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: any;
    status: { name: string };
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter: { displayName: string; emailAddress?: string };
    priority?: { name: string } | null;
    created: string;
    updated: string;
    labels?: string[];
    comment?: any;
    project?: any;
    [key: string]: any; // Allow additional custom fields
  };
}

export type Board = Schema.Schema.Type<typeof BoardSchema>;
export type Sprint = Schema.Schema.Type<typeof SprintSchema>;

// Error types for Jira operations
export class JiraError extends Error {
  readonly _tag = 'JiraError';
}

export class NetworkError extends Error {
  readonly _tag = 'NetworkError';
}

export class AuthenticationError extends Error {
  readonly _tag = 'AuthenticationError';
}

export class NotFoundError extends Error {
  readonly _tag = 'NotFoundError';
}

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

// Standard fields to fetch for issues including sprint information
export const ISSUE_FIELDS = [
  'summary',
  'description', 
  'status',
  'assignee',
  'reporter',
  'priority',
  'created',
  'updated',
  // Common sprint custom fields
  'customfield_10020', // Most common sprint field
  'customfield_10021', // Alternative sprint field
  'customfield_10016', // Another common sprint field
  'customfield_10018', // Sometimes used
  'customfield_10019', // Sometimes used
];

export class JiraClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async getIssue(issueKey: string): Promise<Issue> {
    const params = new URLSearchParams({
      fields: ISSUE_FIELDS.join(',')
    });
    const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}?${params}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch issue: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return Schema.decodeUnknownSync(IssueSchema)(data) as Issue;
  }

  async searchIssues(jql: string, options?: {
    startAt?: number;
    maxResults?: number;
    fields?: string[];
  }): Promise<{ issues: Issue[]; total: number; startAt: number }> {
    const params = new URLSearchParams({
      jql,
      startAt: (options?.startAt || 0).toString(),
      maxResults: (options?.maxResults || 50).toString(),
    });

    if (options?.fields) {
      params.append('fields', options.fields.join(','));
    }

    const url = `${this.config.jiraUrl}/rest/api/3/search?${params}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to search issues: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const result = Schema.decodeUnknownSync(SearchResultSchema)(data);
    
    return {
      issues: result.issues as Issue[],
      total: result.total,
      startAt: result.startAt,
    };
  }

  async getAllProjectIssues(projectKey: string, onProgress?: (current: number, total: number) => void, jql?: string): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let startAt = 0;
    const maxResults = 100; // Max allowed by Jira API
    let total = 0;

    // Use provided JQL or default to all project issues
    const searchJql = jql || `project = ${projectKey} ORDER BY updated DESC`;

    while (true) {
      const result = await this.searchIssues(searchJql, {
        startAt,
        maxResults,
      });

      allIssues.push(...result.issues);
      total = result.total;

      if (onProgress) {
        onProgress(allIssues.length, total);
      }

      // Check if we've fetched all issues
      if (allIssues.length >= total || result.issues.length === 0) {
        break;
      }

      startAt += maxResults;
    }

    return allIssues;
  }

  // Effect-based get current user
  getCurrentUserEffect(): Effect.Effect<{ accountId: string; displayName: string; emailAddress?: string }, NetworkError | AuthenticationError> {
    const url = `${this.config.jiraUrl}/rest/api/3/myself`;
    
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(10000) // 10 second timeout
        });

        if (response.status === 401 || response.status === 403) {
          const errorText = await response.text();
          throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new NetworkError(`Failed to get current user: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as {
          accountId: string;
          displayName: string;
          emailAddress?: string;
        };
        
        return {
          accountId: data.accountId,
          displayName: data.displayName,
          emailAddress: data.emailAddress,
        };
      },
      catch: (error) => {
        if (error instanceof AuthenticationError) return error;
        if (error instanceof NetworkError) return error;
        return new NetworkError(`Network error while fetching current user: ${error}`);
      }
    });
  }

  // Backward compatible version
  async getCurrentUser(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
    const url = `${this.config.jiraUrl}/rest/api/3/myself`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get current user: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      accountId: string;
      displayName: string;
      emailAddress?: string;
    };
    return {
      accountId: data.accountId,
      displayName: data.displayName,
      emailAddress: data.emailAddress,
    };
  }

  // Effect-based assign issue
  assignIssueEffect(issueKey: string, accountId: string): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123');
        }
        if (!accountId || accountId.trim().length === 0) {
          throw new ValidationError('Account ID cannot be empty');
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/assignee`;
        
        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'PUT',
              headers: this.getHeaders(),
              body: JSON.stringify({ accountId }),
              signal: AbortSignal.timeout(10000) // 10 second timeout
            });

            if (response.status === 404) {
              const errorText = await response.text();
              throw new NotFoundError(`Issue ${issueKey} not found: ${errorText}`);
            }

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Not authorized to assign issue: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to assign issue: ${response.status} - ${errorText}`);
            }
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof NotFoundError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while assigning issue: ${error}`);
          }
        });
      })
    );
  }

  // Backward compatible version
  async assignIssue(issueKey: string, accountId: string): Promise<void> {
    const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/assignee`;
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ accountId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to assign issue: ${response.status} - ${errorText}`);
    }
  }

  async getBoards(options?: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' }): Promise<Board[]> {
    let url = `${this.config.jiraUrl}/rest/agile/1.0/board`;
    const params = new URLSearchParams();
    
    if (options?.projectKeyOrId) {
      params.append('projectKeyOrId', options.projectKeyOrId);
    }
    if (options?.type) {
      params.append('type', options.type);
    }
    
    if (params.toString()) {
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch boards: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as unknown;
    const parsed = Schema.decodeUnknownSync(BoardsResponseSchema)(data);
    return parsed.values as Board[];
  }

  async getBoardsForProject(projectKey: string): Promise<Board[]> {
    return this.getBoards({ projectKeyOrId: projectKey });
  }

  async getUserActiveProjects(userEmail: string): Promise<string[]> {
    // Get recent issues assigned to user to determine active projects
    const jql = `assignee = "${userEmail}" AND updated >= -30d ORDER BY updated DESC`;
    
    try {
      const result = await this.searchIssues(jql, { maxResults: 100 });
      const projectKeys = new Set<string>();
      
      result.issues.forEach(issue => {
        const projectKey = issue.key.split('-')[0];
        projectKeys.add(projectKey);
      });
      
      return Array.from(projectKeys);
    } catch (error) {
      console.warn('Failed to get user active projects:', error);
      return [];
    }
  }

  async getUserBoards(userEmail: string): Promise<Board[]> {
    const activeProjects = await this.getUserActiveProjects(userEmail);
    const allBoards: Board[] = [];
    
    // Get boards for each active project
    for (const projectKey of activeProjects) {
      try {
        const projectBoards = await this.getBoardsForProject(projectKey);
        allBoards.push(...projectBoards);
      } catch (error) {
        console.warn(`Failed to get boards for project ${projectKey}:`, error);
      }
    }
    
    // Remove duplicates and sort by name
    const uniqueBoards = allBoards.filter((board, index, array) => 
      array.findIndex(b => b.id === board.id) === index
    );
    
    return uniqueBoards.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getBoardConfiguration(boardId: number): Promise<{ columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> }> {
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/configuration`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch board configuration: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    return {
      columns: data.columnConfig?.columns || []
    };
  }

  async getBoardIssues(boardId: number): Promise<Issue[]> {
    // Simple version - just get first 50 issues to avoid timeout
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/issue?maxResults=50`;

    const response = await fetch(url, {
      method: 'GET', 
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch board issues: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    
    // Map the agile API response to our Issue type
    return (data.issues || []).map((issue: any) => ({
      key: issue.key,
      self: issue.self,
      fields: {
        summary: issue.fields.summary,
        description: issue.fields.description,
        status: issue.fields.status,
        assignee: issue.fields.assignee,
        reporter: issue.fields.reporter,
        priority: issue.fields.priority,
        created: issue.fields.created,
        updated: issue.fields.updated
      }
    }));
  }

  async getActiveSprints(boardId: number): Promise<Sprint[]> {
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch active sprints: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const parsed = Schema.decodeUnknownSync(SprintsResponseSchema)(data);
    return parsed.values as Sprint[];
  }

  async getSprintIssues(sprintId: number, options?: {
    startAt?: number;
    maxResults?: number;
  }): Promise<{ issues: Issue[]; total: number }> {
    const params = new URLSearchParams({
      startAt: (options?.startAt || 0).toString(),
      maxResults: (options?.maxResults || 50).toString(),
    });

    const url = `${this.config.jiraUrl}/rest/agile/1.0/sprint/${sprintId}/issue?${params}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch sprint issues: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    return {
      issues: data.issues.map((issue: any) => Schema.decodeUnknownSync(IssueSchema)(issue) as Issue),
      total: data.total
    };
  }

  async getUserActiveSprints(userEmail: string): Promise<Sprint[]> {
    // First, get all boards the user has access to
    const boards = await this.getUserBoards(userEmail);
    const allSprints: Sprint[] = [];
    
    // For each board, get active sprints
    for (const board of boards) {
      try {
        const sprints = await this.getActiveSprints(board.id);
        allSprints.push(...sprints);
      } catch (error) {
        // Skip boards that might not have sprint support
        continue;
      }
    }
    
    // Remove duplicates
    const uniqueSprints = Array.from(
      new Map(allSprints.map(s => [s.id, s])).values()
    );
    
    return uniqueSprints;
  }
}