import { afterAll, afterEach, beforeAll } from 'bun:test';
import { setupServer } from 'msw/node';
import { handlers } from './mocks/handlers';

// Create a strict MSW server that will fail on any unhandled requests
export const server = setupServer(...handlers);

// Configure MSW to be strict about unhandled requests
beforeAll(() => {
  server.listen({
    // This will cause tests to fail if they try to make real network requests
    onUnhandledRequest: 'error',
  });

  // Log that MSW is active to help with debugging
  console.log('🔒 MSW is active - all network requests will be intercepted');
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
