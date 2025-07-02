/**
 * Effect-based Content Service
 * Replaces the traditional ContentManager with a fully Effect-based implementation
 * Handles unified content storage for Jira issues and Confluence pages
 */

import { Effect, Layer, Context, Option, pipe, Stream, Chunk, Duration } from 'effect';
import type { Issue } from '../jira-client.js';
import { DatabaseService, DatabaseServiceTag, LoggerService, LoggerServiceTag } from './layers.js';
import { 
  QueryError, 
  ParseError, 
  ValidationError,
  DatabaseError,
  ContentError,
  ContentTooLargeError,
  DataIntegrityError
} from './errors.js';

// ============= Content Service Types =============
export interface SearchableContentMetadata {
  status?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  version?: { number?: number };
  [key: string]: unknown;
}

export interface SearchableContent {
  id: string;
  source: 'jira' | 'confluence';
  type: string;
  title: string;
  content: string;
  url: string;
  spaceKey?: string;
  projectKey?: string;
  metadata?: SearchableContentMetadata;
  createdAt?: number;
  updatedAt?: number;
  syncedAt: number;
  contentHash?: string;
}

export interface SearchOptions {
  source?: 'jira' | 'confluence';
  type?: string;
  spaceKey?: string;
  projectKey?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  content: SearchableContent;
  score: number;
  snippet: string;
  chunkIndex?: number;
}

export interface ContentStats {
  totalContent: number;
  jiraIssues: number;
  confluencePages: number;
  spaceStats: Record<string, number>;
  projectStats: Record<string, number>;
  lastSync: Date | null;
}

export interface SprintInfo {
  id: string;
  name: string;
}

// Atlassian Document Format node type
interface ADFNode {
  type?: string;
  text?: string;
  content?: ADFNode[];
}

