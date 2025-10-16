import { HttpResponse, http } from 'msw';
import { UserSchema } from '../../lib/effects/jira/schemas';
import { SearchResultSchema } from '../../lib/jira-client/jira-client-types';
import { createValidUser, validateAndReturn } from '../msw-schema-validation';

/**
 * Shared MSW handlers with schema validation
 * These handlers ensure all mock responses conform to our Effect schemas
 *
 * IMPORTANT: These are DEFAULT/FALLBACK handlers that prevent unhandled requests.
 * Individual tests should override these with server.use() for specific test scenarios.
 */
export const handlers = [
  // Jira user info mock with schema validation
  http.get('*/rest/api/3/myself', () => {
    const user = createValidUser({
      accountId: 'test-account-id',
      displayName: 'Test User',
      emailAddress: 'test@example.com',
    });

    return HttpResponse.json(validateAndReturn(UserSchema, user, 'Current User'));
  }),

  // Default search handler that returns empty results
  http.get('*/rest/api/3/search', () => {
    const emptySearchResult = {
      issues: [],
      startAt: 0,
      maxResults: 50,
      total: 0,
    };

    return HttpResponse.json(validateAndReturn(SearchResultSchema, emptySearchResult, 'Empty Search Results'));
  }),

  // CATCH-ALL: Return 404 for any unhandled requests
  // This ensures tests fail fast if they forget to mock an endpoint
  http.get('*', ({ request }) => {
    console.warn(`[MSW] Unhandled GET request: ${request.url}`);
    return HttpResponse.json(
      { errorMessages: ['Unhandled request - add a handler for this endpoint'] },
      { status: 404 },
    );
  }),

  http.post('*', ({ request }) => {
    console.warn(`[MSW] Unhandled POST request: ${request.url}`);
    return HttpResponse.json(
      { errorMessages: ['Unhandled request - add a handler for this endpoint'] },
      { status: 404 },
    );
  }),

  http.put('*', ({ request }) => {
    console.warn(`[MSW] Unhandled PUT request: ${request.url}`);
    return HttpResponse.json(
      { errorMessages: ['Unhandled request - add a handler for this endpoint'] },
      { status: 404 },
    );
  }),
];
