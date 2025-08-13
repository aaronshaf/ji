/**
 * Core content operations for content management
 */

import type { Database } from 'bun:sqlite';
import { Effect, pipe } from 'effect';
import { ContentError, ContentTooLargeError, QueryError, ValidationError } from '../effects/errors.js';
import { OllamaClient } from '../ollama.js';
import type { SearchableContent } from './types.js';

/**
 * Effect-based save content with validation
 */
export function saveContentEffect(
  db: Database,
  content: SearchableContent,
): Effect.Effect<void, ValidationError | ContentTooLargeError | QueryError | ContentError> {
  return pipe(
    // Validate content
    Effect.sync(() => {
      if (!content || typeof content !== 'object') {
        throw new ValidationError('Content must be an object', 'content', content);
      }
      if (!content.id || content.id.length === 0) {
        throw new ValidationError('Content must have an ID', 'content.id', content.id);
      }
      if (!content.title || content.title.length === 0) {
        throw new ValidationError('Content must have a title', 'content.title', content.title);
      }
      if (!content.content || content.content.length === 0) {
        throw new ValidationError('Content must have content', 'content.content', undefined);
      }
      if (content.content.length > 10_000_000) {
        // 10MB limit
        throw new ContentTooLargeError('Content too large', content.content.length, 10_000_000);
      }
    }),
    Effect.flatMap(() => {
      // Calculate content hash using Effect
      return pipe(
        OllamaClient.contentHashEffect(content.content),
        Effect.mapError((error) => new ContentError(`Failed to hash content: ${error}`)),
      );
    }),
    Effect.flatMap((contentHash) => {
      return Effect.try(() => {
        // Use transaction for atomicity
        db.transaction(() => {
          // Save to searchable_content
          const stmt = db.prepare(`
            INSERT OR REPLACE INTO searchable_content (
              id, source, type, title, content, url,
              space_key, project_key, metadata,
              created_at, updated_at, synced_at, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          stmt.run(
            content.id,
            content.source,
            content.type,
            content.title,
            content.content,
            content.url,
            content.spaceKey || null,
            content.projectKey || null,
            JSON.stringify(content.metadata || {}),
            content.createdAt || null,
            content.updatedAt || null,
            content.syncedAt,
            contentHash,
          );

          // Update FTS table
          const deleteFtsStmt = db.prepare('DELETE FROM content_fts WHERE id = ?');
          deleteFtsStmt.run(content.id);

          const ftsStmt = db.prepare(`
            INSERT INTO content_fts (id, title, content)
            VALUES (?, ?, ?)
          `);

          ftsStmt.run(content.id, content.title, content.content);
        })();
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to save content: ${error}`)));
    }),
  );
}

/**
 * Legacy async version of saveContent
 */
export async function saveContent(db: Database, content: SearchableContent): Promise<void> {
  // Calculate content hash
  const contentHash = OllamaClient.contentHash(content.content);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO searchable_content (
      id, source, type, title, content, url,
      space_key, project_key, metadata,
      created_at, updated_at, synced_at, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    content.id,
    content.source,
    content.type,
    content.title,
    content.content,
    content.url,
    content.spaceKey || null,
    content.projectKey || null,
    JSON.stringify(content.metadata || {}),
    content.createdAt || null,
    content.updatedAt || null,
    content.syncedAt,
    contentHash,
  );

  // Also update FTS table
  // First delete existing entry
  const deleteFtsStmt = db.prepare('DELETE FROM content_fts WHERE id = ?');
  deleteFtsStmt.run(content.id);

  // Then insert new entry
  const ftsStmt = db.prepare(`
    INSERT INTO content_fts (id, title, content)
    VALUES (?, ?, ?)
  `);

  ftsStmt.run(content.id, content.title, content.content);
}

/**
 * Delete all content for a specific space
 */
export async function deleteSpaceContent(db: Database, spaceKey: string): Promise<void> {
  // Delete from FTS table first
  const deleteFtsStmt = db.prepare(`
    DELETE FROM content_fts 
    WHERE id IN (
      SELECT id FROM searchable_content 
      WHERE space_key = ? AND source = 'confluence'
    )
  `);
  deleteFtsStmt.run(spaceKey);

  // Then delete from main table
  const deleteStmt = db.prepare(`
    DELETE FROM searchable_content 
    WHERE space_key = ? AND source = 'confluence'
  `);
  const result = deleteStmt.run(spaceKey);

  console.log(`Deleted ${result.changes} Confluence pages from ${spaceKey}`);
}
