/**
 * Type-safe fetch mock utilities for tests
 */
import { type Mock, mock } from 'bun:test';

// Save the original fetch at module load time
const originalFetch = global.fetch;

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
 * IMPORTANT: This restores the fetch that was available when this module loaded,
 * which allows MSW and other fetch interceptors to work correctly.
 */
export function restoreFetch(): void {
  // Restore the original fetch that was saved at module load time
  // This ensures compatibility with MSW and other fetch interceptors
  global.fetch = originalFetch;
}
