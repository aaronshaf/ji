/**
 * Effect-based Cache Service
 * Replaces the traditional CacheManager with a fully Effect-based implementation
 */

import { Context, Effect, Layer, Option, pipe, Schema, Stream } from 'effect';
import type { Issue } from '../jira-client/jira-client-types.js';
import type { Board } from './jira-client-service.js';
import { type DatabaseService, DatabaseServiceTag } from './layers.js';

// ADF (Atlassian Document Format) schema
interface ADFNode {
  readonly type: string;
  readonly text?: string;
  readonly content?: readonly ADFNode[];
}

const ADFNodeSchema: Schema.Schema<ADFNode> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    content: Schema.optional(Schema.Array(ADFNodeSchema)),
  }),
);

const ADFDocumentSchema = Schema.Struct({
  content: Schema.optional(Schema.Array(ADFNodeSchema)),
});

import { ConcurrencyError, type DataIntegrityError, ParseError, type QueryError, ValidationError } from './errors.js';

// ============= Cache Service Interface =============
export interface CacheService {
  // Issue operations
  readonly getIssue: (key: string) => Effect.Effect<Option.Option<Issue>, ValidationError | QueryError | ParseError>;
  readonly saveIssue: (
    issue: Issue,
  ) => Effect.Effect<void, ValidationError | QueryError | DataIntegrityError | ConcurrencyError>;
  readonly deleteIssue: (key: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly listIssuesByProject: (
    projectKey: string,
  ) => Effect.Effect<Issue[], ValidationError | QueryError | ParseError>;
  readonly deleteProjectIssues: (projectKey: string) => Effect.Effect<void, ValidationError | QueryError>;

  // Board operations
  readonly getBoard: (id: number) => Effect.Effect<Option.Option<Board>, ValidationError | QueryError | ParseError>;
  readonly saveBoard: (board: Board) => Effect.Effect<void, ValidationError | QueryError | DataIntegrityError>;
  readonly saveBoards: (boards: Board[]) => Effect.Effect<void, ValidationError | QueryError | DataIntegrityError>;
  readonly listBoards: () => Effect.Effect<Board[], QueryError | ParseError>;
  readonly getBoardCount: () => Effect.Effect<number, QueryError>;

  // Cache management
  readonly clearCache: () => Effect.Effect<void, QueryError>;
  readonly getStats: () => Effect.Effect<CacheStats, QueryError>;
  readonly compact: () => Effect.Effect<void, QueryError>;

  // Streaming operations for large datasets
  readonly streamIssuesByProject: (
    projectKey: string,
  ) => Stream.Stream<Issue, ValidationError | QueryError | ParseError>;
  readonly batchSaveIssues: (
    issues: Issue[],
  ) => Effect.Effect<void, ValidationError | QueryError | DataIntegrityError | ConcurrencyError>;
}

export interface CacheStats {
  totalIssues: number;
  totalBoards: number;
  projectCounts: Record<string, number>;
  lastSync: Date | null;
  cacheSize: number; // in bytes
}

export class CacheServiceTag extends Context.Tag('CacheService')<CacheServiceTag, CacheService>() {}

// ============= Cache Service Implementation =============
class CacheServiceImpl implements CacheService {
  constructor(private db: DatabaseService) {}

