import type { Database } from 'bun:sqlite';
import { Clock, Context, Duration, Effect, Layer, Option, pipe } from 'effect';
import { CacheCorruptedError, CacheError, DatabaseError, ValidationError } from './errors.js';

/**
 * Cache entry with TTL and metadata
 */
export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
  size: number;
  tags: string[];
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
  hitRate: number;
  memoryUsage: number;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  maxSize: number;
  defaultTtl: Duration.Duration;
  maxMemoryMb: number;
  evictionPolicy: 'lru' | 'lfu' | 'ttl';
  enableCompression: boolean;
  persistToDisk: boolean;
}

/**
 * Cache service interface
 */
export interface CacheService {
  get: <T>(key: string) => Effect.Effect<Option.Option<T>, CacheError>;
  set: <T>(key: string, value: T, ttl?: Duration.Duration, tags?: string[]) => Effect.Effect<void, CacheError>;
  delete: (key: string) => Effect.Effect<boolean, CacheError>;
  clear: () => Effect.Effect<void, CacheError>;
  invalidateByTag: (tag: string) => Effect.Effect<number, CacheError>;
  getStats: () => Effect.Effect<CacheStats, never>;
  getOrCompute: <T, E>(
    key: string,
    compute: Effect.Effect<T, E>,
    ttl?: Duration.Duration,
    tags?: string[],
  ) => Effect.Effect<T, E | CacheError>;
  warmUp: <T>(entries: Array<{ key: string; value: T; ttl?: Duration.Duration }>) => Effect.Effect<void, CacheError>;
  refresh: <T, E>(key: string, compute: Effect.Effect<T, E>) => Effect.Effect<T, E | CacheError>;
}

/**
 * Multi-tier cache implementation with L1 (memory) and L2 (disk)
 */
