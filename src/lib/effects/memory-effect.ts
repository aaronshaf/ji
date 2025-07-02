import { Effect, Option, pipe } from 'effect';
import { DatabaseError, NotFoundError, ValidationError } from './errors';

/**
 * Effect-based memory operations
 * Demonstrates validation, Option types, and explicit error handling
 */

export class HashError extends Error {
  readonly _tag = 'HashError';
}

/**
 * Hash a question for memory lookup with validation
 */
export const hashQuestion = (question: string): Effect.Effect<string, ValidationError> => {
  return pipe(
    Effect.sync(() => {
      if (!question || question.trim().length === 0) {
        throw new ValidationError('Question cannot be empty');
      }

      const normalized = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const words = normalized.split(' ').filter((w) => w.length > 2);

      if (words.length === 0) {
        throw new ValidationError('Question must contain at least one word with 3+ characters');
      }

      const keyWords = words.sort().slice(0, 5);
      return keyWords.join('_');
    }),
    Effect.mapError((error: unknown) =>
      error instanceof ValidationError
        ? error
        : new ValidationError('Failed to hash question', undefined, undefined, error),
    ),
  );
};

/**
 * Check if a fact contains uncertainty markers
 */
export const containsUncertainty = (fact: string): Effect.Effect<boolean, ValidationError> => {
  return Effect.sync(() => {
    if (!fact) {
      throw new ValidationError('Fact cannot be empty');
    }

    const uncertaintyPatterns = [
      /\b(might|maybe|possibly|could|unclear|uncertain|seems?|appears?|probably|likely)\b/i,
      /\b(not sure|unsure|don't know|unknown|varies|depends)\b/i,
      /\b(approximately|roughly|about|around|nearly)\b/i,
      /\?+\s*$/,
    ];

    return uncertaintyPatterns.some((pattern) => pattern.test(fact));
  });
};

/**
 * Delete memory with detailed result information
 */
export const deleteMemory = (
  db: {
    prepare: (sql: string) => {
      run: (...params: unknown[]) => { changes: number };
      get: (...params: unknown[]) => unknown;
    };
  },
  memoryId: string,
): Effect.Effect<{ deleted: boolean; memoryId: string }, DatabaseError | NotFoundError> => {
  return pipe(
    // Validate input
    Effect.sync(() => {
      if (!memoryId || memoryId.trim().length === 0) {
        throw new ValidationError('Memory ID cannot be empty');
      }
    }),
    // Check if memory exists
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: async () => {
          const checkStmt = db.prepare('SELECT id FROM ask_memory WHERE id = ?');
          const exists = checkStmt.get(memoryId);
          return !!exists;
        },
        catch: (error) => new DatabaseError('Failed to check memory existence', error),
      }),
    ),
    // Fail if not found
    Effect.filterOrFail(
      (exists) => exists,
      () => new NotFoundError(`Memory ${memoryId} not found`),
    ),
    // Delete the memory
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: async () => {
          const stmt = db.prepare('DELETE FROM ask_memory WHERE id = ?');
          const result = stmt.run(memoryId);
          return { deleted: result.changes > 0, memoryId };
        },
        catch: (error) => new DatabaseError(`Failed to delete memory ${memoryId}`, error),
      }),
    ),
  );
};

/**
 * Update memory facts with validation
 */
export const updateMemoryFacts = (
  db: {
    prepare: (sql: string) => {
      run: (...params: unknown[]) => { changes: number };
      get: (...params: unknown[]) => unknown;
    };
  },
  memoryId: string,
  newFacts: string,
): Effect.Effect<{ updated: boolean; rowsChanged: number }, DatabaseError | ValidationError> => {
  return pipe(
    // Validate inputs
    Effect.sync(() => {
      if (!memoryId || memoryId.trim().length === 0) {
        throw new ValidationError('Memory ID cannot be empty');
      }
      if (!newFacts || newFacts.trim().length === 0) {
        throw new ValidationError('Facts cannot be empty');
      }
      if (newFacts.length > 10000) {
        throw new ValidationError('Facts too long (max 10000 chars)');
      }
    }),
    // Update the memory
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: async () => {
          const stmt = db.prepare(`
            UPDATE ask_memory 
            SET facts = ?, updated_at = ? 
            WHERE id = ?
          `);
          const result = stmt.run(newFacts, Date.now(), memoryId);
          return {
            updated: result.changes > 0,
            rowsChanged: result.changes,
          };
        },
        catch: (error) => new DatabaseError(`Failed to update memory ${memoryId}`, error),
      }),
    ),
  );
};

/**
 * Extract description with proper error handling
 */
export const extractDescription = (description: unknown): Effect.Effect<Option.Option<string>, never> => {
  return Effect.sync(() => {
    if (typeof description === 'string' && description.trim().length > 0) {
      return Option.some(description);
    }

    if (
      typeof description === 'object' &&
      description !== null &&
      'content' in description &&
      typeof (description as { content: unknown }).content === 'object'
    ) {
      // Would need ADF parser here
      return Option.some('[Complex content - ADF format]');
    }

    return Option.none();
  });
};
