/**
 * Confluence-specific content operations
 */

import { Effect, type Option, pipe } from 'effect';
import {
  type ContentError,
  type ContentTooLargeError,
  type DatabaseError,
  type DataIntegrityError,
  ParseError,
  type QueryError,
  ValidationError,
} from '../errors.js';
import type { DatabaseService, LoggerService } from '../layers.js';
import type { ConfluencePageData, PageVersionInfo, SearchableContent } from './types.js';

export interface ConfluenceContentOperations {
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
  readonly validateConfluencePage: (pageData: ConfluencePageData) => Effect.Effect<void, ValidationError>;
  readonly validatePageId: (pageId: string) => Effect.Effect<void, ValidationError>;
  readonly validateSpaceKey: (spaceKey: string) => Effect.Effect<void, ValidationError>;
}

export class ConfluenceContentOperationsImpl implements ConfluenceContentOperations {
  constructor(
    private db: DatabaseService,
    private logger: LoggerService,
    private saveContent: (
      content: SearchableContent,
    ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>,
    private getContent: (
      id: string,
    ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>,
  ) {}

  saveConfluencePage(
    pageData: ConfluencePageData,
  ): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
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
            version: pageData.version,
          },
          createdAt: pageData.createdAt,
          updatedAt: pageData.updatedAt,
          syncedAt: Date.now(),
        }),
      ),
    );
  }

  getConfluencePage(
    pageId: string,
  ): Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validatePageId(pageId),
      Effect.flatMap(() => this.getContent(`confluence:${pageId}`)),
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
              this.db.execute('DELETE FROM searchable_content WHERE space_key = ? AND source = ?', [
                spaceKey,
                'confluence',
              ]),
            ),
            Effect.flatMap(() =>
              this.db.execute(
                'DELETE FROM content_fts WHERE id IN (SELECT id FROM searchable_content WHERE space_key = ? AND source = ?)',
                [spaceKey, 'confluence'],
              ),
            ),
            Effect.tap(() => this.logger.debug('Space content deleted successfully', { spaceKey })),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  getSpacePageVersions(
    spaceKey: string,
  ): Effect.Effect<Map<string, PageVersionInfo>, QueryError | ParseError | ValidationError | DatabaseError> {
    return pipe(
      this.validateSpaceKey(spaceKey),
      Effect.flatMap(() =>
        this.db.query<{
          id: string;
          updated_at: number;
          synced_at: number;
          metadata: string;
        }>('SELECT id, updated_at, synced_at, metadata FROM searchable_content WHERE space_key = ? AND source = ?', [
          spaceKey,
          'confluence',
        ]),
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
                syncedAt: row.synced_at,
              });
            }

            return versionMap;
          },
          catch: (error) =>
            new ParseError('Failed to parse page version data', 'metadata', JSON.stringify(rows), error),
        }),
      ),
    );
  }

  hasContentChanged(id: string, newContentHash: string): Effect.Effect<boolean, ValidationError | QueryError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.query<{ content_hash?: string }>('SELECT content_hash FROM searchable_content WHERE id = ?', [id]),
      ),
      Effect.map((rows) => {
        if (rows.length === 0) return true; // Content doesn't exist, so it's "changed"
        return rows[0].content_hash !== newContentHash;
      }),
    );
  }

  validateConfluencePage(pageData: ConfluencePageData): Effect.Effect<void, ValidationError> {
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

  validatePageId(pageId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!pageId || pageId.length === 0) {
        throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
      }
    });
  }

  validateSpaceKey(spaceKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!spaceKey || spaceKey.length === 0) {
        throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
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
}
