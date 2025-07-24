/**
 * Confluence-specific operations for content management
 */

import type { Database } from 'bun:sqlite';
import { Effect, pipe } from 'effect';
import { QueryError, ValidationError } from '../effects/errors.js';

/**
 * Effect-based get space page versions with validation
 */
export function getSpacePageVersionsEffect(
  db: Database,
  spaceKey: string,
): Effect.Effect<Map<string, { version: number; updatedAt: number; syncedAt: number }>, ValidationError | QueryError> {
  return pipe(
    // Validate space key
    Effect.sync(() => {
      if (!spaceKey || spaceKey.trim().length === 0) {
        throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
      }
    }),
    Effect.flatMap(() => {
      return Effect.try(() => {
        const stmt = db.prepare(`
          SELECT id, updated_at, synced_at, 
                 JSON_EXTRACT(metadata, '$.version.number') as version_number
          FROM searchable_content 
          WHERE space_key = ? AND source = 'confluence'
        `);

        const rows = stmt.all(spaceKey) as Array<{
          id: string;
          updated_at: number;
          synced_at: number;
          version_number: number;
        }>;

        const versionMap = new Map<string, { version: number; updatedAt: number; syncedAt: number }>();

        for (const row of rows) {
          const pageId = row.id.replace('confluence:', '');
          versionMap.set(pageId, {
            version: row.version_number || 1,
            updatedAt: row.updated_at,
            syncedAt: row.synced_at,
          });
        }

        return versionMap;
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to get space page versions: ${error}`)));
    }),
  );
}

/**
 * Legacy async version of getSpacePageVersions
 */
export async function getSpacePageVersions(
  db: Database,
  spaceKey: string,
): Promise<Map<string, { version: number; updatedAt: number; syncedAt: number }>> {
  const stmt = db.prepare(`
    SELECT id, updated_at, synced_at, 
           JSON_EXTRACT(metadata, '$.version.number') as version_number
    FROM searchable_content 
    WHERE space_key = ? AND source = 'confluence'
  `);

  const rows = stmt.all(spaceKey) as Array<{
    id: string;
    updated_at: number;
    synced_at: number;
    version_number: number;
  }>;

  const versionMap = new Map<string, { version: number; updatedAt: number; syncedAt: number }>();

  for (const row of rows) {
    const pageId = row.id.replace('confluence:', '');
    versionMap.set(pageId, {
      version: row.version_number || 1,
      updatedAt: row.updated_at,
      syncedAt: row.synced_at,
    });
  }

  return versionMap;
}

/**
 * Effect-based content change detection
 */
export function hasContentChangedEffect(
  db: Database,
  pageId: string,
  newContentHash: string,
): Effect.Effect<boolean, ValidationError | QueryError> {
  return pipe(
    // Validate inputs
    Effect.sync(() => {
      if (!pageId || pageId.trim().length === 0) {
        throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
      }
      if (!newContentHash || newContentHash.trim().length === 0) {
        throw new ValidationError('Content hash cannot be empty', 'newContentHash', newContentHash);
      }
    }),
    Effect.flatMap(() => {
      return Effect.try(() => {
        const stmt = db.prepare(`
          SELECT JSON_EXTRACT(metadata, '$.contentHash') as content_hash
          FROM searchable_content 
          WHERE id = ?
        `);
        const row = stmt.get(`confluence:${pageId}`) as { content_hash: string } | undefined;
        return !row || row.content_hash !== newContentHash;
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to check content changes: ${error}`)));
    }),
  );
}

/**
 * Legacy async version of hasContentChanged
 */
export async function hasContentChanged(db: Database, pageId: string, newContentHash: string): Promise<boolean> {
  const stmt = db.prepare(`
    SELECT JSON_EXTRACT(metadata, '$.contentHash') as content_hash
    FROM searchable_content 
    WHERE id = ?
  `);
  const row = stmt.get(`confluence:${pageId}`) as { content_hash: string } | undefined;
  return !row || row.content_hash !== newContentHash;
}

/**
 * Get last sync time for a space - Effect version
 */
export function getLastSyncTimeEffect(
  db: Database,
  spaceKey: string,
): Effect.Effect<Date | null, ValidationError | QueryError> {
  return pipe(
    // Validate space key
    Effect.sync(() => {
      if (!spaceKey || spaceKey.trim().length === 0) {
        throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
      }
    }),
    Effect.flatMap(() => {
      return Effect.try(() => {
        const stmt = db.prepare(`
          SELECT MAX(synced_at) as last_sync
          FROM searchable_content 
          WHERE space_key = ? AND source = 'confluence'
        `);
        const row = stmt.get(spaceKey) as { last_sync: number | null } | undefined;
        return row?.last_sync ? new Date(row.last_sync) : null;
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to get last sync time: ${error}`)));
    }),
  );
}

/**
 * Legacy async version of getLastSyncTime
 */
export async function getLastSyncTime(db: Database, spaceKey: string): Promise<Date | null> {
  const stmt = db.prepare(`
    SELECT MAX(synced_at) as last_sync
    FROM searchable_content 
    WHERE space_key = ? AND source = 'confluence'
  `);
  const row = stmt.get(spaceKey) as { last_sync: number | null } | undefined;
  return row?.last_sync ? new Date(row.last_sync) : null;
}

/**
 * Get newest page modified date for a space - Effect version
 */
export function getNewestPageModifiedDateEffect(
  db: Database,
  spaceKey: string,
): Effect.Effect<Date | null, ValidationError | QueryError> {
  return pipe(
    // Validate space key
    Effect.sync(() => {
      if (!spaceKey || spaceKey.trim().length === 0) {
        throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
      }
    }),
    Effect.flatMap(() => {
      return Effect.try(() => {
        const stmt = db.prepare(`
          SELECT MAX(updated_at) as newest_modified
          FROM searchable_content 
          WHERE space_key = ? AND source = 'confluence'
        `);
        const row = stmt.get(spaceKey) as { newest_modified: number | null } | undefined;
        return row?.newest_modified ? new Date(row.newest_modified) : null;
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to get newest page modified date: ${error}`)));
    }),
  );
}

/**
 * Legacy async version of getNewestPageModifiedDate
 */
export async function getNewestPageModifiedDate(db: Database, spaceKey: string): Promise<Date | null> {
  const stmt = db.prepare(`
    SELECT MAX(updated_at) as newest_modified
    FROM searchable_content 
    WHERE space_key = ? AND source = 'confluence'
  `);
  const row = stmt.get(spaceKey) as { newest_modified: number | null } | undefined;
  return row?.newest_modified ? new Date(row.newest_modified) : null;
}

/**
 * Get oldest page modified date for a space
 */
export async function getOldestPageModifiedDate(db: Database, spaceKey: string): Promise<Date | null> {
  const stmt = db.prepare(`
    SELECT MIN(updated_at) as oldest_modified
    FROM searchable_content 
    WHERE space_key = ? AND source = 'confluence'
  `);
  const row = stmt.get(spaceKey) as { oldest_modified: number | null } | undefined;
  return row?.oldest_modified ? new Date(row.oldest_modified) : null;
}

/**
 * Delete all content for a space
 */
export async function deleteSpaceContent(db: Database, spaceKey: string): Promise<void> {
  const stmt = db.prepare('DELETE FROM searchable_content WHERE space_key = ?');
  stmt.run(spaceKey);
}