export class MultiTierCache implements CacheService {
  private l1Cache = new Map<string, CacheEntry<unknown>>();
  private accessOrder: string[] = [];
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    maxSize: 0,
    hitRate: 0,
    memoryUsage: 0,
  };

  constructor(
    private config: CacheConfig,
    private db?: Database, // SQLite database for L2 cache
  ) {
    this.stats.maxSize = config.maxSize;
  }

  /**
   * Get value from cache with automatic tier promotion
   */
  get<T>(key: string): Effect.Effect<Option.Option<T>, CacheError> {
    return pipe(
      Effect.sync(() => this.validateKey(key)),
      Effect.flatMap(() => this.getFromL1<T>(key)),
      Effect.flatMap((maybeValue) => (Option.isSome(maybeValue) ? Effect.succeed(maybeValue) : this.getFromL2<T>(key))),
      Effect.tap((maybeValue) => {
        if (Option.isSome(maybeValue)) {
          return this.recordHit();
        } else {
          return this.recordMiss();
        }
      }),
      Effect.mapError((error) =>
        error instanceof CacheError ? error : new CacheError(`Cache get failed: ${error}`, error),
      ),
    );
  }

  /**
   * Set value in cache with automatic tier management
   */
  set<T>(
    key: string,
    value: T,
    ttl: Duration.Duration = this.config.defaultTtl,
    tags: string[] = [],
  ): Effect.Effect<void, CacheError> {
    return pipe(
      Effect.sync(() => {
        this.validateKey(key);
        this.validateValue(value);
      }),
      Effect.flatMap(() => Clock.currentTimeMillis),
      Effect.flatMap((now) => {
        const entry: CacheEntry<T> = {
          value,
          createdAt: now,
          expiresAt: now + Duration.toMillis(ttl),
          accessCount: 0,
          lastAccessed: now,
          size: this.calculateSize(value),
          tags,
        };

        return pipe(
          this.setInL1(key, entry),
          Effect.flatMap(() => this.setInL2(key, entry)),
          Effect.flatMap(() => this.evictIfNeeded()),
        );
      }),
      Effect.mapError((error) =>
        error instanceof CacheError ? error : new CacheError(`Cache set failed: ${error}`, error),
      ),
    );
  }

  /**
   * Delete key from all cache tiers
   */
  delete(key: string): Effect.Effect<boolean, CacheError> {
    return pipe(
      Effect.sync(() => this.validateKey(key)),
      Effect.flatMap(() => {
        const existedInL1 = this.l1Cache.has(key);
        this.l1Cache.delete(key);
        this.removeFromAccessOrder(key);

        return pipe(
          this.deleteFromL2(key),
          Effect.map((existedInL2) => existedInL1 || existedInL2),
        );
      }),
      Effect.mapError((error) =>
        error instanceof CacheError ? error : new CacheError(`Cache delete failed: ${error}`, error),
      ),
    );
  }

  /**
   * Clear all cache tiers
   */
  clear(): Effect.Effect<void, CacheError> {
    return pipe(
      Effect.sync(() => {
        this.l1Cache.clear();
        this.accessOrder = [];
        this.stats.size = 0;
      }),
      Effect.flatMap(() => this.clearL2()),
      Effect.mapError((error) =>
        error instanceof CacheError ? error : new CacheError(`Cache clear failed: ${error}`, error),
      ),
    );
  }

  /**
   * Invalidate all entries with a specific tag
   */
  invalidateByTag(tag: string): Effect.Effect<number, CacheError> {
    return pipe(
      Effect.sync(() => {
        let invalidated = 0;
        const keysToDelete: string[] = [];

        for (const [key, entry] of this.l1Cache.entries()) {
          if (entry.tags.includes(tag)) {
            keysToDelete.push(key);
            invalidated++;
          }
        }

        for (const key of keysToDelete) {
          this.l1Cache.delete(key);
          this.removeFromAccessOrder(key);
        }

        return invalidated;
      }),
      Effect.flatMap((l1Invalidated) =>
        pipe(
          this.invalidateL2ByTag(tag),
          Effect.map((l2Invalidated) => l1Invalidated + l2Invalidated),
        ),
      ),
      Effect.mapError((error) =>
        error instanceof CacheError ? error : new CacheError(`Tag invalidation failed: ${error}`, error),
      ),
    );
  }

  /**
   * Get cache statistics
   */
  getStats(): Effect.Effect<CacheStats, never> {
    return Effect.sync(() => {
      this.stats.size = this.l1Cache.size;
      this.stats.hitRate =
        this.stats.hits + this.stats.misses > 0 ? this.stats.hits / (this.stats.hits + this.stats.misses) : 0;
      this.stats.memoryUsage = this.calculateMemoryUsage();

      return { ...this.stats };
    });
  }

  /**
   * Get or compute value with caching
   */
  getOrCompute<T, E>(
    key: string,
    compute: Effect.Effect<T, E>,
    ttl: Duration.Duration = this.config.defaultTtl,
    tags: string[] = [],
  ): Effect.Effect<T, E | CacheError> {
    return pipe(
      this.get<T>(key),
      Effect.flatMap((maybeValue) =>
        Option.isSome(maybeValue)
          ? Effect.succeed(maybeValue.value)
          : pipe(
              compute,
              Effect.flatMap((value) =>
                pipe(
                  this.set(key, value, ttl, tags),
                  Effect.map(() => value),
                ),
              ),
            ),
      ),
    );
  }

  /**
   * Warm up cache with multiple entries
   */
  warmUp<T>(entries: Array<{ key: string; value: T; ttl?: Duration.Duration }>): Effect.Effect<void, CacheError> {
    const warmUpEffects = entries.map((entry) => this.set(entry.key, entry.value, entry.ttl));

    return pipe(
      Effect.all(warmUpEffects, { concurrency: 10 }),
      Effect.map(() => undefined),
    );
  }

  /**
   * Refresh a cached value
   */
  refresh<T, E>(key: string, compute: Effect.Effect<T, E>): Effect.Effect<T, E | CacheError> {
    return pipe(
      this.delete(key),
      Effect.flatMap(() =>
        pipe(
          compute,
          Effect.flatMap((value) =>
            pipe(
              this.set(key, value),
              Effect.map(() => value),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * L1 Cache operations (memory)
   */
  private getFromL1<T>(key: string): Effect.Effect<Option.Option<T>, never> {
    return pipe(
      Clock.currentTimeMillis,
      Effect.map((now) => {
        const entry = this.l1Cache.get(key);

        if (!entry) {
          return Option.none<T>();
        }

        if (entry.expiresAt <= now) {
          this.l1Cache.delete(key);
          this.removeFromAccessOrder(key);
          return Option.none<T>();
        }

        // Update access statistics
        entry.accessCount++;
        entry.lastAccessed = now;
        this.updateAccessOrder(key);

        return Option.some(entry.value as T);
      }),
    );
  }

  private setInL1<T>(key: string, entry: CacheEntry<T>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.l1Cache.set(key, entry);
      this.updateAccessOrder(key);
    });
  }

  /**
   * L2 Cache operations (disk)
   */
  private getFromL2<T>(key: string): Effect.Effect<Option.Option<T>, CacheError> {
    if (!this.db || !this.config.persistToDisk) {
      return Effect.succeed(Option.none());
    }

    return Effect.tryPromise({
      try: async () => {
        if (!this.db) {
          return Option.none<T>();
        }

        const stmt = this.db.prepare('SELECT value, expires_at FROM cache_l2 WHERE key = ?');
        const row = stmt.get(key) as { value: string; expires_at: number } | undefined;

        if (!row) {
          return Option.none<T>();
        }

        const now = Date.now();
        if (row.expires_at <= now) {
          // Expired, delete it
          const deleteStmt = this.db.prepare('DELETE FROM cache_l2 WHERE key = ?');
          deleteStmt.run(key);
          return Option.none<T>();
        }

        try {
          const value = JSON.parse(row.value);

          // Promote to L1
          await this.promoteToL1(key, value, row.expires_at);

          return Option.some(value);
        } catch (parseError) {
          throw new CacheCorruptedError(`Failed to parse cached value for key ${key}`, parseError);
        }
      },
      catch: (error) => (error instanceof CacheError ? error : new CacheError(`L2 cache get failed: ${error}`, error)),
    });
  }

  private setInL2<T>(key: string, entry: CacheEntry<T>): Effect.Effect<void, CacheError> {
    if (!this.db || !this.config.persistToDisk) {
      return Effect.succeed(undefined);
    }

    return Effect.tryPromise({
      try: async () => {
        if (!this.db) {
          return;
        }

        const serializedValue = JSON.stringify(entry.value);
        const compressedValue = this.config.enableCompression ? await this.compress(serializedValue) : serializedValue;

        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO cache_l2 (key, value, expires_at, tags, size)
          VALUES (?, ?, ?, ?, ?)
        `);

        stmt.run(key, compressedValue, entry.expiresAt, JSON.stringify(entry.tags), entry.size);
      },
      catch: (error) => new CacheError(`L2 cache set failed: ${error}`, error),
    });
  }

  private deleteFromL2(key: string): Effect.Effect<boolean, CacheError> {
    if (!this.db || !this.config.persistToDisk) {
      return Effect.succeed(false);
    }

    return Effect.tryPromise({
      try: async () => {
        if (!this.db) {
          return false;
        }

        const stmt = this.db.prepare('DELETE FROM cache_l2 WHERE key = ?');
        const result = stmt.run(key);
        return result.changes > 0;
      },
      catch: (error) => new CacheError(`L2 cache delete failed: ${error}`, error),
    });
  }

  private clearL2(): Effect.Effect<void, CacheError> {
    if (!this.db || !this.config.persistToDisk) {
      return Effect.succeed(undefined);
    }

    return Effect.tryPromise({
      try: async () => {
        if (!this.db) {
          return;
        }

        const stmt = this.db.prepare('DELETE FROM cache_l2');
        stmt.run();
      },
      catch: (error) => new CacheError(`L2 cache clear failed: ${error}`, error),
    });
  }

  private invalidateL2ByTag(tag: string): Effect.Effect<number, CacheError> {
    if (!this.db || !this.config.persistToDisk) {
      return Effect.succeed(0);
    }

    return Effect.tryPromise({
      try: async () => {
        if (!this.db) {
          return 0;
        }

        const stmt = this.db.prepare(`
          DELETE FROM cache_l2 
          WHERE json_extract(tags, '$') LIKE '%' || ? || '%'
        `);
        const result = stmt.run(tag);
        return result.changes;
      },
      catch: (error) => new CacheError(`L2 tag invalidation failed: ${error}`, error),
    });
  }

  /**
   * Cache management operations
   */
  private promoteToL1<T>(key: string, value: T, expiresAt: number): Promise<void> {
    return new Promise((resolve) => {
      const now = Date.now();
      const entry: CacheEntry<T> = {
        value,
        createdAt: now,
        expiresAt,
        accessCount: 1,
        lastAccessed: now,
        size: this.calculateSize(value),
        tags: [],
      };

      this.l1Cache.set(key, entry);
      this.updateAccessOrder(key);
      resolve();
    });
  }

  private evictIfNeeded(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      while (this.shouldEvict()) {
        this.evictOne();
      }
    });
  }

  private shouldEvict(): boolean {
    return (
      this.l1Cache.size > this.config.maxSize || this.calculateMemoryUsage() > this.config.maxMemoryMb * 1024 * 1024
    );
  }

  private evictOne(): void {
    let keyToEvict: string | undefined;

    switch (this.config.evictionPolicy) {
      case 'lru':
        keyToEvict = this.accessOrder[0];
        break;
      case 'lfu':
        keyToEvict = this.findLeastFrequentlyUsed();
        break;
      case 'ttl':
        keyToEvict = this.findEarliestExpiring();
        break;
    }

    if (keyToEvict) {
      this.l1Cache.delete(keyToEvict);
      this.removeFromAccessOrder(keyToEvict);
      this.stats.evictions++;
    }
  }

  private findLeastFrequentlyUsed(): string | undefined {
    let leastUsedKey: string | undefined;
    let leastAccessCount = Infinity;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.accessCount < leastAccessCount) {
        leastAccessCount = entry.accessCount;
        leastUsedKey = key;
      }
    }

    return leastUsedKey;
  }

  private findEarliestExpiring(): string | undefined {
    let earliestKey: string | undefined;
    let earliestExpiry = Infinity;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.expiresAt < earliestExpiry) {
        earliestExpiry = entry.expiresAt;
        earliestKey = key;
      }
    }

    return earliestKey;
  }

  private updateAccessOrder(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Utility methods
   */
  private validateKey(key: string): void {
    if (!key || key.length === 0) {
      throw new ValidationError('Cache key cannot be empty', 'key', key);
    }
    if (key.length > 250) {
      throw new ValidationError('Cache key too long (max 250 chars)', 'key', key);
    }
  }

  private validateValue(value: unknown): void {
    if (value === undefined) {
      throw new ValidationError('Cache value cannot be undefined', 'value', value);
    }
  }

  private calculateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }

  private calculateMemoryUsage(): number {
    let total = 0;
    for (const entry of this.l1Cache.values()) {
      total += entry.size;
    }
    return total;
  }

  private recordHit(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.stats.hits++;
    });
  }

  private recordMiss(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.stats.misses++;
    });
  }

  private async compress(data: string): Promise<string> {
    // Simple compression - in production you'd use a real compression library
    return data;
  }
}

/**
 * Cache service context
 */
export const CacheServiceContext = Context.GenericTag<CacheService>('CacheService');

/**
 * Cache layer for dependency injection
 */
export const CacheLayer = Layer.effect(
  CacheServiceContext,
  Effect.gen(function* () {
    const config: CacheConfig = {
      maxSize: 10000,
      defaultTtl: Duration.minutes(30),
      maxMemoryMb: 100,
      evictionPolicy: 'lru',
      enableCompression: false,
      persistToDisk: true,
    };

    // Initialize L2 cache database
    const { Database } = yield* Effect.promise(() => import('bun:sqlite'));
    const { homedir } = yield* Effect.promise(() => import('node:os'));
    const { join } = yield* Effect.promise(() => import('node:path'));

    const dbPath = join(homedir(), '.ji', 'cache.db');
    const db = new Database(dbPath);

    // Create L2 cache table
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_l2 (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        tags TEXT DEFAULT '[]',
        size INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      )
    `);

    // Create indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_l2_expires 
      ON cache_l2(expires_at);
      
      CREATE INDEX IF NOT EXISTS idx_cache_l2_tags 
      ON cache_l2(tags);
    `);

    // Clean up expired entries on startup
    db.exec('DELETE FROM cache_l2 WHERE expires_at <= unixepoch() * 1000');

    return new MultiTierCache(config, db);
  }),
);

/**
 * Cache warming service for preloading frequently accessed data
 */
export class CacheWarmingService {
  constructor(private cache: CacheService) {}

  /**
   * Warm up issue cache for active projects
   */
  warmUpIssueCache(projectKeys: string[]): Effect.Effect<void, CacheError | DatabaseError> {
    return pipe(
      Effect.all(
        projectKeys.map((projectKey) => this.warmUpProjectIssues(projectKey)),
        { concurrency: 3 },
      ),
      Effect.map(() => undefined),
    );
  }

  private warmUpProjectIssues(_projectKey: string): Effect.Effect<void, CacheError | DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        // This would fetch recent issues for the project
        const recentIssues: Array<{ key: string; title: string; updated: string }> = []; // Placeholder

        const cacheEntries = recentIssues.map((issue: { key: string; title: string; updated: string }) => ({
          key: `issue:${issue.key}`,
          value: issue,
          ttl: Duration.hours(2),
        }));

        return cacheEntries;
      },
      catch: (error) => new DatabaseError(`Failed to load issues for warming: ${error}`, error),
    }).pipe(Effect.flatMap((entries) => this.cache.warmUp(entries)));
  }

  /**
   * Warm up search cache with popular queries
   */
  warmUpSearchCache(): Effect.Effect<void, CacheError> {
    const popularQueries = ['error', 'bug', 'deployment', 'configuration', 'authentication'];

    return pipe(
      Effect.all(
        popularQueries.map((query) =>
          pipe(
            this.cache.getOrCompute(`search:${query}`, this.executeSearch(query), Duration.minutes(15), [
              'search',
              'popular',
            ]),
            Effect.mapError((error) =>
              error instanceof CacheError ? error : new CacheError(`Warm up failed: ${error}`, error),
            ),
          ),
        ),
        { concurrency: 2 },
      ),
      Effect.map(() => undefined),
    );
  }

  private executeSearch(_query: string): Effect.Effect<unknown[], DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        // This would execute the actual search
        return [];
      },
      catch: (error) => new DatabaseError(`Search failed: ${error}`, error),
    });
  }
}

/**
 * Cache invalidation service for maintaining consistency
 */
export class CacheInvalidationService {
  constructor(private cache: CacheService) {}

  /**
   * Invalidate cache when issue is updated
   */
  onIssueUpdated(issueKey: string): Effect.Effect<void, CacheError> {
    return pipe(
      Effect.all([
        this.cache.delete(`issue:${issueKey}`),
        this.cache.invalidateByTag('search'),
        this.cache.invalidateByTag(`project:${issueKey.split('-')[0]}`),
      ]),
      Effect.map(() => undefined),
    );
  }

  /**
   * Invalidate cache when project is synced
   */
  onProjectSynced(projectKey: string): Effect.Effect<void, CacheError> {
    return pipe(
      this.cache.invalidateByTag(`project:${projectKey}`),
      Effect.map(() => undefined),
    );
  }

  /**
   * Scheduled cache cleanup
   */
  scheduledCleanup(): Effect.Effect<void, CacheError> {
    return pipe(
      this.cache.invalidateByTag('temporary'),
      Effect.flatMap(() => this.cleanupExpiredEntries()),
    );
  }

  private cleanupExpiredEntries(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // The cache automatically handles expired entries,
      // but we could add additional cleanup logic here
    });
  }
}

/**
 * Create cache service with proper configuration
 */
export function createCacheService(): Effect.Effect<CacheService, DatabaseError> {
  return pipe(
    CacheLayer,
    Layer.build,
    Effect.scoped,
    Effect.map((context) => Context.get(context, CacheServiceContext)),
    Effect.mapError((error) => new DatabaseError(`Failed to create cache service: ${error}`, error)),
  );
}
