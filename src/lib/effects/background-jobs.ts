import { Effect, Schedule, Layer, Context, pipe, Duration, Option } from 'effect';
import {
  DatabaseError,
  ValidationError,
  ConfigError
} from './errors.js';
import type { Config } from '../config.js';

/**
 * Job types for the background job system
 */
export type JobType = 
  | 'sync-jira-project'
  | 'sync-confluence-space'
  | 'refresh-issue'
  | 'index-to-meilisearch'
  | 'cleanup-cache'
  | 'refresh-boards'
  | 'update-search-index';

/**
 * Job priority levels
 */
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Job definition interface
 */
export interface Job {
  id: string;
  type: JobType;
  priority: JobPriority;
  payload: Record<string, unknown>;
  createdAt: number;
  scheduledFor?: number;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
}

/**
 * Job execution result
 */
export interface JobResult {
  success: boolean;
  duration: number;
  result?: unknown;
  error?: string;
}

/**
 * Job queue service
 */
export interface JobQueueService {
  enqueue: (job: Omit<Job, 'id' | 'createdAt' | 'retryCount'>) => Effect.Effect<string, DatabaseError>;
  dequeue: (type?: JobType) => Effect.Effect<Option.Option<Job>, DatabaseError>;
  markCompleted: (jobId: string, result: JobResult) => Effect.Effect<void, DatabaseError>;
  markFailed: (jobId: string, error: string) => Effect.Effect<void, DatabaseError>;
  reschedule: (jobId: string, delayMs: number) => Effect.Effect<void, DatabaseError>;
  getStats: () => Effect.Effect<JobQueueStats, DatabaseError>;
}

export interface JobQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  retrying: number;
}

/**
 * Job queue implementation using SQLite
 */
export class SqliteJobQueue implements JobQueueService {
  constructor(private db: any) {}

