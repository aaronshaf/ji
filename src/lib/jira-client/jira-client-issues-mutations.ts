import { Effect, pipe } from 'effect';
import { JiraClientBase } from './jira-client-base.js';
import { AuthenticationError, NetworkError, NotFoundError, ValidationError } from './jira-client-types.js';

/**
 * Mutation operations for Jira issues
 * Handles updating, transitioning, and assigning issues
 */
export class JiraClientIssuesMutations extends JiraClientBase {
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
    getTransitions: (
      key: string,
    ) => Effect.Effect<
      Array<{ id: string; name: string }>,
      ValidationError | NotFoundError | NetworkError | AuthenticationError
    >,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return pipe(
      getTransitions(issueKey),
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
  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await Effect.runPromise(this.transitionIssueEffect(issueKey, transitionId));
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
}
