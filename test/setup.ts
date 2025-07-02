/**
 * Global test setup for Effect-based tests
 */

// Set up global test environment
globalThis.beforeEach = () => {
  // Reset any global state
};

// Configure test timeouts
export const DEFAULT_TEST_TIMEOUT = 10000; // 10 seconds

// Export test utilities
export { expect } from 'bun:test';
export { Effect, Layer, pipe, Ref } from 'effect';
export * from '../src/lib/effects/test-layers.js';
