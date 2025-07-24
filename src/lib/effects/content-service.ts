/**
 * Effect-based Content Service
 * Replaces the traditional ContentManager with a fully Effect-based implementation
 * Handles unified content storage for Jira issues and Confluence pages
 */

import { Context, Effect, Layer, Option, pipe, type Stream } from 'effect';
import type { Issue } from '../jira-client.js';
// Import operation interfaces
import type { AnalyticsOperations } from './content/analytics-operations.js';
// Import operation implementations
import { AnalyticsOperationsImpl } from './content/analytics-operations.js';
import type { ConfluenceContentOperations } from './content/confluence-content-operations.js';
import { ConfluenceContentOperationsImpl } from './content/confluence-content-operations.js';
import type { JiraContentOperations } from './content/jira-content-operations.js';
import { JiraContentOperationsImpl } from './content/jira-content-operations.js';
import type { SearchOperations } from './content/search-operations.js';
import { SearchOperationsImpl } from './content/search-operations.js';
import type { StreamingOperations } from './content/streaming-operations.js';
import { StreamingOperationsImpl } from './content/streaming-operations.js';
// Import types
import type {
  ConfluencePageData,
  ContentRow,
  ContentStats,
  PageVersionInfo,
  SearchableContent,
  SearchOptions,
  SearchResult,
} from './content/types.js';
import {
  ContentError,
  ContentTooLargeError,
  type DatabaseError,
  type DataIntegrityError,
  ParseError,
  type QueryError,
  ValidationError,
} from './errors.js';
import { type DatabaseService, DatabaseServiceTag, type LoggerService, LoggerServiceTag } from './layers.js';

// Re-export types for convenience
export type {
  ConfluencePageData,
  ContentStats,
  PageVersionInfo,
  SearchableContent,
  SearchableContentMetadata,
  SearchOptions,
  SearchResult,
  SprintInfo,
} from './content/types.js';

