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

/**
 * Read-only operations for Jira issues
 * Handles fetching, searching, and retrieving issue data
 */
export class JiraClientIssuesRead extends JiraClientBase {
  /**
   * Fetch a single issue by key
   *
   * @remarks
   * This method delegates to getIssueEffect for consistent error handling.
   * Consider using getIssueEffect directly for better error type discrimination.
   */
  async getIssue(issueKey: string): Promise<Issue> {
    return Effect.runPromise(this.getIssueEffect(issueKey));
  }

  /**
   * Search for issues using JQL (Jira Query Language)
   *
   * @remarks
   * **Migration Note**: This method now uses the `/rest/api/3/search/jql` endpoint
   * (migrated from deprecated `/rest/api/3/search`). Key differences:
   * - `total` field may be undefined in response (falls back to issue count)
   * - Fields parameter is now required (defaults to *navigable if not specified)
   * - Empty `fields` array will be replaced with defaults to avoid API errors
   *
   * This method delegates to searchIssuesEffect for consistent error handling.
   * Consider using searchIssuesEffect directly for better error type discrimination.
   *
   * @param jql - JQL query string
   * @param options - Search options including pagination and field selection
   * @returns Search results with issues array, total count (or fallback), and startAt position
   */
  async searchIssues(
    jql: string,
    options?: {
      startAt?: number;
      maxResults?: number;
      fields?: string[];
    },
  ): Promise<{ issues: Issue[]; total: number; startAt: number }> {
    return Effect.runPromise(this.searchIssuesEffect(jql, options));
  }

  /**
   * Get all issues for a project with pagination
   *
   * @remarks
   * This method delegates to getAllProjectIssuesEffect for consistent error handling.
   * Consider using getAllProjectIssuesEffect directly for better error type discrimination
   * and concurrent fetching performance.
   */
  async getAllProjectIssues(
    projectKey: string,
    onProgress?: (current: number, total: number) => void,
    jql?: string,
  ): Promise<Issue[]> {
    return Effect.runPromise(
      this.getAllProjectIssuesEffect(projectKey, {
        jql,
        onProgress,
      }),
    );
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
            // Type assertion needed: Schema.decodeUnknownSync returns readonly types
            // which don't match our mutable Issue type. The schema validation ensures
            // the data structure is correct.
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
   *
   * @remarks
   * **Migration Note**: This method now uses the `/rest/api/3/search/jql` endpoint
   * (migrated from deprecated `/rest/api/3/search`). Key differences:
   * - `total` field may be undefined in response (falls back to issue count)
   * - Fields parameter is now required (defaults to *navigable if not specified)
   * - Empty `fields` array will be replaced with defaults to avoid API errors
   *
   * @param jql - JQL query string
   * @param options - Search options including pagination and field selection
   * @returns Effect yielding search results or structured errors
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
          fields: options?.fields ? options.fields.join(',') : '*navigable',
        });

        const url = `${this.config.jiraUrl}/rest/api/3/search/jql?${params}`;

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

            // Type assertion needed: Schema.decodeUnknownSync returns readonly arrays
            // which don't match our mutable Issue[] type. The schema validation ensures
            // the data structure is correct.
            return {
              issues: result.issues as Issue[],
              total: result.total ?? result.issues.length,
              startAt: result.startAt ?? options?.startAt ?? 0,
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
   *
   * @remarks
   * **Pagination Strategy**: This implementation uses offset-based pagination (startAt/maxResults).
   * With concurrent fetching, if issues are added/removed mid-fetch, there's a potential for
   * inconsistencies.
   *
   * **Future Enhancement**: Consider implementing cursor-based pagination using `nextPageToken`
   * when available from the API for more reliable pagination in high-churn environments:
   * ```typescript
   * if (result.nextPageToken) {
   *   // Use cursor instead of offset for next page
   * }
   * ```
   *
   * For most use cases, the current offset-based approach with controlled concurrency (default: 3)
   * provides good performance without consistency issues.
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

  // Backward compatible version
  async getIssueTransitions(issueKey: string): Promise<Array<{ id: string; name: string }>> {
    return Effect.runPromise(this.getIssueTransitionsEffect(issueKey));
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
