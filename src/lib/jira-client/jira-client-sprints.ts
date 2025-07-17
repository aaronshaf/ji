import { Effect, pipe, Schema } from 'effect';
import type { Config } from '../config.js';
import { JiraClientBase } from './jira-client-base.js';
import { JiraClientBoards } from './jira-client-boards.js';
import {
  AuthenticationError,
  type Issue,
  IssueSchema,
  NetworkError,
  type Sprint,
  SprintsResponseSchema,
  ValidationError,
} from './jira-client-types.js';

export class JiraClientSprints extends JiraClientBase {
  private boardsClient: JiraClientBoards;

  constructor(config: Config) {
    super(config);
    this.boardsClient = new JiraClientBoards(config);
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
        this.boardsClient.getUserBoardsEffect(userEmail),
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

  // Backward compatible versions
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

  async getUserActiveSprints(userEmail: string): Promise<Sprint[]> {
    // First, get all boards the user has access to
    const boards = await this.boardsClient.getUserBoards(userEmail);
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
