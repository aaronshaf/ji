/**
 * Streaming operations for large datasets
 */

import { Effect, pipe, Stream } from 'effect';
import type {
  ContentError,
  ContentTooLargeError,
  DataIntegrityError,
  ParseError,
  QueryError,
  ValidationError,
} from '../errors.js';
import type { DatabaseService } from '../layers.js';
import type { ContentRow, SearchableContent } from './types.js';

export interface StreamingOperations {
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
}

export class StreamingOperationsImpl implements StreamingOperations {
  constructor(
    private db: DatabaseService,
    private parseContentRow: (row: ContentRow) => Effect.Effect<SearchableContent, ParseError>,
    private saveContent: (
      content: SearchableContent,
    ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>,
    private validateContent: (
      content: SearchableContent,
    ) => Effect.Effect<void, ValidationError | ContentTooLargeError>,
    private validateProjectKey: (projectKey: string) => Effect.Effect<void, ValidationError>,
    private validateSpaceKey: (spaceKey: string) => Effect.Effect<void, ValidationError>,
  ) {}

  streamContentBySource(
    source: 'jira' | 'confluence',
  ): Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(
        this.db.query<ContentRow>('SELECT * FROM searchable_content WHERE source = ? ORDER BY synced_at DESC', [
          source,
        ]),
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) => this.parseContentRow(row)),
      Stream.rechunk(100), // Process in chunks
    );
  }

  streamContentByProject(
    projectKey: string,
  ): Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(this.validateProjectKey(projectKey)),
      Stream.flatMap(() =>
        Stream.fromEffect(
          this.db.query<ContentRow>('SELECT * FROM searchable_content WHERE project_key = ? ORDER BY synced_at DESC', [
            projectKey,
          ]),
        ),
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) => this.parseContentRow(row)),
      Stream.rechunk(50),
    );
  }

  streamContentBySpace(spaceKey: string): Stream.Stream<SearchableContent, ValidationError | QueryError | ParseError> {
    return pipe(
      Stream.fromEffect(this.validateSpaceKey(spaceKey)),
      Stream.flatMap(() =>
        Stream.fromEffect(
          this.db.query<ContentRow>('SELECT * FROM searchable_content WHERE space_key = ? ORDER BY synced_at DESC', [
            spaceKey,
          ]),
        ),
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) => this.parseContentRow(row)),
      Stream.rechunk(50),
    );
  }

  batchSaveContent(
    content: SearchableContent[],
  ): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
    return pipe(
      Effect.forEach(content, (item) => this.validateContent(item)),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            Stream.fromIterable(content),
            Stream.mapEffect((item) => this.saveContent(item)),
            Stream.runDrain,
          ),
        ),
      ),
    );
  }
}
