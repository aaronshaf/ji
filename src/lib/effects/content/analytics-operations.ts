/**
 * Analytics and management operations
 */

import { Effect, Option, pipe } from 'effect';
import { type ParseError, type QueryError, ValidationError } from '../errors.js';
import type { DatabaseService, LoggerService } from '../layers.js';
import type { ContentStats } from './types.js';

export interface AnalyticsOperations {
  readonly getContentStats: () => Effect.Effect<ContentStats, QueryError | ParseError>;
  readonly getLastSyncTime: (
    source: 'jira' | 'confluence',
    keyOrSpace: string,
  ) => Effect.Effect<Option.Option<Date>, ValidationError | QueryError>;
  readonly updateSyncTime: (
    source: 'jira' | 'confluence',
    keyOrSpace: string,
  ) => Effect.Effect<void, ValidationError | QueryError>;
  readonly cleanupOldContent: (olderThanDays: number) => Effect.Effect<number, QueryError>;
}

export class AnalyticsOperationsImpl implements AnalyticsOperations {
  constructor(
    private db: DatabaseService,
    private logger: LoggerService,
  ) {}

  getContentStats(): Effect.Effect<ContentStats, QueryError | ParseError> {
    return Effect.all({
      totalContent: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content'),
        Effect.map((rows) => rows[0]?.count || 0),
      ),
      jiraIssues: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE source = ?', ['jira']),
        Effect.map((rows) => rows[0]?.count || 0),
      ),
      confluencePages: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE source = ?', [
          'confluence',
        ]),
        Effect.map((rows) => rows[0]?.count || 0),
      ),
      spaceStats: pipe(
        this.db.query<{ space_key: string; count: number }>(
          'SELECT space_key, COUNT(*) as count FROM searchable_content WHERE source = ? AND space_key IS NOT NULL GROUP BY space_key',
          ['confluence'],
        ),
        Effect.map((rows) =>
          rows.reduce(
            (acc, row) => {
              acc[row.space_key] = row.count;
              return acc;
            },
            {} as Record<string, number>,
          ),
        ),
      ),
      projectStats: pipe(
        this.db.query<{ project_key: string; count: number }>(
          'SELECT project_key, COUNT(*) as count FROM searchable_content WHERE source = ? AND project_key IS NOT NULL GROUP BY project_key',
          ['jira'],
        ),
        Effect.map((rows) =>
          rows.reduce(
            (acc, row) => {
              acc[row.project_key] = row.count;
              return acc;
            },
            {} as Record<string, number>,
          ),
        ),
      ),
      lastSync: pipe(
        this.db.query<{ max_sync: number | null }>('SELECT MAX(synced_at) as max_sync FROM searchable_content'),
        Effect.map((rows) => {
          const maxSync = rows[0]?.max_sync;
          return maxSync ? new Date(maxSync) : null;
        }),
      ),
    });
  }

  getLastSyncTime(
    source: 'jira' | 'confluence',
    keyOrSpace: string,
  ): Effect.Effect<Option.Option<Date>, ValidationError | QueryError> {
    return pipe(
      Effect.sync(() => {
        if (!keyOrSpace || keyOrSpace.length === 0) {
          throw new ValidationError('Key or space cannot be empty', 'keyOrSpace', keyOrSpace);
        }
      }),
      Effect.flatMap(() => {
        const column = source === 'jira' ? 'project_key' : 'space_key';
        return this.db.query<{ max_sync: number | null }>(
          `SELECT MAX(synced_at) as max_sync FROM searchable_content WHERE source = ? AND ${column} = ?`,
          [source, keyOrSpace],
        );
      }),
      Effect.map((rows) => {
        const maxSync = rows[0]?.max_sync;
        return maxSync ? Option.some(new Date(maxSync)) : Option.none();
      }),
    );
  }

  updateSyncTime(source: 'jira' | 'confluence', keyOrSpace: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      Effect.sync(() => {
        if (!keyOrSpace || keyOrSpace.length === 0) {
          throw new ValidationError('Key or space cannot be empty', 'keyOrSpace', keyOrSpace);
        }
      }),
      Effect.flatMap(() => {
        const column = source === 'jira' ? 'project_key' : 'space_key';
        return this.db.execute(`UPDATE searchable_content SET synced_at = ? WHERE source = ? AND ${column} = ?`, [
          Date.now(),
          source,
          keyOrSpace,
        ]);
      }),
      Effect.asVoid,
    );
  }

  cleanupOldContent(olderThanDays: number): Effect.Effect<number, QueryError> {
    return pipe(
      Effect.sync(() => {
        const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
        return cutoffTime;
      }),
      Effect.flatMap((cutoffTime) =>
        this.db.transaction(
          pipe(
            this.logger.info('Cleaning up old content', { olderThanDays, cutoffTime }),
            Effect.flatMap(() =>
              this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE synced_at < ?', [
                cutoffTime,
              ]),
            ),
            Effect.tap((rows) => {
              const count = rows[0]?.count || 0;
              return this.logger.info('Found old content to delete', { count });
            }),
            Effect.flatMap((rows) => {
              const count = rows[0]?.count || 0;
              return pipe(
                this.db.execute('DELETE FROM searchable_content WHERE synced_at < ?', [cutoffTime]),
                Effect.flatMap(() =>
                  this.db.execute('DELETE FROM content_fts WHERE id NOT IN (SELECT id FROM searchable_content)'),
                ),
                Effect.map(() => count),
              );
            }),
            Effect.tap((count) => this.logger.info('Cleaned up old content', { deletedCount: count })),
          ),
        ),
      ),
    );
  }
}