  enqueue(job: Omit<Job, 'id' | 'createdAt' | 'retryCount'>): Effect.Effect<string, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        
        const stmt = this.db.prepare(`
          INSERT INTO job_queue (
            id, type, priority, payload, created_at, 
            scheduled_for, retry_count, max_retries, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
          jobId,
          job.type,
          job.priority,
          JSON.stringify(job.payload),
          now,
          job.scheduledFor || now,
          0,
          job.maxRetries || 3,
          'pending'
        );
        
        return jobId;
      },
      catch: (error) => new DatabaseError(`Failed to enqueue job: ${error}`, error)
    });
  }

  dequeue(type?: JobType): Effect.Effect<Option.Option<Job>, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const now = Date.now();
        let sql = `
          SELECT * FROM job_queue 
          WHERE status = 'pending' 
          AND scheduled_for <= ?
        `;
        const params: any[] = [now];
        
        if (type) {
          sql += ' AND type = ?';
          params.push(type);
        }
        
        sql += ' ORDER BY priority DESC, created_at ASC LIMIT 1';
        
        const stmt = this.db.prepare(sql);
        const row = stmt.get(...params) as any;
        
        if (!row) {
          return Option.none();
        }
        
        // Mark as running
        const updateStmt = this.db.prepare(
          'UPDATE job_queue SET status = ?, started_at = ? WHERE id = ?'
        );
        updateStmt.run('running', now, row.id);
        
        return Option.some({
          id: row.id,
          type: row.type as JobType,
          priority: row.priority as JobPriority,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at,
          scheduledFor: row.scheduled_for,
          retryCount: row.retry_count,
          maxRetries: row.max_retries,
          lastError: row.last_error
        });
      },
      catch: (error) => new DatabaseError(`Failed to dequeue job: ${error}`, error)
    });
  }

  markCompleted(jobId: string, result: JobResult): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const stmt = this.db.prepare(`
          UPDATE job_queue 
          SET status = 'completed', completed_at = ?, duration_ms = ?, result = ?
          WHERE id = ?
        `);
        
        stmt.run(
          Date.now(),
          result.duration,
          JSON.stringify(result.result),
          jobId
        );
      },
      catch: (error) => new DatabaseError(`Failed to mark job completed: ${error}`, error)
    });
  }

  markFailed(jobId: string, error: string): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const stmt = this.db.prepare(`
          UPDATE job_queue 
          SET status = 'failed', completed_at = ?, last_error = ?
          WHERE id = ?
        `);
        
        stmt.run(Date.now(), error, jobId);
      },
      catch: (dbError) => new DatabaseError(`Failed to mark job failed: ${dbError}`, dbError)
    });
  }

  reschedule(jobId: string, delayMs: number): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const newScheduledTime = Date.now() + delayMs;
        
        const stmt = this.db.prepare(`
          UPDATE job_queue 
          SET status = 'pending', scheduled_for = ?, retry_count = retry_count + 1
          WHERE id = ?
        `);
        
        stmt.run(newScheduledTime, jobId);
      },
      catch: (error) => new DatabaseError(`Failed to reschedule job: ${error}`, error)
    });
  }

  getStats(): Effect.Effect<JobQueueStats, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const stmt = this.db.prepare(`
          SELECT status, COUNT(*) as count 
          FROM job_queue 
          GROUP BY status
        `);
        
        const rows = stmt.all() as Array<{ status: string; count: number }>;
        
        const stats: JobQueueStats = {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          retrying: 0
        };
        
        for (const row of rows) {
          switch (row.status) {
            case 'pending':
              stats.pending = row.count;
              break;
            case 'running':
              stats.running = row.count;
              break;
            case 'completed':
              stats.completed = row.count;
              break;
            case 'failed':
              stats.failed = row.count;
              break;
            case 'retrying':
              stats.retrying = row.count;
              break;
          }
        }
        
        return stats;
      },
      catch: (error) => new DatabaseError(`Failed to get job stats: ${error}`, error)
    });
  }
}

/**
 * Job queue context
 */
export const JobQueueServiceContext = Context.GenericTag<JobQueueService>('JobQueueService');

/**
 * Job queue layer for dependency injection
 */
export const JobQueueLayer = Layer.effect(
  JobQueueServiceContext,
  Effect.gen(function* () {
    const { Database } = yield* Effect.promise(() => import('bun:sqlite'));
    const { homedir } = yield* Effect.promise(() => import('os'));
    const { join } = yield* Effect.promise(() => import('path'));
    
    const dbPath = join(homedir(), '.ji', 'data.db');
    const db = new Database(dbPath);
    
    // Create job queue table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        scheduled_for INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        status TEXT DEFAULT 'pending',
        duration_ms INTEGER,
        result TEXT,
        last_error TEXT
      )
    `);
    
    // Create indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled 
      ON job_queue(status, scheduled_for);
      
      CREATE INDEX IF NOT EXISTS idx_job_queue_type 
      ON job_queue(type);
      
