import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { HttpClientServiceLive, HttpClientServiceTag } from '../lib/effects/layers';

test('HttpClientService blocks real HTTP calls in test environment', () => {
  expect(() => {
    // This should throw when trying to create the live layer in test environment
    const layer = HttpClientServiceLive;
    const program = Effect.gen(function* () {
      yield* HttpClientServiceTag;
    });

    // Trying to provide the live layer should fail
    Effect.runSync(Effect.provide(program, layer));
  }).toThrow('Real HTTP calls detected in test environment!');
});

test('HttpClientService protection can be bypassed with ALLOW_REAL_API_CALLS=true', () => {
  // Temporarily allow real API calls
  process.env.ALLOW_REAL_API_CALLS = 'true';

  try {
    // This should not throw now
    const layer = HttpClientServiceLive;
    const program = Effect.gen(function* () {
      const httpClient = yield* HttpClientServiceTag;
      return httpClient;
    });

    const result = Effect.runSync(Effect.provide(program, layer));
    expect(result).toBeDefined();
  } finally {
    // Clean up
    delete process.env.ALLOW_REAL_API_CALLS;
  }
});
