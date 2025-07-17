import { Effect } from 'effect';
import { JiraClientBase } from './jira-client-base.js';
import { AuthenticationError, NetworkError } from './jira-client-types.js';

export class JiraClientUsers extends JiraClientBase {
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
}