// ============= Content Service Interface =============
export interface ContentService {
  // Core content operations
  readonly saveContent: (content: SearchableContent) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getContent: (id: string) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteContent: (id: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly contentExists: (id: string) => Effect.Effect<boolean, ValidationError | QueryError>;
  
  // Jira-specific operations
  readonly saveJiraIssue: (issue: Issue) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getJiraIssue: (issueKey: string) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteProjectContent: (projectKey: string) => Effect.Effect<void, ValidationError | QueryError>;
  
  // Confluence-specific operations
  readonly saveConfluencePage: (pageData: ConfluencePageData) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getConfluencePage: (pageId: string) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteSpaceContent: (spaceKey: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly getSpacePageVersions: (spaceKey: string) => Effect.Effect<Map<string, PageVersionInfo>, QueryError | ParseError | ValidationError | DatabaseError>;
  readonly hasContentChanged: (id: string, newContentHash: string) => Effect.Effect<boolean, ValidationError | QueryError>;
  
  // Search and indexing
  readonly searchContent: (query: string, options?: SearchOptions) => Effect.Effect<SearchResult[], ValidationError | QueryError | ParseError>;
  readonly indexToFTS: (content: SearchableContent) => Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError>;
  readonly updateContentHash: (id: string, newHash: string) => Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError>;
  
  // Streaming operations for large datasets
  readonly streamContentBySource: (source: 'jira' | 'confluence') => Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError>;
  readonly streamContentByProject: (projectKey: string) => Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError>;
  readonly streamContentBySpace: (spaceKey: string) => Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError>;
  readonly batchSaveContent: (content: SearchableContent[]) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  
  // Analytics and management
  readonly getContentStats: () => Effect.Effect<ContentStats, QueryError | ParseError>;
  readonly getLastSyncTime: (source: 'jira' | 'confluence', keyOrSpace: string) => Effect.Effect<Option.Option<Date>, ValidationError | QueryError>;
  readonly updateSyncTime: (source: 'jira' | 'confluence', keyOrSpace: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly cleanupOldContent: (olderThanDays: number) => Effect.Effect<number, QueryError>;
}

export interface ConfluencePageData {
  id: string;
  title: string;
  content: string;
  spaceKey: string;
  url: string;
  version?: { number: number };
  createdAt?: number;
  updatedAt?: number;
}

export interface PageVersionInfo {
  version: number;
  updatedAt: number;
  syncedAt: number;
}

export class ContentServiceTag extends Context.Tag('ContentService')<
  ContentServiceTag,
  ContentService
>() {}

// ============= Content Service Implementation =============
class ContentServiceImpl implements ContentService {
  constructor(
    private db: DatabaseService,
    private logger: LoggerService
  ) {}
  
  // ============= Core Content Operations =============
  saveContent(content: SearchableContent): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
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
                  contentHash
                ]
              )
            ),
            Effect.flatMap(() => this.indexToFTS({ ...content, contentHash })),
            Effect.tap(() => this.logger.debug('Content saved successfully', { id: content.id }))
          )
        )
      )
    );
  }
  
  getContent(id: string): Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.query<{
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
          content_hash?: string;
        }>('SELECT * FROM searchable_content WHERE id = ?', [id])
      ),
      Effect.flatMap((rows) => {
        if (rows.length === 0) {
          return Effect.succeed(Option.none());
        }
        return pipe(
          this.parseContentRow(rows[0]),
          Effect.map(Option.some)
        );
      })
    );
  }
  
  deleteContent(id: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.debug('Deleting content', { id }),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM searchable_content WHERE id = ?', [id])
            ),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM content_fts WHERE id = ?', [id])
            ),
            Effect.tap(() => this.logger.debug('Content deleted successfully', { id }))
          )
        )
      ),
      Effect.asVoid
    );
  }
  
  contentExists(id: string): Effect.Effect<boolean, ValidationError | QueryError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE id = ?', [id])
      ),
      Effect.map((rows) => (rows[0]?.count || 0) > 0)
    );
  }
  
  // ============= Jira-specific Operations =============
  saveJiraIssue(issue: Issue): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
    return pipe(
      this.validateIssue(issue),
      Effect.flatMap(() => {
        const projectKey = issue.key.split('-')[0];
        const sprintInfo = this.extractSprintInfo(issue);
        const content = this.buildJiraContent(issue);
        
        return this.db.transaction(
          pipe(
            this.logger.debug('Saving Jira issue', { key: issue.key, projectKey }),
            // Save project
            Effect.flatMap(() =>
              this.db.execute('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)', [projectKey, projectKey])
            ),
            // Save issue to issues table
            Effect.flatMap(() =>
              this.db.execute(
                `INSERT OR REPLACE INTO issues (
                  key, project_key, summary, status, priority,
                  assignee_name, assignee_email, reporter_name, reporter_email,
                  created, updated, description, raw_data, synced_at,
                  sprint_id, sprint_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  issue.key,
                  projectKey,
                  issue.fields.summary,
                  issue.fields.status.name,
                  issue.fields.priority?.name || null,
                  issue.fields.assignee?.displayName || null,
                  issue.fields.assignee?.emailAddress || null,
                  issue.fields.reporter.displayName,
                  issue.fields.reporter.emailAddress || null,
                  new Date(issue.fields.created).getTime(),
                  new Date(issue.fields.updated).getTime(),
                  this.extractDescription(issue.fields.description),
                  JSON.stringify(issue),
                  Date.now(),
                  sprintInfo?.id || null,
                  sprintInfo?.name || null
                ]
              )
            ),
            // Save to searchable content
            Effect.flatMap(() =>
              this.saveContent({
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
                  reporter: issue.fields.reporter.displayName
                },
                createdAt: new Date(issue.fields.created).getTime(),
                updatedAt: new Date(issue.fields.updated).getTime(),
                syncedAt: Date.now()
              })
            ),
            Effect.tap(() => this.logger.debug('Jira issue saved successfully', { key: issue.key }))
          )
        );
      })
    );
  }
  
  getJiraIssue(issueKey: string): Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateIssueKey(issueKey),
      Effect.flatMap(() => this.getContent(`jira:${issueKey}`))
    );
  }
  
  deleteProjectContent(projectKey: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.debug('Deleting project content', { projectKey }),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM issues WHERE project_key = ?', [projectKey])
            ),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM searchable_content WHERE project_key = ? AND source = ?', [projectKey, 'jira'])
            ),
            Effect.flatMap(() =>
              this.db.execute(
                'DELETE FROM content_fts WHERE id IN (SELECT id FROM searchable_content WHERE project_key = ? AND source = ?)',
                [projectKey, 'jira']
              )
            ),
            Effect.tap(() => this.logger.debug('Project content deleted successfully', { projectKey }))
          )
        )
      ),
      Effect.asVoid
    );
  }
  
  // ============= Confluence-specific Operations =============
  saveConfluencePage(pageData: ConfluencePageData): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
    return pipe(
      this.validateConfluencePage(pageData),
      Effect.flatMap(() =>
        this.saveContent({
          id: `confluence:${pageData.id}`,
          source: 'confluence',
          type: 'page',
          title: pageData.title,
          content: pageData.content,
          url: pageData.url,
          spaceKey: pageData.spaceKey,
          metadata: {
            version: pageData.version
          },
          createdAt: pageData.createdAt,
          updatedAt: pageData.updatedAt,
          syncedAt: Date.now()
        })
      )
    );
  }
  
  getConfluencePage(pageId: string): Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.getContent(`confluence:${pageId}`))
    );
  }
  
  deleteSpaceContent(spaceKey: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.debug('Deleting space content', { spaceKey }),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM searchable_content WHERE space_key = ? AND source = ?', [spaceKey, 'confluence'])
            ),
            Effect.flatMap(() =>
              this.db.execute(
                'DELETE FROM content_fts WHERE id IN (SELECT id FROM searchable_content WHERE space_key = ? AND source = ?)',
                [spaceKey, 'confluence']
              )
            ),
            Effect.tap(() => this.logger.debug('Space content deleted successfully', { spaceKey }))
          )
        )
      ),
      Effect.asVoid
    );
  }
  
  getSpacePageVersions(spaceKey: string): Effect.Effect<Map<string, PageVersionInfo>, QueryError | ParseError | ValidationError | DatabaseError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() =>
        this.db.query<{
          id: string;
          updated_at: number;
          synced_at: number;
          metadata: string;
        }>(
          'SELECT id, updated_at, synced_at, metadata FROM searchable_content WHERE space_key = ? AND source = ?',
          [spaceKey, 'confluence']
        )
      ),
      Effect.flatMap((rows) =>
        Effect.try({
          try: () => {
            const versionMap = new Map<string, PageVersionInfo>();
            
            for (const row of rows) {
              const pageId = row.id.replace('confluence:', '');
              const metadata = JSON.parse(row.metadata || '{}');
              const version = metadata.version?.number || 1;
              
              versionMap.set(pageId, {
                version,
                updatedAt: row.updated_at,
                syncedAt: row.synced_at
              });
            }
            
            return versionMap;
          },
          catch: (error) => new ParseError('Failed to parse page version data', 'metadata', JSON.stringify(rows), error)
        })
      )
    );
  }
  
  hasContentChanged(id: string, newContentHash: string): Effect.Effect<boolean, ValidationError | QueryError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.query<{ content_hash?: string }>('SELECT content_hash FROM searchable_content WHERE id = ?', [id])
      ),
      Effect.map((rows) => {
        if (rows.length === 0) return true; // Content doesn't exist, so it's "changed"
        return rows[0].content_hash !== newContentHash;
      })
    );
  }
  
  // ============= Search and Indexing =============
  searchContent(query: string, options: SearchOptions = {}): Effect.Effect<SearchResult[], ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateSearchQuery(query),
      Effect.flatMap(() => {
        // Handle special case for ID search
        if (query.startsWith('id:')) {
          const id = query.substring(3);
          return pipe(
            this.getContent(id),
            Effect.map((optContent) =>
              Option.match(optContent, {
                onNone: () => [],
                onSome: (content) => [{
                  content,
                  score: 1.0,
                  snippet: content.title
                }]
              })
            )
          );
        }
        
        return this.performFTSSearch(query, options);
      })
    );
  }
  
  indexToFTS(content: SearchableContent): Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError> {
    return pipe(
      this.validateContent(content),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.db.execute('DELETE FROM content_fts WHERE id = ?', [content.id]),
            Effect.flatMap(() =>
              this.db.execute(
                'INSERT INTO content_fts (id, title, content) VALUES (?, ?, ?)',
                [content.id, content.title, content.content]
              )
            )
          )
        )
      ),
      Effect.asVoid
    );
  }
  
  updateContentHash(id: string, newHash: string): Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.execute('UPDATE searchable_content SET content_hash = ? WHERE id = ?', [newHash, id])
      ),
      Effect.asVoid
    );
  }
  
  // ============= Streaming Operations =============
  streamContentBySource(source: 'jira' | 'confluence'): Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(
        this.db.query<{
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
          content_hash?: string;
        }>('SELECT * FROM searchable_content WHERE source = ? ORDER BY synced_at DESC', [source])
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) => this.parseContentRow(row)),
      Stream.rechunk(100) // Process in chunks
    );
  }
  
  streamContentByProject(projectKey: string): Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(this.validateProjectKey(projectKey)),
      Stream.flatMap(() =>
        Stream.fromEffect(
          this.db.query<{
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
            content_hash?: string;
          }>('SELECT * FROM searchable_content WHERE project_key = ? ORDER BY synced_at DESC', [projectKey])
        )
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) => this.parseContentRow(row)),
      Stream.rechunk(50)
    );
  }
  
  streamContentBySpace(spaceKey: string): Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(this.validateSpaceKey(spaceKey)),
      Stream.flatMap(() =>
        Stream.fromEffect(
          this.db.query<{
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
            content_hash?: string;
          }>('SELECT * FROM searchable_content WHERE space_key = ? ORDER BY synced_at DESC', [spaceKey])
        )
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) => this.parseContentRow(row)),
      Stream.rechunk(50)
    );
  }
  
  batchSaveContent(content: SearchableContent[]): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
    return pipe(
      Effect.forEach(content, (item) => this.validateContent(item)),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            Stream.fromIterable(content),
            Stream.mapEffect((item) => this.saveContent(item)),
            Stream.runDrain
          )
        )
      )
    );
  }
  
  // ============= Analytics and Management =============
  getContentStats(): Effect.Effect<ContentStats, QueryError | ParseError> {
    return Effect.all({
      totalContent: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content'),
        Effect.map((rows) => rows[0]?.count || 0)
      ),
      jiraIssues: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE source = ?', ['jira']),
        Effect.map((rows) => rows[0]?.count || 0)
      ),
      confluencePages: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM searchable_content WHERE source = ?', ['confluence']),
        Effect.map((rows) => rows[0]?.count || 0)
      ),
      spaceStats: pipe(
        this.db.query<{ space_key: string; count: number }>(
          'SELECT space_key, COUNT(*) as count FROM searchable_content WHERE source = ? AND space_key IS NOT NULL GROUP BY space_key',
          ['confluence']
        ),
        Effect.map((rows) =>
          rows.reduce((acc, row) => {
            acc[row.space_key] = row.count;
            return acc;
          }, {} as Record<string, number>)
        )
      ),
      projectStats: pipe(
        this.db.query<{ project_key: string; count: number }>(
          'SELECT project_key, COUNT(*) as count FROM searchable_content WHERE source = ? AND project_key IS NOT NULL GROUP BY project_key',
          ['jira']
        ),
        Effect.map((rows) =>
          rows.reduce((acc, row) => {
            acc[row.project_key] = row.count;
            return acc;
          }, {} as Record<string, number>)
        )
      ),
      lastSync: pipe(
        this.db.query<{ max_sync: number | null }>('SELECT MAX(synced_at) as max_sync FROM searchable_content'),
        Effect.map((rows) => {
          const maxSync = rows[0]?.max_sync;
          return maxSync ? new Date(maxSync) : null;
        })
      )
    });
  }
  
  getLastSyncTime(source: 'jira' | 'confluence', keyOrSpace: string): Effect.Effect<Option.Option<Date>, ValidationError | QueryError> {
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
          [source, keyOrSpace]
        );
      }),
      Effect.map((rows) => {
        const maxSync = rows[0]?.max_sync;
        return maxSync ? Option.some(new Date(maxSync)) : Option.none();
      })
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
        return this.db.execute(
          `UPDATE searchable_content SET synced_at = ? WHERE source = ? AND ${column} = ?`,
          [Date.now(), source, keyOrSpace]
        );
      }),
      Effect.asVoid
    );
  }
  
  cleanupOldContent(olderThanDays: number): Effect.Effect<number, QueryError> {
    return pipe(
      Effect.sync(() => {
        const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
        return cutoffTime;
      }),
      Effect.flatMap((cutoffTime) =>
        this.db.transaction(
          pipe(
            this.logger.info('Cleaning up old content', { olderThanDays, cutoffTime }),
            Effect.flatMap(() =>
              this.db.query<{ count: number }>(
                'SELECT COUNT(*) as count FROM searchable_content WHERE synced_at < ?',
                [cutoffTime]
              )
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
                  this.db.execute('DELETE FROM content_fts WHERE id NOT IN (SELECT id FROM searchable_content)')
                ),
                Effect.map(() => count)
              );
            }),
            Effect.tap((count) =>
              this.logger.info('Cleaned up old content', { deletedCount: count })
            )
          )
        )
      )
    );
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
      if (content.content.length > 10_000_000) { // 10MB limit
        throw new ContentTooLargeError(
          'Content too large', 
          content.content.length, 
          10_000_000
        );
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
  
  private validateIssue(issue: Issue): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!issue || typeof issue !== 'object') {
        throw new ValidationError('Issue must be an object', 'issue', issue);
      }
      if (!issue.key || !issue.key.match(/^[A-Z]+-\d+$/)) {
        throw new ValidationError('Invalid issue key format', 'issue.key', issue.key);
      }
      if (!issue.fields) {
        throw new ValidationError('Issue must have fields', 'issue.fields', undefined);
      }
      if (!issue.fields.summary) {
        throw new ValidationError('Issue must have a summary', 'issue.fields.summary', undefined);
      }
      if (!issue.fields.status?.name) {
        throw new ValidationError('Issue must have a status', 'issue.fields.status', issue.fields.status);
      }
      if (!issue.fields.reporter?.displayName) {
        throw new ValidationError('Issue must have a reporter', 'issue.fields.reporter', issue.fields.reporter);
      }
    });
  }
  
  private validateIssueKey(issueKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
        throw new ValidationError('Invalid issue key format', 'issueKey', issueKey);
      }
    });
  }
  
  private validateProjectKey(projectKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!projectKey || projectKey.length === 0) {
        throw new ValidationError('Project key cannot be empty', 'projectKey', projectKey);
      }
    });
  }
  
  private validateConfluencePage(pageData: ConfluencePageData): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!pageData || typeof pageData !== 'object') {
        throw new ValidationError('Page data must be an object', 'pageData', pageData);
      }
      if (!pageData.id || pageData.id.length === 0) {
        throw new ValidationError('Page must have an ID', 'pageData.id', pageData.id);
      }
      if (!pageData.title || pageData.title.length === 0) {
        throw new ValidationError('Page must have a title', 'pageData.title', pageData.title);
      }
      if (!pageData.spaceKey || pageData.spaceKey.length === 0) {
        throw new ValidationError('Page must have a space key', 'pageData.spaceKey', pageData.spaceKey);
      }
    });
  }
  
  private validatePageId(pageId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!pageId || pageId.length === 0) {
        throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
      }
    });
  }
  
  private validateSpaceKey(spaceKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!spaceKey || spaceKey.length === 0) {
        throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
      }
    });
  }
  
  private validateSearchQuery(query: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!query || query.length === 0) {
        throw new ValidationError('Search query cannot be empty', 'query', query);
      }
      if (query.length > 1000) {
        throw new ValidationError('Search query too long', 'query', query);
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
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
      },
      catch: (error) => new ContentError(`Failed to calculate content hash: ${error}`)
    });
  }
  
  private parseContentRow(row: {
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
    content_hash?: string;
  }): Effect.Effect<SearchableContent, ParseError> {
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
        contentHash: row.content_hash
      }),
      catch: (error) => new ParseError('Failed to parse content row', 'metadata', row.metadata || '', error)
    });
  }
  
  private performFTSSearch(query: string, options: SearchOptions): Effect.Effect<SearchResult[], QueryError | ParseError> {
    return pipe(
      Effect.sync(() => {
        let sql = `
          SELECT sc.*,
            snippet(content_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
          FROM searchable_content sc
          JOIN content_fts ON content_fts.id = sc.id
          WHERE content_fts MATCH ?
        `;
        
        const params: (string | number)[] = [query];
        
        if (options.source) {
          sql += ' AND sc.source = ?';
          params.push(options.source);
        }
        
        if (options.type) {
          sql += ' AND sc.type = ?';
          params.push(options.type);
        }
        
        if (options.spaceKey) {
          sql += ' AND sc.space_key = ?';
          params.push(options.spaceKey);
        }
        
        if (options.projectKey) {
          sql += ' AND sc.project_key = ?';
          params.push(options.projectKey);
        }
        
        sql += ' ORDER BY rank';
        
        if (options.limit) {
          sql += ' LIMIT ?';
          params.push(options.limit);
        }
        
        if (options.offset) {
          sql += ' OFFSET ?';
          params.push(options.offset);
        }
        
        return { sql, params };
      }),
      Effect.flatMap(({ sql, params }) =>
        this.db.query<{
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
          content_hash?: string;
          snippet: string;
        }>(sql, params)
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          pipe(
            this.parseContentRow(row),
            Effect.map((content): SearchResult => ({
              content,
              score: 1.0, // FTS doesn't provide a score, so we use 1.0
              snippet: row.snippet
            }))
          )
        )
      )
    );
  }
  
  private buildJiraContent(issue: Issue): string {
    const parts = [
      issue.fields.summary,
      `Status: ${issue.fields.status.name}`,
      issue.fields.priority ? `Priority: ${issue.fields.priority.name}` : '',
      issue.fields.assignee ? `Assignee: ${issue.fields.assignee.displayName}` : '',
      `Reporter: ${issue.fields.reporter.displayName}`,
      this.extractDescription(issue.fields.description)
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
        return '\n' + node.content.map(n => parseNode(n)).join('') + '\n';
      }
      
      if (node.content) {
        return node.content.map(n => parseNode(n)).join('');
      }
      
      return '';
    };
    
    if (doc.content) {
      text = doc.content.map(node => parseNode(node)).join('');
    }
    
    return text.trim();
  }
  
  private extractSprintInfo(issue: Issue): SprintInfo | null {
    // Sprint information is typically stored in customfield_10020 or similar
    const fields = issue.fields as Record<string, unknown>;
    
    // Common sprint field names
    const sprintFieldNames = [
      'customfield_10020', // Most common
      'customfield_10021',
      'customfield_10016',
      'sprint',
      'sprints'
    ];
    
    for (const fieldName of sprintFieldNames) {
      const sprintData = fields[fieldName];
      if (!sprintData) continue;
      
      // Handle array of sprints (take the most recent/active one)
      if (Array.isArray(sprintData) && sprintData.length > 0) {
        const sprintString = sprintData[sprintData.length - 1];
        if (typeof sprintString === 'string') {
          // Parse sprint string format
          const idMatch = sprintString.match(/\[.*?id=(\d+)/i);
          const nameMatch = sprintString.match(/\[.*?name=([^,\]]+)/i);
          
          if (idMatch && nameMatch) {
            return {
              id: idMatch[1],
              name: nameMatch[1]
            };
          }
        } else if (typeof sprintString === 'object' && sprintString !== null) {
          const sprint = sprintString as { id?: unknown; name?: unknown };
          if (sprint.id && sprint.name) {
            return {
              id: String(sprint.id),
              name: String(sprint.name)
            };
          }
        }
      }
      
      // Handle single sprint object
      if (typeof sprintData === 'object' && sprintData !== null) {
        const sprint = sprintData as { id?: unknown; name?: unknown };
        if (sprint.id && sprint.name) {
          return {
            id: String(sprint.id),
            name: String(sprint.name)
          };
        }
      }
    }
    
    return null;
  }
}

// ============= Service Layer =============
export const ContentServiceLive = Layer.effect(
  ContentServiceTag,
  pipe(
    Effect.all({
      db: DatabaseServiceTag,
      logger: LoggerServiceTag
    }),
    Effect.map(({ db, logger }) => new ContentServiceImpl(db, logger))
  )
);

// ============= Helper Functions =============
// Use ContentServiceLive directly with Effect.provide() when needed