/**
 * Confluence Module Index
 * Re-exports all public interfaces and types
 */

// Export the implementation and layer
export { ConfluenceClientServiceImpl } from './implementation.js';
export * from './interface.js';
// Export schemas and types
export * from './schemas.js';
export * from './types.js';

// Export the Layer creation
import { Effect, Layer, pipe } from 'effect';
import { ConfigServiceTag, HttpClientServiceTag, LoggerServiceTag } from '../layers.js';
import { ConfluenceClientServiceImpl } from './implementation.js';
import { ConfluenceClientServiceTag } from './interface.js';

export const ConfluenceClientServiceLive = Layer.effect(
  ConfluenceClientServiceTag,
  pipe(
    Effect.all({
      http: HttpClientServiceTag,
      config: ConfigServiceTag,
      logger: LoggerServiceTag,
    }),
    Effect.map(({ http, config, logger }) => new ConfluenceClientServiceImpl(http, config, logger)),
  ),
);
