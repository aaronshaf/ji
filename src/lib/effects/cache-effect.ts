import { Effect, Option, pipe } from 'effect';
import type { CacheManager } from '../cache';
import type { Issue } from '../jira-client';
import { DatabaseError, NotFoundError, type ParseError } from './errors';

/**
 * Effect-based wrapper for CacheManager operations
 * Provides type-safe error handling and composability
 */
export class CacheEffect {
  constructor(private cache: CacheManager) {}

  /**
   * Get an issue from the cache with proper error handling
   */
  getIssue(key: string): Effect.Effect<Issue, DatabaseError | ParseError | NotFoundError> {
    return pipe(
      // Use the public getIssue method instead of accessing db directly
      Effect.tryPromise({
        try: async () => await this.cache.getIssue(key),
        catch: (error) => new DatabaseError(`Database error while fetching issue ${key}`, error),
      }),
      Effect.filterOrFail(
        (issue): issue is Issue => issue !== null,
        () => new NotFoundError(`Issue ${key} not found in cache`),
      ),
    );
  }

  /**
   * Get an issue as an Option (no error for not found)
   */
  getIssueOption(key: string): Effect.Effect<Option.Option<Issue>, DatabaseError | ParseError> {
    return pipe(
      this.getIssue(key),
      Effect.map(Option.some),
      Effect.catchTag('NotFoundError', () => Effect.succeed(Option.none())),
    );
  }

  /**
   * Save an issue to the cache
   */
  saveIssue(issue: Issue): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        await this.cache.saveIssue(issue);
      },
      catch: (error) => new DatabaseError(`Failed to save issue ${issue.key}`, error),
    });
  }

  /**
   * Delete project issues with proper error handling
   */
  deleteProjectIssues(projectKey: string): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        await this.cache.deleteProjectIssues(projectKey);
      },
      catch: (error) => new DatabaseError(`Failed to delete issues for project ${projectKey}`, error),
    });
  }

  /**
   * Get issue update range for a project
   */
  getIssueUpdateRange(projectKey: string): Effect.Effect<
    {
      newest: string | null;
      oldest: string | null;
    },
    DatabaseError
  > {
    return Effect.tryPromise({
      try: async () => {
        return await this.cache.getIssueUpdateRange(projectKey);
      },
      catch: (error) => new DatabaseError(`Failed to get update range for project ${projectKey}`, error),
    });
  }

  /**
   * Get multiple issues by keys (batch operation)
   */
  getIssues(keys: string[]): Effect.Effect<Issue[], DatabaseError | ParseError> {
    return pipe(
      keys,
      Effect.forEach(
        (key) =>
          pipe(
            this.getIssueOption(key),
            Effect.map(Option.getOrNull),
            Effect.map((issue) => (issue ? [issue] : [])),
          ),
        { concurrency: 10 }, // Process up to 10 issues in parallel
      ),
      Effect.map((results) => results.flat()),
    );
  }

  /**
   * Check if an issue exists in cache
   */
  hasIssue(key: string): Effect.Effect<boolean, never> {
    return pipe(
      this.getIssue(key),
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
  }
}

/**
 * Create a CacheEffect instance from a CacheManager
 */
export const makeCacheEffect = (cache: CacheManager) => new CacheEffect(cache);
