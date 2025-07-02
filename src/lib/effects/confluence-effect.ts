import { Effect, pipe } from 'effect';
import type { ConfluenceClient, Page } from '../confluence-client';
import { ConfluenceError, NotFoundError } from './errors';

export class ConfluenceEffectClient {
  constructor(private client: ConfluenceClient) {}

  getPageEffect(pageId: string): Effect.Effect<Page, ConfluenceError | NotFoundError> {
    return pipe(
      Effect.tryPromise({
        try: () => this.client.getPage(pageId),
        catch: (error) => new ConfluenceError(`Failed to get page ${pageId}`, error),
      }),
      Effect.filterOrFail(
        (page): page is Page => page !== null,
        () => new NotFoundError(`Page ${pageId} not found`),
      ),
    );
  }

  // TODO: Implement search when client method is available
  // searchEffect(query: string): Effect.Effect<Page[], ConfluenceError> {
  //   return Effect.tryPromise({
  //     try: () => this.client.search(query),
  //     catch: (error) => new ConfluenceError(`Search failed: ${query}`, error),
  //   });
  // }
}