// ============= Content Service Interface =============
export interface ContentService {
  // Core content operations
  readonly saveContent: (
    content: SearchableContent,
  ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getContent: (
    id: string,
  ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteContent: (id: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly contentExists: (id: string) => Effect.Effect<boolean, ValidationError | QueryError>;

  // Jira-specific operations
  readonly saveJiraIssue: (
    issue: Issue,
  ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getJiraIssue: (
    issueKey: string,
  ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteProjectContent: (projectKey: string) => Effect.Effect<void, ValidationError | QueryError>;

  // Confluence-specific operations
  readonly saveConfluencePage: (
    pageData: ConfluencePageData,
  ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getConfluencePage: (
    pageId: string,
  ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteSpaceContent: (spaceKey: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly getSpacePageVersions: (
    spaceKey: string,
  ) => Effect.Effect<Map<string, PageVersionInfo>, QueryError | ParseError | ValidationError | DatabaseError>;
  readonly hasContentChanged: (
    id: string,
    newContentHash: string,
  ) => Effect.Effect<boolean, ValidationError | QueryError>;

  // Search and indexing
  readonly searchContent: (
    query: string,
    options?: SearchOptions,
  ) => Effect.Effect<SearchResult[], ValidationError | QueryError | ParseError>;
  readonly indexToFTS: (
    content: SearchableContent,
  ) => Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError>;
  readonly updateContentHash: (
    id: string,
    newHash: string,
  ) => Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError>;

  // Streaming operations for large datasets
  readonly streamContentBySource: (
    source: 'jira' | 'confluence',
  ) => Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError>;
  readonly streamContentByProject: (
    projectKey: string,
  ) => Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError>;
  readonly streamContentBySpace: (
    spaceKey: string,
  ) => Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError>;
  readonly batchSaveContent: (
    content: SearchableContent[],
  ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;

  // Analytics and management
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

export class ContentServiceTag extends Context.Tag('ContentService')<ContentServiceTag, ContentService>() {}

// ============= Content Service Implementation =============
class ContentServiceImpl implements ContentService {
  private jiraOps: JiraContentOperations;
  private confluenceOps: ConfluenceContentOperations;
  private searchOps: SearchOperations;
  private streamingOps: StreamingOperations;
  private analyticsOps: AnalyticsOperations;

  constructor(
    private db: DatabaseService,
    private logger: LoggerService,
  ) {
    // Initialize operation implementations
    this.jiraOps = new JiraContentOperationsImpl(db, logger, this.saveContent.bind(this), this.getContent.bind(this));

    this.confluenceOps = new ConfluenceContentOperationsImpl(
      db,
      logger,
      this.saveContent.bind(this),
      this.getContent.bind(this),
    );

    this.searchOps = new SearchOperationsImpl(
      db,
      this.getContent.bind(this),
      this.parseContentRow.bind(this),
      this.validateContent.bind(this),
      this.validateContentId.bind(this),
    );

    this.streamingOps = new StreamingOperationsImpl(
      db,
      this.parseContentRow.bind(this),
      this.saveContent.bind(this),
      this.validateContent.bind(this),
      this.jiraOps.validateProjectKey.bind(this.jiraOps),
      this.confluenceOps.validateSpaceKey.bind(this.confluenceOps),
    );

    this.analyticsOps = new AnalyticsOperationsImpl(db, logger);
  }

  // ============= Core Content Operations =============
  saveContent(
    content: SearchableContent,
  ): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
    return pipe(
      this.validateContent(content),
      Effect.flatMap(() => this.calculateContentHash(content.content)),
      Effect.flatMap((contentHash) =>
        this.db.transaction(
          pipe(
            this.logger.debug('Saving content', { id: content.id, source: content.source }),
            Effect.flatMap(() =>
              this.db.execute(
                `INSERT OR REPLACE INTO searchable_content (
                  id, source, type, title, content, url,
                  space_key, project_key, metadata,
                  created_at, updated_at, synced_at, content_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
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
                ],
              ),
            ),
            Effect.flatMap(() => this.indexToFTS({ ...content, contentHash })),
            Effect.tap(() => this.logger.debug('Content saved successfully', { id: content.id })),
          ),
        ),
      ),
    );
  }

  getContent(id: string): Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() => this.db.query<ContentRow>('SELECT * FROM searchable_content WHERE id = ?', [id])),
      Effect.flatMap((rows) => {
        if (rows.length === 0) {
          return Effect.succeed(Option.none());
        }
        return pipe(this.parseContentRow(rows[0]), Effect.map(Option.some));
      }),
    );
  }

  deleteContent(id: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.debug('Deleting content', { id }),
            Effect.flatMap(() => this.db.execute('DELETE FROM searchable_content WHERE id = ?', [id])),
            Effect.flatMap(() => this.db.execute('DELETE FROM content_fts WHERE id = ?', [id])),
            Effect.tap(() => this.logger.debug('Content deleted successfully', { id })),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  contentExists(id: string): Effect.Effect<boolean, ValidationError | QueryError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE id = ?', [id]),
      ),
      Effect.map((rows) => (rows[0]?.count || 0) > 0),
    );
  }

  // ============= Delegated Operations =============
  // Jira operations
  saveJiraIssue(issue: Issue) {
    return this.jiraOps.saveJiraIssue(issue);
  }

  getJiraIssue(issueKey: string) {
    return this.jiraOps.getJiraIssue(issueKey);
  }

  deleteProjectContent(projectKey: string) {
    return this.jiraOps.deleteProjectContent(projectKey);
  }

  // Confluence operations
  saveConfluencePage(pageData: ConfluencePageData) {
    return this.confluenceOps.saveConfluencePage(pageData);
  }

  getConfluencePage(pageId: string) {
    return this.confluenceOps.getConfluencePage(pageId);
  }

  deleteSpaceContent(spaceKey: string) {
    return this.confluenceOps.deleteSpaceContent(spaceKey);
  }

  getSpacePageVersions(spaceKey: string) {
    return this.confluenceOps.getSpacePageVersions(spaceKey);
  }

  hasContentChanged(id: string, newContentHash: string) {
    return this.confluenceOps.hasContentChanged(id, newContentHash);
  }

  // Search operations
  searchContent(query: string, options?: SearchOptions) {
    return this.searchOps.searchContent(query, options);
  }

  indexToFTS(content: SearchableContent) {
    return this.searchOps.indexToFTS(content);
  }

  updateContentHash(id: string, newHash: string) {
    return this.searchOps.updateContentHash(id, newHash);
  }

  // Streaming operations
  streamContentBySource(source: 'jira' | 'confluence') {
    return this.streamingOps.streamContentBySource(source);
  }

  streamContentByProject(projectKey: string) {
    return this.streamingOps.streamContentByProject(projectKey);
  }

  streamContentBySpace(spaceKey: string) {
    return this.streamingOps.streamContentBySpace(spaceKey);
  }

  batchSaveContent(content: SearchableContent[]) {
    return this.streamingOps.batchSaveContent(content);
  }

  // Analytics operations
  getContentStats() {
    return this.analyticsOps.getContentStats();
  }

  getLastSyncTime(source: 'jira' | 'confluence', keyOrSpace: string) {
    return this.analyticsOps.getLastSyncTime(source, keyOrSpace);
  }

  updateSyncTime(source: 'jira' | 'confluence', keyOrSpace: string) {
    return this.analyticsOps.updateSyncTime(source, keyOrSpace);
  }

  cleanupOldContent(olderThanDays: number) {
    return this.analyticsOps.cleanupOldContent(olderThanDays);
  }

  // ============= Private Helper Methods =============
  private validateContent(content: SearchableContent): Effect.Effect<void, ValidationError | ContentTooLargeError> {
    return Effect.sync(() => {
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
      if (!['jira', 'confluence'].includes(content.source)) {
        throw new ValidationError('Invalid content source', 'content.source', content.source);
      }
    });
  }

  private validateContentId(id: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!id || id.length === 0) {
        throw new ValidationError('Content ID cannot be empty', 'id', id);
      }
    });
  }

  private calculateContentHash(content: string): Effect.Effect<string, ContentError> {
    return Effect.try({
      try: () => {
        // Simple hash function - in production, use a proper crypto hash
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
      },
      catch: (error) => new ContentError(`Failed to calculate content hash: ${error}`),
    });
  }

  private parseContentRow(row: ContentRow): Effect.Effect<SearchableContent, ParseError> {
    return Effect.try({
      try: () => ({
        id: row.id,
        source: row.source as 'jira' | 'confluence',
        type: row.type,
        title: row.title,
        content: row.content,
        url: row.url,
        spaceKey: row.space_key,
        projectKey: row.project_key,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        syncedAt: row.synced_at,
        contentHash: row.content_hash,
      }),
      catch: (error) => new ParseError('Failed to parse content row', 'metadata', row.metadata || '', error),
    });
  }
}

// ============= Service Layer =============
export const ContentServiceLive = Layer.effect(
  ContentServiceTag,
  pipe(
    Effect.all({
      db: DatabaseServiceTag,
      logger: LoggerServiceTag,
    }),
    Effect.map(({ db, logger }) => new ContentServiceImpl(db, logger)),
  ),
);

// ============= Helper Functions =============
// Use ContentServiceLive directly with Effect.provide() when needed
