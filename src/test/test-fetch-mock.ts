/**
 * Type-safe fetch mock utilities for tests
 */
import { type Mock, mock } from 'bun:test';

/**
 * Create a properly typed fetch mock that satisfies the global fetch interface
 */
export function createFetchMock(handler: (url: string | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  // Create the base mock
  const fetchMock = mock(handler) as Mock<typeof handler>;

  // Add the required fetch properties
  const typedFetch = Object.assign(fetchMock, {
    // Add the preconnect method that TypeScript expects
    preconnect: () => {
      // No-op for tests
    },
  }) as typeof fetch;

  return typedFetch;
}

/**
 * Install a fetch mock globally
 */
export function installFetchMock(handler: (url: string | URL, init?: RequestInit) => Promise<Response>): void {
  global.fetch = createFetchMock(handler);
}

/**
 * Restore the original fetch
 */
export function restoreFetch(): void {
  // In Bun, we can't truly restore fetch, but we can set it to a no-op
  // that throws to catch any unexpected calls
  const errorFetch = Object.assign(
    () => {
      throw new Error('fetch was called after being restored. Did you forget to mock it?');
    },
    {
      preconnect: () => {
        throw new Error('fetch.preconnect was called after being restored');
      },
    },
  ) as typeof fetch;

  global.fetch = errorFetch;
}
