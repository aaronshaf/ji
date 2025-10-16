import { afterAll, afterEach, beforeAll } from 'bun:test';
import { setupServer } from 'msw/node';
import { handlers } from './mocks/handlers.js';

/**
 * MSW (Mock Service Worker) Setup for Bun Test Environment
 *
 * This file configures a shared MSW server for all test files. It is preloaded
 * via bunfig.toml to ensure global hooks run before any test code executes.
 *
 * ## Why preload is required:
 *
 * MSW works by intercepting global.fetch before any code runs. If test files
 * directly manipulate global.fetch (like installFetchMock() or vi.stubGlobal()),
 * they can break MSW's internal state, causing all subsequent tests to fail.
 *
 * Preloading this file ensures:
 * 1. MSW's server.listen() intercepts fetch first
 * 2. All test files share the same MSW instance
 * 3. Test isolation via server.resetHandlers() in afterEach
 *
 * ## Configuration:
 *
 * See bunfig.toml [test] section for preload configuration.
 *
 * ## Usage in tests:
 *
 * Import server from this file and use server.use() to add test-specific handlers.
 * Handlers added with server.use() are automatically reset after each test.
 *
 * @example
 * import { server } from './setup-msw';
 * import { http, HttpResponse } from 'msw';
 *
 * test('my test', async () => {
 *   server.use(
 *     http.get(endpoint, () => HttpResponse.json(data))
 *   );
 * });
 */

// Shared MSW server for all tests
// Tests add handlers using server.use() which are automatically reset after each test
export const server = setupServer(...handlers);

// Track if server has been started to prevent multiple calls to server.listen()
let serverStarted = false;

// Global hooks - MSW server is active for all tests
beforeAll(async () => {
  // Ensure we're in a test environment with fetch available
  if (typeof fetch === 'undefined') {
    console.warn('⚠️  fetch is not defined in MSW setup - skipping MSW server start');
    return;
  }

  // Only start the server once, even if multiple test files import this module
  if (!serverStarted) {
    server.listen({
      // Use 'warn' mode to log unhandled requests but don't fail tests
      onUnhandledRequest: 'warn',
    });
    serverStarted = true;
  }
});

afterEach(() => {
  // Reset handlers added with server.use() back to the original handlers
  // This prevents handler accumulation which causes performance issues and conflicts
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
