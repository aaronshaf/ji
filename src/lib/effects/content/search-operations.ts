/**
 * Search and indexing operations
 */

import { Effect, Option, pipe } from 'effect';
import {
  type ContentTooLargeError,
  type DatabaseError,
  type ParseError,
  type QueryError,
  ValidationError,
} from '../errors.js';
import type { DatabaseService } from '../layers.js';
import type { ContentRowWithSnippet, SearchableContent, SearchOptions, SearchResult } from './types.js';

export interface SearchOperations {
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
  readonly validateSearchQuery: (query: string) => Effect.Effect<void, ValidationError>;
}

export class SearchOperationsImpl implements SearchOperations {
  constructor(
    private db: DatabaseService,
    private getContent: (
      id: string,
    ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>,
    private parseContentRow: (row: ContentRowWithSnippet) => Effect.Effect<SearchableContent, ParseError>,
    private validateContent: (
      content: SearchableContent,
    ) => Effect.Effect<void, ValidationError | ContentTooLargeError>,
    private validateContentId: (id: string) => Effect.Effect<void, ValidationError>,
  ) {}

  searchContent(
    query: string,
    options: SearchOptions = {},
  ): Effect.Effect<SearchResult[], ValidationError | QueryError | ParseError> {
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
                onSome: (content) => [
                  {
                    content,
                    score: 1.0,
                    snippet: content.title,
                  },
                ],
              }),
            ),
          );
        }

        return this.performFTSSearch(query, options);
      }),
    );
  }

  indexToFTS(
    content: SearchableContent,
  ): Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError> {
    return pipe(
      this.validateContent(content),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.db.execute('DELETE FROM content_fts WHERE id = ?', [content.id]),
            Effect.flatMap(() =>
              this.db.execute('INSERT INTO content_fts (id, title, content) VALUES (?, ?, ?)', [
                content.id,
                content.title,
                content.content,
              ]),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  updateContentHash(
    id: string,
    newHash: string,
  ): Effect.Effect<void, ValidationError | QueryError | ContentTooLargeError | DatabaseError> {
    return pipe(
      this.validateContentId(id),
      Effect.flatMap(() =>
        this.db.execute('UPDATE searchable_content SET content_hash = ? WHERE id = ?', [newHash, id]),
      ),
      Effect.asVoid,
    );
  }

  validateSearchQuery(query: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!query || query.length === 0) {
        throw new ValidationError('Search query cannot be empty', 'query', query);
      }
      if (query.length > 1000) {
        throw new ValidationError('Search query too long', 'query', query);
      }
    });
  }

  private performFTSSearch(
    query: string,
    options: SearchOptions,
  ): Effect.Effect<SearchResult[], QueryError | ParseError> {
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
      Effect.flatMap(({ sql, params }) => this.db.query<ContentRowWithSnippet>(sql, params)),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          pipe(
            this.parseContentRow(row),
            Effect.map(
              (content): SearchResult => ({
                content,
                score: 1.0, // FTS doesn't provide a score, so we use 1.0
                snippet: row.snippet,
              }),
            ),
          ),
        ),
      ),
    );
  }
}
