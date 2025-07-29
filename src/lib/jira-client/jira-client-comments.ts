import { Effect, pipe } from 'effect';
import { JiraClientBase } from './jira-client-base.js';
import { AuthenticationError, NetworkError, NotFoundError, ValidationError } from './jira-client-types.js';

export class JiraClientComments extends JiraClientBase {
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
        const url = `${this.config.jiraUrl}/rest/api/2/issue/${issueKey}/comment`;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method: 'POST',
              headers: this.getHeaders(),
              body: JSON.stringify({
                body: comment,
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
   * Effect-based version of getting comments for an issue
   */
  getCommentsEffect(issueKey: string): Effect.Effect<
    Array<{
      id: string;
      author: { displayName: string; emailAddress?: string };
      body: unknown;
      created: string;
      updated: string;
      jirareactions?: Array<{
        value: string;
        users: Array<{
          displayName: string;
        }>;
        count: number;
      }>;
    }>,
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
        const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/comment`;

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
              throw new AuthenticationError(`Not authorized to view comments: ${response.status} - ${errorText}`);
            }

            if (!response.ok) {
              const errorText = await response.text();
              throw new NetworkError(`Failed to get comments: ${response.status} - ${errorText}`);
            }

            const data = (await response.json()) as {
              comments?: Array<{
                id: string;
                author: { displayName: string; emailAddress?: string };
                body: unknown;
                created: string;
                updated: string;
                jirareactions?: Array<{
                  value: string;
                  users: Array<{
                    displayName: string;
                  }>;
                  count: number;
                }>;
              }>;
            };
            return data.comments || [];
          },
          catch: (error) => {
            if (
              error instanceof NotFoundError ||
              error instanceof AuthenticationError ||
              error instanceof NetworkError
            ) {
              return error;
            }
            return new NetworkError(`Failed to fetch comments: ${error}`);
          },
        });
      }),
    );
  }

  // Backward compatible version
  async getComments(issueKey: string): Promise<
    Array<{
      id: string;
      author: { displayName: string; emailAddress?: string };
      body: unknown;
      created: string;
      updated: string;
      jirareactions?: Array<{
        value: string;
        users: Array<{
          displayName: string;
        }>;
        count: number;
      }>;
    }>
  > {
    return Effect.runPromise(this.getCommentsEffect(issueKey));
  }
}