  // ============= Issue Operations =============
  getIssue(key: string): Effect.Effect<Option.Option<Issue>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateIssueKey(key),
      Effect.flatMap(() => this.db.query<{ raw_data: string }>('SELECT raw_data FROM issues WHERE key = ?', [key])),
      Effect.flatMap((rows) => {
        if (rows.length === 0) {
          return Effect.succeed(Option.none());
        }
        return pipe(
          Effect.try({
            try: () => JSON.parse(rows[0].raw_data) as Issue,
            catch: (error) => new ParseError(`Failed to parse issue ${key}`, 'raw_data', rows[0].raw_data, error),
          }),
          Effect.map(Option.some),
        );
      }),
    );
  }

  saveIssue(issue: Issue): Effect.Effect<void, ValidationError | QueryError | DataIntegrityError | ConcurrencyError> {
    return pipe(
      this.validateIssue(issue),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            // Check for concurrent modifications
            this.checkIssueVersion(issue),
            Effect.flatMap(() =>
              this.db.execute(
                `INSERT OR REPLACE INTO issues (
                  key, project_key, summary, status, priority, 
                  assignee_name, assignee_email, reporter_name, reporter_email,
                  created, updated, description, raw_data, synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  issue.key,
                  issue.fields.project?.key || 'UNKNOWN',
                  issue.fields.summary,
                  issue.fields.status.name,
                  issue.fields.priority?.name || null,
                  issue.fields.assignee?.displayName || null,
                  issue.fields.assignee?.emailAddress || null,
                  issue.fields.reporter.displayName,
                  issue.fields.reporter.emailAddress || null,
                  new Date(issue.fields.created).getTime(),
                  new Date(issue.fields.updated).getTime(),
                  this.extractDescription(
                    issue.fields.description as string | { content?: unknown[] } | null | undefined,
                  ),
                  JSON.stringify(issue),
                  Date.now(),
                ],
              ),
            ),
            Effect.tap(() => this.updateProjectCache(issue.fields.project?.key || 'UNKNOWN')),
            Effect.asVoid,
          ),
        ),
      ),
    );
  }

  deleteIssue(key: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateIssueKey(key),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.db.execute('DELETE FROM issues WHERE key = ?', [key]),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM searchable_content WHERE id = ? AND source = ?', [`jira:${key}`, 'jira']),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  listIssuesByProject(projectKey: string): Effect.Effect<Issue[], ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() =>
        this.db.query<{ raw_data: string }>('SELECT raw_data FROM issues WHERE project_key = ? ORDER BY updated DESC', [
          projectKey,
        ]),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.try({
            try: () => JSON.parse(row.raw_data) as Issue,
            catch: (error) =>
              new ParseError(`Failed to parse issue in project ${projectKey}`, 'raw_data', row.raw_data, error),
          }),
        ),
      ),
    );
  }

  deleteProjectIssues(projectKey: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.db.execute('DELETE FROM issues WHERE project_key = ?', [projectKey]),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM searchable_content WHERE project_key = ? AND source = ?', [
                projectKey,
                'jira',
              ]),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  // ============= Board Operations =============
  getBoard(id: number): Effect.Effect<Option.Option<Board>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateBoardId(id),
      Effect.flatMap(() =>
        this.db.query<{
          id: number;
          name: string;
          type: string;
          project_key: string;
          project_name: string;
          self_url: string;
        }>('SELECT id, name, type, project_key, project_name, self_url FROM boards WHERE id = ?', [id]),
      ),
      Effect.map((rows) => {
        if (rows.length === 0) {
          return Option.none();
        }
        const row = rows[0];
        return Option.some({
          id: row.id,
          name: row.name,
          type: row.type as 'scrum' | 'kanban',
          location: row.project_key
            ? {
                projectKey: row.project_key,
                projectName: row.project_name,
              }
            : undefined,
          self: row.self_url,
        } as Board);
      }),
    );
  }

  saveBoard(board: Board): Effect.Effect<void, ValidationError | QueryError | DataIntegrityError> {
    return pipe(
      this.validateBoard(board),
      Effect.flatMap(() =>
        this.db.execute(
          `INSERT OR REPLACE INTO boards (
            id, name, type, project_key, project_name, self_url, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            board.id,
            board.name,
            board.type,
            board.location?.projectKey || null,
            board.location?.projectName || null,
            board.self,
            Date.now(),
          ],
        ),
      ),
      Effect.asVoid,
    );
  }

  saveBoards(boards: Board[]): Effect.Effect<void, ValidationError | QueryError | DataIntegrityError> {
    return pipe(
      Effect.forEach(boards, (board) => this.validateBoard(board)),
      Effect.flatMap(() => this.db.transaction(Effect.forEach(boards, (board) => this.saveBoard(board)))),
      Effect.asVoid,
    );
  }

  listBoards(): Effect.Effect<Board[], QueryError | ParseError> {
    return pipe(
      this.db.query<{
        id: number;
        name: string;
        type: string;
        project_key: string | null;
        project_name: string | null;
        self_url: string;
      }>('SELECT id, name, type, project_key, project_name, self_url FROM boards ORDER BY name'),
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              id: row.id,
              name: row.name,
              type: row.type as 'scrum' | 'kanban',
              location: row.project_key
                ? {
                    projectKey: row.project_key,
                    projectName: row.project_name || '',
                  }
                : undefined,
              self: row.self_url,
            }) as Board,
        ),
      ),
    );
  }

  getBoardCount(): Effect.Effect<number, QueryError> {
    return pipe(
      this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM boards'),
      Effect.map((rows) => rows[0]?.count || 0),
    );
  }

  // ============= Cache Management =============
  clearCache(): Effect.Effect<void, QueryError> {
    return pipe(
      this.db.transaction(
        pipe(
          this.db.execute('DELETE FROM issues'),
          Effect.flatMap(() => this.db.execute('DELETE FROM boards')),
          Effect.flatMap(() => this.db.execute('DELETE FROM searchable_content')),
          Effect.flatMap(() => this.db.execute('VACUUM')),
        ),
      ),
      Effect.asVoid,
    );
  }

  getStats(): Effect.Effect<CacheStats, QueryError> {
    return Effect.all({
      totalIssues: pipe(
        this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM issues'),
        Effect.map((rows) => rows[0]?.count || 0),
      ),
      totalBoards: this.getBoardCount(),
      projectCounts: pipe(
        this.db.query<{ project_key: string; count: number }>(
          'SELECT project_key, COUNT(*) as count FROM issues GROUP BY project_key',
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
        this.db.query<{ max_sync: number | null }>('SELECT MAX(synced_at) as max_sync FROM issues'),
        Effect.map((rows) => {
          const maxSync = rows[0]?.max_sync;
          return maxSync ? new Date(maxSync) : null;
        }),
      ),
      cacheSize: pipe(
        this.db.query<{ size: number }>(
          'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()',
        ),
        Effect.map((rows) => rows[0]?.size || 0),
      ),
    });
  }

  compact(): Effect.Effect<void, QueryError> {
    return pipe(this.db.execute('VACUUM'), Effect.asVoid);
  }

  // ============= Streaming Operations =============
  streamIssuesByProject(projectKey: string): Stream.Stream<Issue, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(this.validateProjectKey(projectKey)),
      Stream.flatMap(() =>
        Stream.fromEffect(
          this.db.query<{ raw_data: string }>(
            'SELECT raw_data FROM issues WHERE project_key = ? ORDER BY updated DESC',
            [projectKey],
          ),
        ),
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) =>
        Effect.try({
          try: () => JSON.parse(row.raw_data) as Issue,
          catch: (error) =>
            new ParseError(`Failed to parse issue in project ${projectKey}`, 'raw_data', row.raw_data, error),
        }),
      ),
      Stream.rechunk(100), // Process in chunks of 100
    );
  }

  batchSaveIssues(
    issues: Issue[],
  ): Effect.Effect<void, ValidationError | QueryError | DataIntegrityError | ConcurrencyError> {
    return pipe(
      Effect.forEach(issues, (issue) => this.validateIssue(issue)),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            Stream.fromIterable(issues),
            Stream.mapEffect((issue) => this.saveIssue(issue)),
            Stream.runDrain,
          ),
        ),
      ),
    );
  }

  // ============= Private Validation Methods =============
  private validateIssueKey(key: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!key || !key.match(/^[A-Z]+-\d+$/)) {
        throw new ValidationError('Invalid issue key format', 'key', key);
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

  private validateBoardId(id: number): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!id || id <= 0) {
        throw new ValidationError('Board ID must be a positive number', 'id', id);
      }
    });
  }

  private validateIssue(issue: Issue): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!issue) {
        throw new ValidationError('Issue cannot be null or undefined', 'issue', issue);
      }
      if (!issue.key) {
        throw new ValidationError('Issue key is required', 'issue.key', issue.key);
      }
      if (!issue.fields) {
        throw new ValidationError('Issue fields are required', 'issue.fields', issue.fields);
      }
    });
  }

  private validateBoard(board: Board): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!board) {
        throw new ValidationError('Board cannot be null or undefined', 'board', board);
      }
      if (!board.id || board.id <= 0) {
        throw new ValidationError('Board ID must be a positive number', 'board.id', board.id);
      }
      if (!board.name) {
        throw new ValidationError('Board name is required', 'board.name', board.name);
      }
    });
  }

  private checkIssueVersion(issue: Issue): Effect.Effect<void, QueryError | ConcurrencyError> {
    return pipe(
      this.db.query<{ updated: number }>('SELECT updated FROM issues WHERE key = ?', [issue.key]),
      Effect.flatMap((rows) => {
        if (rows.length > 0) {
          const cachedUpdated = new Date(rows[0].updated);
          const issueUpdated = new Date(issue.fields.updated);

          if (cachedUpdated > issueUpdated) {
            return Effect.fail(new ConcurrencyError('Issue has been updated by another process', issue.key, 'save'));
          }
        }
        return Effect.succeed(undefined);
      }),
    );
  }

  private updateProjectCache(projectKey: string): Effect.Effect<void, QueryError> {
    return this.db
      .execute('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)', [projectKey, projectKey])
      .pipe(Effect.asVoid);
  }

  private extractDescription(description: string | { content?: unknown[] } | null | undefined): string {
    if (typeof description === 'string') {
      return description;
    }

    if (description?.content) {
      return this.parseADF(description);
    }

    return '';
  }

  private parseADF(doc: { content?: unknown[] }): string {
    return pipe(
      Effect.try({
        try: () => Schema.decodeUnknownSync(ADFDocumentSchema)(doc),
        catch: () => ({ content: [] as ADFNode[] }), // Fallback to empty content
      }),
      Effect.map((validatedDoc) => {
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

        if (validatedDoc.content) {
          return validatedDoc.content
            .map((node) => parseNode(node))
            .join('')
            .trim();
        }

        return '';
      }),
      Effect.runSync,
    );
  }
}

// ============= Service Layer =============
export const CacheServiceLive = Layer.effect(
  CacheServiceTag,
  pipe(
    DatabaseServiceTag,
    Effect.map((db) => new CacheServiceImpl(db)),
  ),
);

// ============= Helper Functions =============
// Use CacheServiceLive directly with Effect.provide() when needed
