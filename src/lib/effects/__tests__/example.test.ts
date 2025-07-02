/**
 * Simple example test to verify test infrastructure works
 */

import { describe, expect, test } from 'bun:test';
import { Effect, pipe } from 'effect';
import { ConfigServiceTag } from '../layers.js';
import { createTestAppLayer } from '../test-layers.js';

describe('Simple Test Example', () => {
  test('should provide test config', async () => {
    const program = pipe(
      ConfigServiceTag,
      Effect.flatMap((service) => service.getConfig),
    );

    const result = await pipe(program, Effect.provide(createTestAppLayer()), Effect.runPromise);

    expect(result.email).toBe('test@example.com');
    expect(result.jiraUrl).toBe('https://test.atlassian.net');
  });
});
