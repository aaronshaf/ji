/**
 * Confluence Batch Operations
 * Batch operations for multiple pages
 */

import { Effect, pipe, Stream } from 'effect';
import type { NotFoundError, ValidationError } from '../errors.js';
import type { LoggerService } from '../layers.js';
import type { Page } from './schemas.js';
import type { AllErrors, CommonErrors, ContentUpdateOptions } from './types.js';

export class BatchOperations {
  constructor(
    private logger: LoggerService,
    private getPage: (pageId: string) => Effect.Effect<Page, AllErrors>,
    private updatePage: (pageId: string, options: ContentUpdateOptions) => Effect.Effect<Page, AllErrors>,
  ) {}

  batchGetPages(pageIds: string[], concurrency: number = 5): Stream.Stream<Page, AllErrors> {
    return pipe(
      Stream.fromIterable(pageIds),
      Stream.mapEffect((pageId) =>
        pipe(
          this.getPage(pageId),
          Effect.catchAll((error) => {
            // Log error but don't fail the entire stream
            return pipe(
              this.logger.warn('Failed to fetch page in batch', { pageId, error: error.message }),
              Effect.flatMap(() => Effect.fail(error)),
            );
          }),
        ),
      ),
      Stream.buffer({ capacity: concurrency }),
      Stream.rechunk(10),
    );
  }

  batchUpdatePages(
    updates: Array<{ pageId: string; options: ContentUpdateOptions }>,
  ): Effect.Effect<
    Array<{ pageId: string; success: boolean; error?: string }>,
    ValidationError | CommonErrors | NotFoundError
  > {
    return pipe(
      Effect.forEach(updates, ({ pageId, options }) =>
        pipe(
          this.updatePage(pageId, options),
          Effect.map(() => ({ pageId, success: true as const })),
          Effect.catchAll((error) =>
            Effect.succeed({
              pageId,
              success: false as const,
              error: error.message,
            }),
          ),
        ),
      ),
    );
  }
}
