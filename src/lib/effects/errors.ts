/**
 * Error hierarchy for Effect-based code
 * These errors provide better type safety and error handling
 */

export abstract class JiError extends Error {
  abstract readonly _tag: string;
  abstract readonly module: string;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ============= Database Errors =============
export class QueryError extends JiError {
  readonly _tag = 'QueryError';
  readonly module = 'database';
}

export class DatabaseError extends QueryError {
  readonly _tag = 'QueryError'; // Use parent tag for type compatibility
  readonly module = 'database';
}

export class ConnectionError extends QueryError {
  readonly _tag = 'QueryError'; // Use parent tag for type compatibility
  readonly module = 'database';
}

export class TransactionError extends QueryError {
  readonly _tag = 'QueryError'; // Use parent tag for type compatibility
  readonly module = 'database';
}

// ============= Cache Errors =============
export class CacheError extends JiError {
  readonly _tag = 'CacheError';
  readonly module = 'cache';
}

export class CacheCorruptedError extends JiError {
  readonly _tag = 'CacheCorruptedError';
  readonly module = 'cache';
}

// ============= Network Errors =============
export class NetworkError extends JiError {
  readonly _tag = 'NetworkError';
  readonly module = 'network';
}

export class TimeoutError extends JiError {
  readonly _tag = 'TimeoutError';
  readonly module = 'network';
}

export class RateLimitError extends JiError {
  readonly _tag = 'RateLimitError';
  readonly module = 'network';

  constructor(
    message: string,
    public readonly retryAfter?: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class ConnectionRefusedError extends JiError {
  readonly _tag = 'ConnectionRefusedError';
  readonly module = 'network';

  constructor(
    message: string,
    public readonly host?: string,
    public readonly port?: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class CircuitBreakerError extends JiError {
  readonly _tag = 'CircuitBreakerError';
  readonly module = 'network';
}

// ============= Data Integrity Errors =============
export class DataIntegrityError extends JiError {
  readonly _tag = 'DataIntegrityError';
  readonly module = 'data';

  constructor(
    message: string,
    public readonly expectedChecksum?: string,
    public readonly actualChecksum?: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class ConcurrencyError extends JiError {
  readonly _tag = 'ConcurrencyError';
  readonly module = 'data';

  constructor(
    message: string,
    public readonly resourceId?: string,
    public readonly conflictingOperation?: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

// ============= Validation Errors =============
export class ValidationError extends JiError {
  readonly _tag = 'ValidationError';
  readonly module = 'validation';

  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class ParseError extends JiError {
  readonly _tag = 'ParseError';
  readonly module = 'validation';

  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

// ============= Configuration Errors =============
export class ConfigError extends JiError {
  readonly _tag = 'ConfigError';
  readonly module = 'config';
}

// ============= Not Found Errors =============
export class NotFoundError extends JiError {
  readonly _tag = 'NotFoundError';
  readonly module = 'general';
}

// ============= External Service Errors =============
export class JiraError extends JiError {
  readonly _tag = 'JiraError';
  readonly module = 'jira';
}

export class ConfluenceError extends JiError {
  readonly _tag = 'ConfluenceError';
  readonly module = 'confluence';
}

export class SpaceNotFoundError extends JiError {
  readonly _tag = 'SpaceNotFoundError';
  readonly module = 'confluence';
}

export class PageNotFoundError extends JiError {
  readonly _tag = 'PageNotFoundError';
  readonly module = 'confluence';
}

export class AuthenticationError extends JiError {
  readonly _tag = 'AuthenticationError';
  readonly module = 'auth';
}

export class OllamaError extends JiError {
  readonly _tag = 'OllamaError';
  readonly module = 'ollama';
}

// ============= Content Errors =============
export class ContentError extends JiError {
  readonly _tag = 'ContentError';
  readonly module = 'content';
}

export class ContentTooLargeError extends JiError {
  readonly _tag = 'ContentTooLargeError';
  readonly module = 'content';

  constructor(
    message: string,
    public readonly size: number,
    public readonly maxSize: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

// ============= Error Recovery Strategies =============
import { Effect, pipe, Schedule } from 'effect';

export const errorRecoveryStrategies = {
  // Network errors: Retry with exponential backoff
  network: {
    timeout: Schedule.exponential('1 second', 2).pipe(Schedule.jittered),
    rateLimit: (error: RateLimitError) =>
      error.retryAfter ? Schedule.spaced(`${error.retryAfter} millis`) : Schedule.exponential('5 seconds'),
    connectionRefused: Schedule.recurs(3).pipe(Schedule.addDelay(() => '2 seconds')),
  },

  // Database errors: Limited retries with delay
  database: {
    connection: Schedule.recurs(5).pipe(Schedule.addDelay(() => '500 millis')),
    transaction: Schedule.recurs(3).pipe(Schedule.addDelay(() => '100 millis')),
    query: Schedule.once,
  },

  // Data integrity: No retry, requires manual intervention
  dataIntegrity: {
    integrity: Schedule.stop,
    concurrency: Schedule.recurs(3).pipe(Schedule.addDelay(() => '50 millis')),
  },

  // Validation errors: No retry
  validation: {
    all: Schedule.stop,
  },
};

// Helper function to apply appropriate retry strategy
export function withRetryStrategy<R, E extends JiError, A>(effect: Effect.Effect<R, E, A>): Effect.Effect<R, E, A> {
  return pipe(
    effect,
    Effect.catchAll((error: E) => {
      let retrySchedule: Schedule.Schedule<unknown, E, never> = Schedule.stop;

      switch (error.module) {
        case 'network':
          if (error._tag === 'TimeoutError') {
            retrySchedule = errorRecoveryStrategies.network.timeout;
          } else if (error._tag === 'RateLimitError') {
            retrySchedule = errorRecoveryStrategies.network.rateLimit(error as RateLimitError);
          } else if (error._tag === 'ConnectionRefusedError') {
            retrySchedule = errorRecoveryStrategies.network.connectionRefused;
          }
          break;
        case 'database':
          if (error._tag === 'ConnectionError') {
            retrySchedule = errorRecoveryStrategies.database.connection;
          } else if (error._tag === 'TransactionError') {
            retrySchedule = errorRecoveryStrategies.database.transaction;
          }
          break;
        case 'data':
          if (error._tag === 'ConcurrencyError') {
            retrySchedule = errorRecoveryStrategies.dataIntegrity.concurrency;
          }
          break;
      }

      return pipe(
        effect,
        Effect.retry(retrySchedule),
        Effect.catchAll(() => Effect.fail(error)),
      );
    }),
  );
}
