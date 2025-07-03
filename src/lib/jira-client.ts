import { Effect, pipe, Schema } from 'effect';
import type { Config } from './config.js';

// Simple approach - just validate the basic structure and allow any fields
const IssueSchema = Schema.Struct({
  key: Schema.String,
  self: Schema.String,
  fields: Schema.Unknown, // Accept any fields structure
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
    description?: unknown;
    status: { name: string };
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter: { displayName: string; emailAddress?: string };
    priority?: { name: string } | null;
    created: string;
    updated: string;
    labels?: string[];
    comment?: unknown;
    project?: { key: string; name: string };
    [key: string]: unknown; // Allow additional custom fields
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
  'labels',
  'components',
  // Common sprint custom fields
  'customfield_10020', // Most common sprint field
  'customfield_10021', // Alternative sprint field
  'customfield_10016', // Another common sprint field
  'customfield_10018', // Sometimes used
  'customfield_10019', // Sometimes used
  // Common acceptance criteria custom fields
  'customfield_10014', // Common acceptance criteria field
  'customfield_10015', // Alternative acceptance criteria field
  'customfield_10001', // Another common one
  'customfield_10002', // Another common one
  'customfield_10003', // Another common one
  'customfield_10004', // Another common one
  'customfield_10005', // Another common one
  'customfield_10006', // Another common one
  'customfield_10007', // Another common one
  'customfield_10008', // Another common one
  'customfield_10009', // Another common one
  'customfield_10010', // Another common one
  'customfield_10011', // Another common one
  'customfield_10012', // Another common one
  'customfield_10013', // Another common one
];

export class JiraClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async getIssue(issueKey: string): Promise<Issue> {
    const params = new URLSearchParams({
      fields: ISSUE_FIELDS.join(','),
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

  async searchIssues(
    jql: string,
    options?: {
      startAt?: number;
      maxResults?: number;
      fields?: string[];
    },
  ): Promise<{ issues: Issue[]; total: number; startAt: number }> {
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

  async getAllProjectIssues(
    projectKey: string,
    onProgress?: (current: number, total: number) => void,
    jql?: string,
  ): Promise<Issue[]> {
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

  // ============= Effect-based Core Methods =============

  /**
   * Effect-based version of getIssue with structured error handling
   */
  getIssueEffect(
    issueKey: string,
  ): Effect.Effect<Issue, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate issue key format
      Effect.sync(() => {
        if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123');
        }
      }),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          fields: ISSUE_FIELDS.join(','),
        });
        const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}?${params}`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'GET',
              headers: this.getHeaders(),
              signal: AbortSignal.timeout(10000), // 10 second timeout
            });

            if (response.status === 404) {
              const errorText = await response.text();
              throw new NotFoundError(`Issue ${issueKey} not found: ${errorText}`);
            }

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to fetch issue: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            return Schema.decodeUnknownSync(IssueSchema)(data) as Issue;
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof NotFoundError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while fetching issue: ${error}`);
          },
        });
      }),
    );
  }

  /**
   * Effect-based version of searchIssues with structured error handling
   */
  searchIssuesEffect(
    jql: string,
    options?: {
      startAt?: number;
      maxResults?: number;
      fields?: string[];
    },
  ): Effect.Effect<
    { issues: Issue[]; total: number; startAt: number },
    ValidationError | NetworkError | AuthenticationError
  > {
    return pipe(
      // Validate JQL
      Effect.sync(() => {
        if (!jql || jql.trim().length === 0) {
          throw new ValidationError('JQL query cannot be empty');
        }
      }),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          jql,
          startAt: (options?.startAt || 0).toString(),
          maxResults: (options?.maxResults || 50).toString(),
        });

        if (options?.fields) {
          params.append('fields', options.fields.join(','));
        }

        const url = `${this.config.jiraUrl}/rest/api/3/search?${params}`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'GET',
              headers: this.getHeaders(),
              signal: AbortSignal.timeout(15000), // 15 second timeout for searches
            });

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to search issues: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const result = Schema.decodeUnknownSync(SearchResultSchema)(data);

            return {
              issues: result.issues as Issue[],
              total: result.total,
              startAt: result.startAt,
            };
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while searching issues: ${error}`);
          },
        });
      }),
    );
  }

  /**
   * Effect-based version of getAllProjectIssues with concurrent fetching and progress tracking
   */
  getAllProjectIssuesEffect(
    projectKey: string,
    options?: {
      jql?: string;
      onProgress?: (current: number, total: number) => void;
      maxConcurrency?: number;
    },
  ): Effect.Effect<Issue[], ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate project key
      Effect.sync(() => {
        if (!projectKey || projectKey.trim().length === 0) {
          throw new ValidationError('Project key cannot be empty');
        }
      }),
      Effect.flatMap(() => {
        const searchJql = options?.jql || `project = ${projectKey} ORDER BY updated DESC`;
        const maxResults = 100; // Max allowed by Jira API
        const maxConcurrency = options?.maxConcurrency || 3; // Limit concurrent requests

        // First, get the total count
        return pipe(
          this.searchIssuesEffect(searchJql, { startAt: 0, maxResults: 1 }),
          Effect.flatMap(({ total }) => {
            if (total === 0) {
              return Effect.succeed([] as Issue[]);
            }

            // Calculate number of pages needed
            const pages = Math.ceil(total / maxResults);
            const pageEffects = Array.from({ length: pages }, (_, i) =>
              pipe(
                this.searchIssuesEffect(searchJql, {
                  startAt: i * maxResults,
                  maxResults,
                }),
                Effect.map((result) => result.issues),
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (options?.onProgress) {
                      const currentCount = Math.min((i + 1) * maxResults, total);
                      options.onProgress(currentCount, total);
                    }
                  }),
                ),
              ),
            );

            // Execute with controlled concurrency
            return pipe(
              Effect.all(pageEffects, { concurrency: maxConcurrency }),
              Effect.map((pages) => pages.flat()),
            );
          }),
        );
      }),
    );
  }

  // Effect-based get current user
  getCurrentUserEffect(): Effect.Effect<
    { accountId: string; displayName: string; emailAddress?: string },
    NetworkError | AuthenticationError
  > {
    const url = `${this.config.jiraUrl}/rest/api/3/myself`;

    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (response.status === 401 || response.status === 403) {
          const errorText = await response.text();
          throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new NetworkError(`Failed to get current user: ${response.status} - ${errorText}`);
        }

        const data = (await response.json()) as {
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
      },
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

    const data = (await response.json()) as {
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
  assignIssueEffect(
    issueKey: string,
    accountId: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
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
              signal: AbortSignal.timeout(10000), // 10 second timeout
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
          },
        });
      }),
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

  /**
   * Effect-based version of addComment with structured error handling
   */
  addCommentEffect(
    issueKey: string,
    comment: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123');
        }
        if (!comment || comment.trim().length === 0) {
          throw new ValidationError('Comment cannot be empty');
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/comment`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'POST',
              headers: this.getHeaders(),
              body: JSON.stringify({
                body: {
                  type: 'doc',
                  version: 1,
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: comment,
                        },
                      ],
                    },
                  ],
                },
              }),
            });

            if (!response.ok) {
              const errorText = await response.text();

              if (response.status === 404) {
                throw new NotFoundError(`Issue ${issueKey} not found`);
              }

              if (response.status === 401 || response.status === 403) {
                throw new AuthenticationError('Not authorized to add comments to this issue');
              }

              throw new NetworkError(`Failed to add comment: ${response.status} - ${errorText}`);
            }
          },
          catch: (error) => {
            if (
              error instanceof NotFoundError ||
              error instanceof AuthenticationError ||
              error instanceof NetworkError
            ) {
              return error;
            }
            return new NetworkError(`Network error: ${error}`);
          },
        });
      }),
    );
  }

  // Backward compatible version
  async addComment(issueKey: string, comment: string): Promise<void> {
    await Effect.runPromise(this.addCommentEffect(issueKey, comment));
  }

  /**
   * Effect-based version of getting available transitions for an issue
   */
  getIssueTransitionsEffect(
    issueKey: string,
  ): Effect.Effect<
    Array<{ id: string; name: string }>,
    ValidationError | NotFoundError | NetworkError | AuthenticationError
  > {
    return pipe(
      // Validate issue key
      Effect.sync(() => {
        if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123');
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/transitions`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'GET',
              headers: this.getHeaders(),
              signal: AbortSignal.timeout(10000),
            });

            if (response.status === 404) {
              const errorText = await response.text();
              throw new NotFoundError(`Issue ${issueKey} not found: ${errorText}`);
            }

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Not authorized to view transitions: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to get transitions: ${response.status} - ${errorText}`);
            }

            const data = (await response.json()) as {
              transitions: Array<{ id: string; name: string; to: { name: string } }>;
            };

            return data.transitions.map((t) => ({ id: t.id, name: t.name }));
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof NotFoundError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while getting transitions: ${error}`);
          },
        });
      }),
    );
  }

  /**
   * Effect-based version of transitioning an issue (e.g., closing/resolving)
   */
  transitionIssueEffect(
    issueKey: string,
    transitionId: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123');
        }
        if (!transitionId || transitionId.trim().length === 0) {
          throw new ValidationError('Transition ID cannot be empty');
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/transitions`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'POST',
              headers: this.getHeaders(),
              body: JSON.stringify({
                transition: {
                  id: transitionId,
                },
              }),
              signal: AbortSignal.timeout(10000),
            });

            if (response.status === 404) {
              const errorText = await response.text();
              throw new NotFoundError(`Issue ${issueKey} not found: ${errorText}`);
            }

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Not authorized to transition issue: ${response.status} - ${errorText}`);
            }

            if (response.status === 400) {
              const errorText = await response.text();
              throw new ValidationError(`Invalid transition: ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to transition issue: ${response.status} - ${errorText}`);
            }
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof NotFoundError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while transitioning issue: ${error}`);
          },
        });
      }),
    );
  }

  /**
   * Effect-based version of closing an issue (finds appropriate done transition)
   */
  closeIssueEffect(
    issueKey: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return pipe(
      this.getIssueTransitionsEffect(issueKey),
      Effect.flatMap((transitions) => {
        // Prioritize "Done" transition first, then other completion states
        const doneTransition =
          transitions.find((t) => t.name.toLowerCase() === 'done') ||
          transitions.find((t) => t.name.toLowerCase().includes('done')) ||
          transitions.find((t) => t.name.toLowerCase().includes('complete')) ||
          transitions.find((t) => t.name.toLowerCase().includes('resolve')) ||
          transitions.find((t) => t.name.toLowerCase().includes('close'));

        if (!doneTransition) {
          return Effect.fail(
            new ValidationError(
              `No Done/completion transition found. Available transitions: ${transitions.map((t) => t.name).join(', ')}`,
            ),
          );
        }

        return this.transitionIssueEffect(issueKey, doneTransition.id);
      }),
    );
  }

  // Backward compatible versions
  async getIssueTransitions(issueKey: string): Promise<Array<{ id: string; name: string }>> {
    return Effect.runPromise(this.getIssueTransitionsEffect(issueKey));
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await Effect.runPromise(this.transitionIssueEffect(issueKey, transitionId));
  }

  async closeIssue(issueKey: string): Promise<void> {
    await Effect.runPromise(this.closeIssueEffect(issueKey));
  }

  /**
   * Effect-based version of getting custom fields to help identify acceptance criteria
   */
  getCustomFieldsEffect(): Effect.Effect<
    Array<{ id: string; name: string; description?: string; type: string }>,
    NetworkError | AuthenticationError
  > {
    const url = `${this.config.jiraUrl}/rest/api/3/field`;

    return Effect.tryPromise({
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
          throw new NetworkError(`Failed to get custom fields: ${response.status} - ${errorText}`);
        }

        const fields = (await response.json()) as Array<{
          id: string;
          name: string;
          description?: string;
          schema?: { type: string; custom?: string };
          custom: boolean;
        }>;

        // Filter to custom fields only and return relevant info
        return fields
          .filter((field) => field.custom)
          .map((field) => ({
            id: field.id,
            name: field.name,
            description: field.description,
            type: field.schema?.type || 'unknown',
          }));
      },
      catch: (error) => {
        if (error instanceof AuthenticationError) return error;
        if (error instanceof NetworkError) return error;
        return new NetworkError(`Network error while getting custom fields: ${error}`);
      },
    });
  }

  // Backward compatible version
  async getCustomFields(): Promise<Array<{ id: string; name: string; description?: string; type: string }>> {
    return Effect.runPromise(this.getCustomFieldsEffect());
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
      this.searchIssuesEffect(jql, { maxResults: 100 }),
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
      const result = await this.searchIssues(jql, { maxResults: 100 });
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

  /**
   * Effect-based version of getActiveSprints with structured error handling
   */
  getActiveSprintsEffect(
    boardId: number,
  ): Effect.Effect<Sprint[], ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate board ID
      Effect.sync(() => {
        if (!boardId || boardId <= 0) {
          throw new ValidationError('Board ID must be a positive number');
        }
      }),
      Effect.flatMap(() => {
        const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;

        return Effect.tryPromise({
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
              throw new NetworkError(`Failed to fetch active sprints: ${response.status} - ${errorText}`);
            }

            const data = (await response.json()) as unknown;
            const parsed = Schema.decodeUnknownSync(SprintsResponseSchema)(data);
            return parsed.values as Sprint[];
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while fetching active sprints: ${error}`);
          },
        });
      }),
    );
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

  /**
   * Effect-based version of getSprintIssues with structured error handling
   */
  getSprintIssuesEffect(
    sprintId: number,
    options?: {
      startAt?: number;
      maxResults?: number;
    },
  ): Effect.Effect<{ issues: Issue[]; total: number }, ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate sprint ID
      Effect.sync(() => {
        if (!sprintId || sprintId <= 0) {
          throw new ValidationError('Sprint ID must be a positive number');
        }
      }),
      Effect.flatMap(() => {
        const params = new URLSearchParams({
          startAt: (options?.startAt || 0).toString(),
          maxResults: (options?.maxResults || 50).toString(),
        });

        const url = `${this.config.jiraUrl}/rest/agile/1.0/sprint/${sprintId}/issue?${params}`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'GET',
              headers: this.getHeaders(),
              signal: AbortSignal.timeout(15000), // 15 second timeout for sprint issues
            });

            if (response.status === 401 || response.status === 403) {
              const errorText = await response.text();
              throw new AuthenticationError(`Authentication failed: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to fetch sprint issues: ${response.status} - ${errorText}`);
            }

            const data = (await response.json()) as { issues: unknown[]; total: number };
            return {
              issues: data.issues.map((issue: unknown) => Schema.decodeUnknownSync(IssueSchema)(issue) as Issue),
              total: data.total,
            };
          },
          catch: (error) => {
            if (error instanceof ValidationError) return error;
            if (error instanceof AuthenticationError) return error;
            if (error instanceof NetworkError) return error;
            return new NetworkError(`Network error while fetching sprint issues: ${error}`);
          },
        });
      }),
    );
  }

  async getSprintIssues(
    sprintId: number,
    options?: {
      startAt?: number;
      maxResults?: number;
    },
  ): Promise<{ issues: Issue[]; total: number }> {
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

    const data = (await response.json()) as { issues: unknown[]; total: number };
    return {
      issues: data.issues.map((issue: unknown) => Schema.decodeUnknownSync(IssueSchema)(issue) as Issue),
      total: data.total,
    };
  }

  /**
   * Effect-based version of getUserActiveSprints with concurrent fetching
   */
  getUserActiveSprintsEffect(
    userEmail: string,
  ): Effect.Effect<Sprint[], ValidationError | NetworkError | AuthenticationError> {
    return pipe(
      // Validate user email
      Effect.sync(() => {
        if (!userEmail || userEmail.trim().length === 0) {
          throw new ValidationError('User email cannot be empty');
        }
      }),
      Effect.flatMap(() =>
        // First get user's boards
        this.getUserBoardsEffect(userEmail),
      ),
      Effect.flatMap((boards) => {
        if (boards.length === 0) {
          return Effect.succeed([] as Sprint[]);
        }

        // Get active sprints for each board concurrently
        const sprintEffects = boards.map((board) =>
          pipe(
            this.getActiveSprintsEffect(board.id),
            Effect.catchAll(() => Effect.succeed([] as Sprint[])), // Continue if one board fails
          ),
        );

        return pipe(
          Effect.all(sprintEffects, { concurrency: 3 }),
          Effect.map((sprintArrays) => {
            const allSprints = sprintArrays.flat();

            // Remove duplicates
            const uniqueSprints = Array.from(new Map(allSprints.map((s) => [s.id, s])).values());

            return uniqueSprints;
          }),
        );
      }),
    );
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
      } catch (_error) {}
    }

    // Remove duplicates
    const uniqueSprints = Array.from(new Map(allSprints.map((s) => [s.id, s])).values());

    return uniqueSprints;
  }
}