      CREATE INDEX IF NOT EXISTS idx_job_queue_priority 
      ON job_queue(priority, created_at);
    `);
    
    return new SqliteJobQueue(db);
  })
);

/**
 * Job worker that processes jobs from the queue
 */
export class JobWorker {
  private isRunning = false;
  private processingJob: Job | null = null;

  constructor(
    private jobQueue: JobQueueService,
    private config: Config,
    private workerName: string = 'default'
  ) {}

  /**
   * Start the job worker
   */
  start(): Effect.Effect<void, never> {
    const self = this;
    return Effect.gen(function* () {
      self.isRunning = true;
      console.log(`Job worker ${self.workerName} starting...`);
      
      yield* self.processJobsLoop();
    });
  }

  /**
   * Stop the job worker gracefully
   */
  stop(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(`Job worker ${this.workerName} stopping...`);
      this.isRunning = false;
    });
  }

  /**
   * Main job processing loop
   */
  private processJobsLoop(): Effect.Effect<void, never> {
    const self = this;
    return Effect.gen(function* () {
      while (self.isRunning) {
        try {
          const maybeJob = yield* Effect.catchAll(
            self.jobQueue.dequeue(), 
            (error) => {
              console.error('Error dequeuing job:', error);
              return Effect.succeed(Option.none());
            }
          );
          
          if (Option.isSome(maybeJob)) {
            const job = maybeJob.value;
            self.processingJob = job;
            
            console.log(`Processing job ${job.id} (${job.type})`);
            
            const startTime = Date.now();
            const result = yield* self.executeJob(job);
            const duration = Date.now() - startTime;
            
            if (result.success) {
              yield* Effect.catchAll(
                self.jobQueue.markCompleted(job.id, {
                  ...result,
                  duration
                }),
                (error) => {
                  console.error(`Failed to mark job ${job.id} as completed:`, error);
                  return Effect.succeed(undefined);
                }
              );
            } else {
              if (job.retryCount < job.maxRetries) {
                // Exponential backoff: 1s, 2s, 4s, 8s...
                const delayMs = Math.pow(2, job.retryCount) * 1000;
                yield* Effect.catchAll(
                  self.jobQueue.reschedule(job.id, delayMs),
                  (error) => {
                    console.error(`Failed to reschedule job ${job.id}:`, error);
                    return Effect.succeed(undefined);
                  }
                );
                console.log(`Job ${job.id} failed, retrying in ${delayMs}ms`);
              } else {
                yield* Effect.catchAll(
                  self.jobQueue.markFailed(job.id, result.error || 'Unknown error'),
                  (error) => {
                    console.error(`Failed to mark job ${job.id} as failed:`, error);
                    return Effect.succeed(undefined);
                  }
                );
                console.error(`Job ${job.id} failed permanently: ${result.error}`);
              }
            }
            
            self.processingJob = null;
          } else {
            // No jobs available, wait a bit
            yield* Effect.sleep(Duration.millis(1000));
          }
        } catch (error) {
          console.error('Unexpected error in job processing loop:', error);
          yield* Effect.sleep(Duration.millis(1000));
        }
      }
    });
  }

  /**
   * Execute a specific job
   */
  private executeJob(job: Job): Effect.Effect<JobResult, never> {
    return pipe(
      this.getJobExecutor(job.type),
      Effect.flatMap(executor => executor(job.payload, this.config)),
      Effect.map(result => ({
        success: true,
        duration: 0, // Will be set by caller
        result
      })),
      Effect.catchAll(error => 
        Effect.succeed({
          success: false,
          duration: 0,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    );
  }

  /**
   * Get job executor function based on job type
   */
  private getJobExecutor(type: JobType): Effect.Effect<
    (payload: Record<string, unknown>, config: Config) => Effect.Effect<unknown, Error>,
    ValidationError
  > {
    return Effect.sync(() => {
      switch (type) {
        case 'sync-jira-project':
          return this.syncJiraProject.bind(this);
        case 'sync-confluence-space':
          return this.syncConfluenceSpace.bind(this);
        case 'refresh-issue':
          return this.refreshIssue.bind(this);
        case 'index-to-meilisearch':
          return this.indexToMeilisearch.bind(this);
        case 'cleanup-cache':
          return this.cleanupCache.bind(this);
        case 'refresh-boards':
          return this.refreshBoards.bind(this);
        case 'update-search-index':
          return this.updateSearchIndex.bind(this);
        default:
          throw new ValidationError(`Unknown job type: ${type}`, 'type', type);
      }
    });
  }

  /**
   * Job executors for different job types
   */
  private syncJiraProject(payload: Record<string, unknown>, config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { projectKey } = payload;
        if (typeof projectKey !== 'string') {
          throw new Error('Missing or invalid projectKey');
        }
        
        const { JiraClient } = await import('../jira-client.js');
        const { CacheManager } = await import('../cache.js');
        
        const jiraClient = new JiraClient(config);
        const cache = new CacheManager();
        
        try {
          const searchResult = await jiraClient.searchIssues(`project = "${projectKey}"`, { maxResults: 1000 });
          
          for (const issue of searchResult.issues) {
            cache.saveIssue(issue);
          }
          
          return { projectKey, synced: searchResult.issues.length };
        } finally {
          cache.close();
        }
      },
      catch: (error) => new Error(`Sync Jira project failed: ${error}`)
    });
  }

  private syncConfluenceSpace(payload: Record<string, unknown>, config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { spaceKey } = payload;
        if (typeof spaceKey !== 'string') {
          throw new Error('Missing or invalid spaceKey');
        }
        
        const { ConfluenceClient } = await import('../confluence-client.js');
        const { ContentManager } = await import('../content-manager.js');
        
        const confluenceClient = new ConfluenceClient(config);
        const contentManager = new ContentManager();
        
        try {
          const pages = await confluenceClient.getAllSpacePages(spaceKey);
          
          for (const page of pages) {
            await contentManager.saveContent({
              id: `confluence:${page.id}`,
              source: 'confluence',
              type: 'page',
              title: page.title,
              content: page.body?.storage?.value || '',
              url: page._links.webui,
              spaceKey: page.space.key,
              createdAt: Date.now(),
              updatedAt: new Date(page.version.when).getTime(),
              syncedAt: Date.now()
            });
          }
          
          return { spaceKey, synced: pages.length };
        } finally {
          contentManager.close();
        }
      },
      catch: (error) => new Error(`Sync Confluence space failed: ${error}`)
    });
  }

  private refreshIssue(payload: Record<string, unknown>, config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { issueKey } = payload;
        if (typeof issueKey !== 'string') {
          throw new Error('Missing or invalid issueKey');
        }
        
        const { JiraClient } = await import('../jira-client.js');
        const { CacheManager } = await import('../cache.js');
        
        const jiraClient = new JiraClient(config);
        const cache = new CacheManager();
        
        try {
          const issue = await jiraClient.getIssue(issueKey);
          if (issue) {
            cache.saveIssue(issue);
            return { issueKey, refreshed: true };
          } else {
            throw new Error(`Issue ${issueKey} not found`);
          }
        } finally {
          cache.close();
        }
      },
      catch: (error) => new Error(`Refresh issue failed: ${error}`)
    });
  }

  private indexToMeilisearch(payload: Record<string, unknown>, _config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { contentIds } = payload;
        if (!Array.isArray(contentIds)) {
          throw new Error('Missing or invalid contentIds array');
        }
        
        const { ContentManager } = await import('../content-manager.js');
        const { MeilisearchAdapter } = await import('../meilisearch-adapter.js');
        
        const contentManager = new ContentManager();
        new MeilisearchAdapter();
        
        try {
          let indexed = 0;
          for (const _contentId of contentIds) {
            // This would need a method to get content by ID
            // For now, we'll simulate indexing
            indexed++;
          }
          
          return { indexed };
        } finally {
          contentManager.close();
        }
      },
      catch: (error) => new Error(`Index to Meilisearch failed: ${error}`)
    });
  }

  private cleanupCache(payload: Record<string, unknown>, _config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { olderThanDays = 30 } = payload;
        const cutoffTime = Date.now() - (Number(olderThanDays) * 24 * 60 * 60 * 1000);
        
        const { CacheManager } = await import('../cache.js');
        const cache = new CacheManager();
        
        try {
          // This would need cleanup methods on CacheManager
          const cleaned = 0; // Placeholder
          return { cleaned, cutoffTime };
        } finally {
          cache.close();
        }
      },
      catch: (error) => new Error(`Cache cleanup failed: ${error}`)
    });
  }

  private refreshBoards(payload: Record<string, unknown>, _config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { projectKey } = payload;
        if (typeof projectKey !== 'string') {
          throw new Error('Missing or invalid projectKey');
        }
        
        // Board refresh logic would go here
        return { projectKey, refreshed: true };
      },
      catch: (error) => new Error(`Refresh boards failed: ${error}`)
    });
  }

  private updateSearchIndex(payload: Record<string, unknown>, _config: Config): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const { force = false } = payload;
        
        // Search index update logic would go here
        return { updated: true, force };
      },
      catch: (error) => new Error(`Update search index failed: ${error}`)
    });
  }
}

/**
 * Background sync scheduler using Effect.Schedule
 */
export class BackgroundSyncScheduler {
  private schedules = new Map<string, Effect.Effect<void, never>>();

  constructor(
    private jobQueue: JobQueueService,
    private config: Config
  ) {}

  /**
   * Start all background sync schedules
   */
  start(): Effect.Effect<void, never> {
    const self = this;
    return Effect.gen(function* () {
      console.log('Starting background sync schedules...');
      
      // Schedule regular project syncs every 30 minutes
      yield* self.scheduleProjectSync();
      
      // Schedule Confluence sync every hour
      yield* self.scheduleConfluenceSync();
      
      // Schedule cache cleanup daily
      yield* self.scheduleCacheCleanup();
      
      // Schedule search index updates every 15 minutes
      yield* self.scheduleSearchIndexUpdate();
    });
  }

  private scheduleProjectSync(): Effect.Effect<void, never> {
    const syncSchedule = Schedule.fixed(Duration.minutes(30));
    const self = this;
    
    const syncEffect = Effect.gen(function* () {
      // Get all configured projects and schedule sync jobs
      const projectKeys = ['ENG', 'PROD']; // This would come from config
      
      for (const projectKey of projectKeys) {
        yield* self.jobQueue.enqueue({
          type: 'sync-jira-project',
          priority: 'normal',
          payload: { projectKey },
          maxRetries: 3
        });
      }
    });
    
    const scheduledSync = pipe(
      syncEffect,
      Effect.repeat(syncSchedule),
      Effect.fork,
      Effect.map(() => undefined)
    );
    
    this.schedules.set('project-sync', scheduledSync);
    return scheduledSync;
  }

  private scheduleConfluenceSync(): Effect.Effect<void, never> {
    const syncSchedule = Schedule.fixed(Duration.hours(1));
    const self = this;
    
    const syncEffect = Effect.gen(function* () {
      const spaceKeys = ['ENG']; // This would come from config
      
      for (const spaceKey of spaceKeys) {
        yield* self.jobQueue.enqueue({
          type: 'sync-confluence-space',
          priority: 'normal',
          payload: { spaceKey },
          maxRetries: 3
        });
      }
    });
    
    const scheduledSync = pipe(
      syncEffect,
      Effect.repeat(syncSchedule),
      Effect.fork,
      Effect.map(() => undefined)
    );
    
    this.schedules.set('confluence-sync', scheduledSync);
    return scheduledSync;
  }

  private scheduleCacheCleanup(): Effect.Effect<void, never> {
    const cleanupSchedule = Schedule.fixed(Duration.hours(24));
    const self = this;
    
    const cleanupEffect = Effect.gen(function* () {
      yield* self.jobQueue.enqueue({
        type: 'cleanup-cache',
        priority: 'low',
        payload: { olderThanDays: 30 },
        maxRetries: 1
      });
    });
    
    const scheduledCleanup = pipe(
      cleanupEffect,
      Effect.repeat(cleanupSchedule),
      Effect.fork,
      Effect.map(() => undefined)
    );
    
    this.schedules.set('cache-cleanup', scheduledCleanup);
    return scheduledCleanup;
  }

  private scheduleSearchIndexUpdate(): Effect.Effect<void, never> {
    const updateSchedule = Schedule.fixed(Duration.minutes(15));
    const self = this;
    
    const updateEffect = Effect.gen(function* () {
      yield* self.jobQueue.enqueue({
        type: 'update-search-index',
        priority: 'normal',
        payload: { force: false },
        maxRetries: 2
      });
    });
    
    const scheduledUpdate = pipe(
      updateEffect,
      Effect.repeat(updateSchedule),
      Effect.fork,
      Effect.map(() => undefined)
    );
    
    this.schedules.set('search-index-update', scheduledUpdate);
    return scheduledUpdate;
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log('Stopping background sync schedules...');
      this.schedules.clear();
    });
  }
}

/**
 * Create job queue service with proper error handling
 */
export function createJobQueueService(): Effect.Effect<JobQueueService, ConfigError | DatabaseError> {
  return pipe(
    JobQueueLayer,
    Layer.build,
    Effect.scoped,
    Effect.map(context => Context.get(context, JobQueueServiceContext)),
    Effect.mapError(error => 
      new DatabaseError(`Failed to create job queue service: ${error}`, error)
    )
  );
}