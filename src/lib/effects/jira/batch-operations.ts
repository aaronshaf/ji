/**
 * Jira Batch Operations Module
 * Contains all batch-related operations extracted from jira-client-service.ts
 */

import { Effect, pipe, Stream } from 'effect';
import type {
  AuthenticationError,
  ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.js';
import type { LoggerService } from '../layers.js';
import type { Issue, IssueOperations } from './issue-operations.js';

// ============= Batch Operations Interface =============
export interface BatchOperations {
  batchGetIssues(
    issueKeys: string[],
  ): Stream.Stream<
    Issue,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  batchAssignIssues(
    assignments: Array<{ issueKey: string; accountId: string }>,
  ): Effect.Effect<
    Array<{ issueKey: string; success: boolean; error?: string }>,
    ValidationError | NetworkError | AuthenticationError | TimeoutError | RateLimitError | ConfigError
  >;
}

// ============= Batch Operations Implementation =============
export class BatchOperationsImpl implements BatchOperations {
  constructor(
    private issueOperations: IssueOperations,
    private logger: LoggerService,
  ) {}

  batchGetIssues(
    issueKeys: string[],
  ): Stream.Stream<
    Issue,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  > {
    return pipe(
      Stream.fromIterable(issueKeys),
      Stream.mapEffect((issueKey) =>
        pipe(
          this.issueOperations.getIssue(issueKey),
          Effect.catchAll((error) => {
            // Log the error but don't fail the entire stream
            return pipe(
              this.logger.warn('Failed to fetch issue in batch', { issueKey, error: error.message }),
              Effect.flatMap(() => Effect.fail(error)),
            );
          }),
        ),
      ),
      Stream.rechunk(10), // Process in chunks of 10
    );
  }

  batchAssignIssues(
    assignments: Array<{ issueKey: string; accountId: string }>,
  ): Effect.Effect<
    Array<{ issueKey: string; success: boolean; error?: string }>,
    ValidationError | NetworkError | AuthenticationError
  > {
    return pipe(
      Effect.forEach(assignments, ({ issueKey, accountId }) =>
        pipe(
          this.issueOperations.assignIssue(issueKey, accountId),
          Effect.map(() => ({ issueKey, success: true as const })),
          Effect.catchAll((error) =>
            Effect.succeed({
              issueKey,
              success: false as const,
              error: error.message,
            }),
          ),
        ),
      ),
    );
  }
}
