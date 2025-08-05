import { Effect, pipe, Schema } from 'effect';
import { JiraClientBase } from './jira-client-base.js';
import {
  AuthenticationError,
  ISSUE_FIELDS,
  type Issue,
  IssueSchema,
  NetworkError,
  NotFoundError,
  SearchResultSchema,
  ValidationError,
} from './jira-client-types.js';

export class JiraClientIssues extends JiraClientBase {
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
        fields: ISSUE_FIELDS,
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
          this.searchIssuesEffect(searchJql, { startAt: 0, maxResults: 1, fields: ISSUE_FIELDS }),
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
                  fields: ISSUE_FIELDS,
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

  /**
   * Effect-based assign issue
   */
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
}
