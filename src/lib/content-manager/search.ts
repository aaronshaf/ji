/**
 * Search functionality for content management
 */

import type { Database } from 'bun:sqlite';
import { Effect, pipe } from 'effect';
import { QueryError, ValidationError } from '../effects/errors.js';
import type { SearchableContent } from './types.js';
import { escapeFTS5Query } from './utils.js';

export interface SearchOptions {
  source?: 'jira' | 'confluence';
  type?: string;
  limit?: number;
}

/**
 * Effect-based content search with validation
 */
export function searchContentEffect(
  db: Database,
  query: string,
  options?: SearchOptions,
): Effect.Effect<SearchableContent[], ValidationError | QueryError> {
  return pipe(
    // Validate inputs
    Effect.sync(() => {
      if (!query || query.trim().length === 0) {
        throw new ValidationError('Query cannot be empty', 'query', query);
      }
      if (options?.limit !== undefined && (options.limit <= 0 || options.limit > 1000)) {
        throw new ValidationError('Limit must be between 1 and 1000', 'limit', options.limit);
      }
    }),
    Effect.flatMap(() => {
      return Effect.try(() => {
        // Handle special case for ID search
        if (query.startsWith('id:')) {
          const id = query.substring(3);
          const stmt = db.prepare('SELECT * FROM searchable_content WHERE id = ?');
          const row = stmt.get(id) as
            | {
                id: string;
                source: string;
                type: string;
                title: string;
                content: string;
                url: string;
                space_key?: string;
                project_key?: string;
                metadata?: string;
                created_at?: number;
                updated_at?: number;
                synced_at: number;
              }
            | undefined;

          if (!row) return [];

          return [
            {
              id: row.id,
              source: row.source as 'jira' | 'confluence',
              type: row.type,
              title: row.title,
              content: row.content,
              url: row.url,
              spaceKey: row.space_key,
              projectKey: row.project_key,
              metadata: JSON.parse(row.metadata || '{}'),
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              syncedAt: row.synced_at,
            },
          ];
        }

        let sql = `
          SELECT sc.*,
            snippet(content_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
          FROM searchable_content sc
          JOIN content_fts ON content_fts.id = sc.id
          WHERE content_fts MATCH ?
        `;

        const params: (string | number)[] = [escapeFTS5Query(query)];

        if (options?.source) {
          sql += ' AND sc.source = ?';
          params.push(options.source);
        }

        if (options?.type) {
          sql += ' AND sc.type = ?';
          params.push(options.type);
        }

        sql += ' ORDER BY rank LIMIT ?';
        params.push(options?.limit || 20);

        const stmt = db.prepare(sql);
        const rows = stmt.all(...params) as Array<{
          id: string;
          source: string;
          type: string;
          title: string;
          content: string;
          url: string;
          space_key?: string;
          project_key?: string;
          metadata?: string;
          created_at?: number;
          updated_at?: number;
          synced_at: number;
          snippet: string;
        }>;

        return rows.map((row) => ({
          id: row.id,
          source: row.source as 'jira' | 'confluence',
          type: row.type,
          title: row.title,
          content: row.content,
          url: row.url,
          spaceKey: row.space_key,
          projectKey: row.project_key,
          metadata: JSON.parse(row.metadata || '{}'),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          syncedAt: row.synced_at,
          snippet: row.snippet,
        }));
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to search content: ${error}`)));
    }),
  );
}

/**
 * Legacy async search function with enhanced Jira key detection
 */
export async function searchContent(
  db: Database,
  query: string,
  options?: SearchOptions,
): Promise<SearchableContent[]> {
  // Handle exact Jira issue key search (e.g., "EVAL-5273")
  const jiraKeyPattern = /^[A-Z]+-\d+$/;
  if (jiraKeyPattern.test(query)) {
    const stmt = db.prepare('SELECT * FROM searchable_content WHERE id = ?');
    const row = stmt.get(`jira:${query}`) as
      | {
          id: string;
          source: string;
          type: string;
          title: string;
          content: string;
          url: string;
          space_key?: string;
          project_key?: string;
          metadata?: string;
          created_at?: number;
          updated_at?: number;
          synced_at: number;
        }
      | undefined;

    if (row) {
      return [
        {
          id: row.id,
          source: row.source as 'jira' | 'confluence',
          type: row.type,
          title: row.title,
          content: row.content,
          url: row.url,
          spaceKey: row.space_key,
          projectKey: row.project_key,
          metadata: JSON.parse(row.metadata || '{}'),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          syncedAt: row.synced_at,
        },
      ];
    }
    // Fall through to regular search if not found
  }

  // Handle special case for ID search
  if (query.startsWith('id:')) {
    const id = query.substring(3);
    const stmt = db.prepare('SELECT * FROM searchable_content WHERE id = ?');
    const row = stmt.get(id) as
      | {
          id: string;
          source: string;
          type: string;
          title: string;
          content: string;
          url: string;
          space_key?: string;
          project_key?: string;
          metadata?: string;
          created_at?: number;
          updated_at?: number;
          synced_at: number;
        }
      | undefined;

    if (!row) return [];

    return [
      {
        id: row.id,
        source: row.source as 'jira' | 'confluence',
        type: row.type,
        title: row.title,
        content: row.content,
        url: row.url,
        spaceKey: row.space_key,
        projectKey: row.project_key,
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        syncedAt: row.synced_at,
      },
    ];
  }

  // Enhanced semantic search with vector similarity + BM25
  try {
    const embedding = await generateEmbedding(query);
    if (embedding) {
      return await performHybridSearch(db, query, embedding, options);
    }
  } catch (error) {
    console.warn('Fallback to FTS search due to embedding error:', error);
  }

  // Fallback to FTS search
  let sql = `
    SELECT sc.*,
      snippet(content_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
    FROM searchable_content sc
    JOIN content_fts ON content_fts.id = sc.id
    WHERE content_fts MATCH ?
  `;

  const params: (string | number)[] = [escapeFTS5Query(query)];

  if (options?.source) {
    sql += ' AND sc.source = ?';
    params.push(options.source);
  }

  if (options?.type) {
    sql += ' AND sc.type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(options?.limit || 20);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<{
    id: string;
    source: string;
    type: string;
    title: string;
    content: string;
    url: string;
    space_key?: string;
    project_key?: string;
    metadata?: string;
    created_at?: number;
    updated_at?: number;
    synced_at: number;
    snippet: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    source: row.source as 'jira' | 'confluence',
    type: row.type,
    title: row.title,
    content: row.content,
    url: row.url,
    spaceKey: row.space_key,
    projectKey: row.project_key,
    metadata: JSON.parse(row.metadata || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
    snippet: row.snippet,
  }));
}

// Placeholder functions - would need to be implemented based on your embedding strategy
async function generateEmbedding(_query: string): Promise<number[] | null> {
  // Implementation would depend on your embedding service
  return null;
}

async function performHybridSearch(
  _db: Database,
  _query: string,
  _embedding: number[],
  _options?: SearchOptions,
): Promise<SearchableContent[]> {
  // Implementation would depend on your vector search setup
  return [];
}
