import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { saveContent, saveContentEffect } from './content-manager/content-operations.js';
import { buildJiraContent, saveJiraIssue, saveJiraIssueEffect } from './content-manager/jira-operations.js';

// Import types from modular files
import type { ADFNode, SearchableContent, SearchableContentMetadata, SearchResult } from './content-manager/types.js';
import { escapeFTS5Query } from './content-manager/utils.js';
import { type ContentError, type ContentTooLargeError, QueryError, ValidationError } from './effects/errors.js';
import type { Issue } from './jira-client.js';

// Re-export types for backward compatibility
export type { SearchableContent, SearchableContentMetadata, SearchResult, ADFNode };

export class ContentManager {
  public db: Database;
  private meilisearchErrorShown = { value: false };

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
  }

  /**
   * Effect-based save Jira issue with validation and transaction support
   */
  saveJiraIssueEffect(
    issue: Issue,
  ): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError> {
    return pipe(
      saveJiraIssueEffect(this.db, issue),
      // Save to searchable content
      Effect.flatMap(() => {
        const projectKey = issue.key.split('-')[0];
        const content = buildJiraContent(issue);

        return saveContentEffect(
          this.db,
          {
            id: `jira:${issue.key}`,
            source: 'jira',
            type: 'issue',
            title: `${issue.key}: ${issue.fields.summary}`,
            content: content,
            url: `/browse/${issue.key}`,
            projectKey: projectKey,
            metadata: {
              status: issue.fields.status.name,
              priority: issue.fields.priority?.name,
              assignee: issue.fields.assignee?.displayName,
              reporter: issue.fields.reporter.displayName,
            },
            createdAt: new Date(issue.fields.created).getTime(),
            updatedAt: new Date(issue.fields.updated).getTime(),
            syncedAt: Date.now(),
          },
          this.meilisearchErrorShown,
        );
      }),
    );
  }

  // Backward compatible version
  async saveJiraIssue(issue: Issue): Promise<void> {
    // Use the extracted function
    await saveJiraIssue(this.db, issue);

    // Also save to searchable_content
    const projectKey = issue.key.split('-')[0];
    const content = buildJiraContent(issue);
    await saveContent(
      this.db,
      {
        id: `jira:${issue.key}`,
        source: 'jira',
        type: 'issue',
        title: `${issue.key}: ${issue.fields.summary}`,
        content: content,
        url: `/browse/${issue.key}`,
        projectKey: projectKey,
        metadata: {
          status: issue.fields.status.name,
          priority: issue.fields.priority?.name,
          assignee: issue.fields.assignee?.displayName,
          reporter: issue.fields.reporter.displayName,
        },
        createdAt: new Date(issue.fields.created).getTime(),
        updatedAt: new Date(issue.fields.updated).getTime(),
        syncedAt: Date.now(),
      },
      this.meilisearchErrorShown,
    );
  }

  /**
   * Effect-based save content with validation
   */
  saveContentEffect(
    content: SearchableContent,
  ): Effect.Effect<void, ValidationError | ContentTooLargeError | QueryError | ContentError> {
    return saveContentEffect(this.db, content, this.meilisearchErrorShown);
  }

  // Backward compatible version
  async saveContent(content: SearchableContent): Promise<void> {
    return saveContent(this.db, content, this.meilisearchErrorShown);
  }

  /**
   * Effect-based content search with validation
   */
  searchContentEffect(
    query: string,
    options?: {
      source?: 'jira' | 'confluence';
      type?: string;
      limit?: number;
    },
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
            const stmt = this.db.prepare('SELECT * FROM searchable_content WHERE id = ?');
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

          const stmt = this.db.prepare(sql);
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

  async searchContent(
    query: string,
    options?: {
      source?: 'jira' | 'confluence';
      type?: string;
      limit?: number;
    },
  ): Promise<SearchableContent[]> {
    // Handle exact Jira issue key search (e.g., "EVAL-5273")
    const jiraKeyPattern = /^[A-Z]+-\d+$/;
    if (jiraKeyPattern.test(query)) {
      const stmt = this.db.prepare('SELECT * FROM searchable_content WHERE id = ?');
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
      const stmt = this.db.prepare('SELECT * FROM searchable_content WHERE id = ?');
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

    const stmt = this.db.prepare(sql);
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

  private buildJiraContent(issue: Issue): string {
    const parts = [
      issue.fields.summary,
      `Status: ${issue.fields.status.name}`,
      issue.fields.priority ? `Priority: ${issue.fields.priority.name}` : '',
      issue.fields.assignee ? `Assignee: ${issue.fields.assignee.displayName}` : '',
      `Reporter: ${issue.fields.reporter.displayName}`,
      this.extractDescription(issue.fields.description as string | { content?: ADFNode[] } | null | undefined),
    ];

    return parts.filter(Boolean).join('\n');
  }

  private extractDescription(description: string | { content?: ADFNode[] } | null | undefined): string {
    if (typeof description === 'string') {
      return description;
    }

    if (description?.content) {
      return this.parseADF(description);
    }

    return '';
  }

  private parseADF(doc: { content?: ADFNode[] }): string {
    let text = '';

    const parseNode = (node: ADFNode): string => {
      if (node.type === 'text') {
        return node.text || '';
      }

      if (node.type === 'paragraph' && node.content) {
        return `\n${node.content.map((n) => parseNode(n)).join('')}\n`;
      }

      if (node.content) {
        return node.content.map((n) => parseNode(n)).join('');
      }

      return '';
    };

    if (doc.content) {
      text = doc.content.map((node) => parseNode(node)).join('');
    }

    return text.trim();
  }

  /**
   * Effect-based get space page versions with validation
   */
  getSpacePageVersionsEffect(
    spaceKey: string,
  ): Effect.Effect<
    Map<string, { version: number; updatedAt: number; syncedAt: number }>,
    ValidationError | QueryError
  > {
    return pipe(
      // Validate space key
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        return Effect.try(() => {
          const stmt = this.db.prepare(`
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

  async getSpacePageVersions(
    spaceKey: string,
  ): Promise<Map<string, { version: number; updatedAt: number; syncedAt: number }>> {
    const stmt = this.db.prepare(`
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
  hasContentChangedEffect(
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
          const stmt = this.db.prepare('SELECT content_hash FROM searchable_content WHERE id = ?');
          const existing = stmt.get(`confluence:${pageId}`) as { content_hash?: string } | undefined;

          return !existing || existing.content_hash !== newContentHash;
        }).pipe(Effect.mapError((error) => new QueryError(`Failed to check content change: ${error}`)));
      }),
    );
  }

  async hasContentChanged(pageId: string, newContentHash: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT content_hash FROM searchable_content WHERE id = ?');
    const existing = stmt.get(`confluence:${pageId}`) as { content_hash?: string } | undefined;

    return !existing || existing.content_hash !== newContentHash;
  }

  /**
   * Effect-based get last sync time with validation
   */
  getLastSyncTimeEffect(spaceKey: string): Effect.Effect<Date | null, ValidationError | QueryError> {
    return pipe(
      // Validate space key
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        return Effect.try(() => {
          const stmt = this.db.prepare(`
            SELECT MAX(synced_at) as last_sync 
            FROM searchable_content 
            WHERE space_key = ? AND source = 'confluence'
          `);

          const result = stmt.get(spaceKey) as { last_sync: number | null } | undefined;

          if (result?.last_sync) {
            return new Date(result.last_sync);
          }

          return null;
        }).pipe(Effect.mapError((error) => new QueryError(`Failed to get last sync time: ${error}`)));
      }),
    );
  }

  async getLastSyncTime(spaceKey: string): Promise<Date | null> {
    const stmt = this.db.prepare(`
      SELECT MAX(synced_at) as last_sync 
      FROM searchable_content 
      WHERE space_key = ? AND source = 'confluence'
    `);

    const result = stmt.get(spaceKey) as { last_sync: number | null } | undefined;

    if (result?.last_sync) {
      return new Date(result.last_sync);
    }

    return null;
  }

  /**
   * Effect-based get newest page modified date with validation
   */
  getNewestPageModifiedDateEffect(spaceKey: string): Effect.Effect<Date | null, ValidationError | QueryError> {
    return pipe(
      // Validate space key
      Effect.sync(() => {
        if (!spaceKey || spaceKey.trim().length === 0) {
          throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
        }
      }),
      Effect.flatMap(() => {
        return Effect.try(() => {
          const stmt = this.db.prepare(`
            SELECT MAX(updated_at) as newest_modified 
            FROM searchable_content 
            WHERE space_key = ? AND source = 'confluence'
          `);

          const result = stmt.get(spaceKey) as { newest_modified: number | null } | undefined;

          if (result?.newest_modified) {
            return new Date(result.newest_modified);
          }

          return null;
        }).pipe(Effect.mapError((error) => new QueryError(`Failed to get newest page modified date: ${error}`)));
      }),
    );
  }

  async getNewestPageModifiedDate(spaceKey: string): Promise<Date | null> {
    const stmt = this.db.prepare(`
      SELECT MAX(updated_at) as newest_modified 
      FROM searchable_content 
      WHERE space_key = ? AND source = 'confluence'
    `);

    const result = stmt.get(spaceKey) as { newest_modified: number | null } | undefined;

    if (result?.newest_modified) {
      return new Date(result.newest_modified);
    }

    return null;
  }

  async getOldestPageModifiedDate(spaceKey: string): Promise<Date | null> {
    const stmt = this.db.prepare(`
      SELECT MIN(updated_at) as oldest_modified 
      FROM searchable_content 
      WHERE space_key = ? AND source = 'confluence'
    `);

    const result = stmt.get(spaceKey) as { oldest_modified: number | null } | undefined;

    if (result?.oldest_modified) {
      return new Date(result.oldest_modified);
    }

    return null;
  }

  private extractSprintInfo(issue: Issue): { id: string; name: string } | null {
    // Sprint information is typically stored in customfield_10020 or similar
    // The format is usually an array of sprint strings
    const fields = issue.fields as Record<string, unknown>;

    // Note: Sprint detection now uses Jira Agile API directly instead of custom fields
    // since custom field IDs vary between Jira instances

    // Common sprint field names
    const sprintFieldNames = [
      'customfield_10020', // Most common
      'customfield_10021',
      'customfield_10016',
      'sprint',
      'sprints',
    ];

    for (const fieldName of sprintFieldNames) {
      const sprintData = fields[fieldName];
      if (!sprintData) continue;

      // Handle array of sprints (take the most recent/active one)
      if (Array.isArray(sprintData) && sprintData.length > 0) {
        const sprintString = sprintData[sprintData.length - 1];
        if (typeof sprintString === 'string') {
          // Parse sprint string format: "com.atlassian.greenhopper.service.sprint.Sprint@1234[id=123,name=Sprint 1,...]"
          const idMatch = sprintString.match(/\[.*?id=(\d+)/i);
          const nameMatch = sprintString.match(/\[.*?name=([^,\]]+)/i);

          if (idMatch && nameMatch) {
            return {
              id: idMatch[1],
              name: nameMatch[1],
            };
          }
        } else if (typeof sprintString === 'object' && sprintString.id && sprintString.name) {
          // Sometimes it's already an object
          return {
            id: String(sprintString.id),
            name: sprintString.name,
          };
        }
      }

      // Handle single sprint object
      if (typeof sprintData === 'object' && sprintData !== null) {
        const sprint = sprintData as { id?: unknown; name?: unknown };
        if (sprint.id && sprint.name) {
          return {
            id: String(sprint.id),
            name: String(sprint.name),
          };
        }
      }
    }

    return null;
  }

  /**
   * Delete all content for a specific Confluence space
   */
  async deleteSpaceContent(spaceKey: string): Promise<void> {
    // Delete from FTS table first
    const deleteFtsStmt = this.db.prepare(`
      DELETE FROM content_fts 
      WHERE id IN (
        SELECT id FROM searchable_content 
        WHERE space_key = ? AND source = 'confluence'
      )
    `);
    deleteFtsStmt.run(spaceKey);

    // Then delete from main table
    const deleteStmt = this.db.prepare(`
      DELETE FROM searchable_content 
      WHERE space_key = ? AND source = 'confluence'
    `);
    const result = deleteStmt.run(spaceKey);

    console.log(chalk.dim(`Deleted ${result.changes} Confluence pages from ${spaceKey}`));
  }

  close() {
    this.db.close();
  }
}
