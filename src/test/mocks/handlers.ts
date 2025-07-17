import { HttpResponse, http } from 'msw';

export const handlers = [
  // Basic handlers that tests can override

  // Jira user info mock - commonly needed
  http.get('*/rest/api/3/myself', () => {
    return HttpResponse.json({
      accountId: 'test-account-id',
      displayName: 'Test User',
      emailAddress: 'test@example.com',
    });
  }),

  // Note: Individual tests should mock specific issue endpoints
  // This prevents tests from accidentally getting wrong data
];
