import { HttpResponse, http } from 'msw';
import { UserSchema } from '../../lib/effects/jira/schemas';
import { SearchResultSchema } from '../../lib/jira-client/jira-client-types';
import { createValidUser, validateAndReturn } from '../msw-schema-validation';

/**
 * Shared MSW handlers with schema validation
 * These handlers ensure all mock responses conform to our Effect schemas
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

  // Note: Individual tests should override these handlers with specific mocks
  // This prevents tests from accidentally getting wrong data
];
