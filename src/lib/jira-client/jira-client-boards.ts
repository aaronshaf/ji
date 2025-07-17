import { Effect, pipe, Schema } from 'effect';
import type { Config } from '../config.js';
import { JiraClientBase } from './jira-client-base.js';
import { JiraClientIssues } from './jira-client-issues.js';
import {
  AuthenticationError,
  type Board,
  BoardsResponseSchema,
  type Issue,
  NetworkError,
  ValidationError,
} from './jira-client-types.js';

export class JiraClientBoards extends JiraClientBase {
  private issuesClient: JiraClientIssues;

  constructor(config: Config) {
    super(config);
    this.issuesClient = new JiraClientIssues(config);
  }

  /**
   * Effect-based version of getBoards with structured error handling
   */
  getBoardsEffect(options?: {
    projectKeyOrId?: string;
    type?: 'scrum' | 'kanban';
  }): Effect.Effect<Board[], ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      Effect.sync(() => {
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

        return url;
      }),
      Effect.flatMap((url) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'GET',
              headers: this.getHeaders(),
              signal: AbortSignal.timeout(10000),
            });

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to fetch boards: ${response.status} - ${errorText}`);
            }

            const data = (await response.json()) as unknown;
            const parsed = Schema.decodeUnknownSync(BoardsResponseSchema)(data);
            return parsed.values as Board[];
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while fetching boards: ${error}`);
          },
        }),
      ),
    );
  }

  /**
   * Effect-based version of getUserBoards with concurrent fetching
   */
  getUserBoardsEffect(userEmail: string): Effect.Effect<Board[], ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate user email
      Effect.sync(() => {
        if (!userEmail || userEmail.trim().length === 0) {
          throw new ValidationError('User email cannot be empty');
        }
      }),
      Effect.flatMap(() =>
        // First get user's active projects
        this.getUserActiveProjectsEffect(userEmail),
      ),
      Effect.flatMap((activeProjects) => {
        if (activeProjects.length === 0) {
          return Effect.succeed([] as Board[]);
        }

        // Get boards for each project concurrently
        const boardEffects = activeProjects.map((projectKey) =>
          pipe(
            this.getBoardsEffect({ projectKeyOrId: projectKey }),
            Effect.catchAll(() => Effect.succeed([] as Board[])), // Continue if one project fails
          ),
        );

        return pipe(
          Effect.all(boardEffects, { concurrency: 3 }),
          Effect.map((boardArrays) => {
            const allBoards = boardArrays.flat();

            // Remove duplicates and sort by name
            const uniqueBoards = allBoards.filter(
              (board, index, array) => array.findIndex((b) => b.id === board.id) === index,
            );

            return uniqueBoards.sort((a, b) => a.name.localeCompare(b.name));
          }),
        );
      }),
    );
  }

  /**
   * Effect-based version of getUserActiveProjects
   */
  private getUserActiveProjectsEffect(
    userEmail: string,
  ): Effect.Effect<string[], ValidationError | NetworkError | AuthenticationError> {
    const jql = `assignee = "${userEmail}" AND updated >= -30d ORDER BY updated DESC`;

    return pipe(
      this.issuesClient.searchIssuesEffect(jql, { maxResults: 100 }),
      Effect.map((result) => {
        const projectKeys = new Set<string>();

        result.issues.forEach((issue) => {
          const projectKey = issue.key.split('-')[0];
          projectKeys.add(projectKey);
        });

        return Array.from(projectKeys);
      }),
      Effect.catchAll(() => Effect.succeed([] as string[])), // Return empty array on error
    );
  }

  /**
   * Effect-based version of getBoardIssues with structured error handling
   */
  getBoardIssuesEffect(
    boardId: number,
    options?: {
      maxResults?: number;
    },
  ): Effect.Effect<Issue[], ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate board ID
      Effect.sync(() => {
        if (!boardId || boardId <= 0) {
          throw new ValidationError('Board ID must be a positive number');
        }
      }),
      Effect.flatMap(() => {
        const maxResults = options?.maxResults || 50;
        const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/issue?maxResults=${maxResults}`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'GET',
              headers: this.getHeaders(),
              signal: AbortSignal.timeout(15000), // 15 second timeout for board issues
            });

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to fetch board issues: ${response.status} - ${errorText}`);
            }

            const data = (await response.json()) as { issues?: unknown[] };

            // Map the agile API response to our Issue type
            return (data.issues || []).map((issue: unknown) => {
              const typedIssue = issue as {
                key: string;
                self: string;
                fields: {
                  summary: string;
                  description: unknown;
                  status: { name: string };
                  assignee?: { displayName: string; emailAddress?: string } | null;
                  reporter: { displayName: string; emailAddress?: string };
                  priority?: { name: string } | null;
                  created: string;
                  updated: string;
                };
              };
              return {
                key: typedIssue.key,
                self: typedIssue.self,
                fields: {
                  summary: typedIssue.fields.summary,
                  description: typedIssue.fields.description,
                  status: typedIssue.fields.status,
                  assignee: typedIssue.fields.assignee,
                  reporter: typedIssue.fields.reporter,
                  priority: typedIssue.fields.priority,
                  created: typedIssue.fields.created,
                  updated: typedIssue.fields.updated,
                },
              };
            });
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while fetching board issues: ${error}`);
          },
        });
      }),
    );
  }

  // Backward compatible versions
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

    const data = (await response.json()) as unknown;
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
      const result = await this.issuesClient.searchIssues(jql, { maxResults: 100 });
      const projectKeys = new Set<string>();

      result.issues.forEach((issue) => {
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
    const uniqueBoards = allBoards.filter((board, index, array) => array.findIndex((b) => b.id === board.id) === index);

    return uniqueBoards.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getBoardConfiguration(
    boardId: number,
  ): Promise<{ columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> }> {
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/configuration`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch board configuration: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      columnConfig?: { columns?: { name: string; statuses: { id: string; name: string }[] }[] };
    };
    return {
      columns: data.columnConfig?.columns || [],
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

    const data = (await response.json()) as { issues?: unknown[] };

    // Map the agile API response to our Issue type
    return (data.issues || []).map((issue: unknown) => {
      const typedIssue = issue as {
        key: string;
        self: string;
        fields: {
          summary: string;
          description: unknown;
          status: { name: string };
          assignee?: { displayName: string; emailAddress?: string } | null;
          reporter: { displayName: string; emailAddress?: string };
          priority?: { name: string } | null;
          created: string;
          updated: string;
        };
      };
      return {
        key: typedIssue.key,
        self: typedIssue.self,
        fields: {
          summary: typedIssue.fields.summary,
          description: typedIssue.fields.description,
          status: typedIssue.fields.status,
          assignee: typedIssue.fields.assignee,
          reporter: typedIssue.fields.reporter,
          priority: typedIssue.fields.priority,
          created: typedIssue.fields.created,
          updated: typedIssue.fields.updated,
        },
      };
    });
  }
}
