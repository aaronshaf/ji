import { HttpResponse, http } from 'msw';
import { server } from './setup-msw';

/**
 * Utility to ensure a test is using MSW and will fail on real network requests
 */
export function ensureMSWActive() {
  // This will throw if MSW is not active
  const listeners = server.listHandlers();
  if (listeners.length === 0) {
    throw new Error('MSW is not configured! Tests must not make real API calls.');
  }
}

/**
 * Add a temporary mock for a specific test
 */
export function mockAPI(method: 'get' | 'post' | 'put' | 'delete', url: string, response: unknown, status = 200) {
  const handler = http[method](url, () => {
    return HttpResponse.json(response as Record<string, unknown>, { status });
  });

  server.use(handler);
}

/**
 * Mock a Jira API error response
 */
export function mockJiraError(issueKey: string, status: number, message?: string) {
  // Use more specific URL pattern
  server.use(
    http.get('https://example.atlassian.net/rest/api/3/issue/:issueKey', ({ params }) => {
      if (params.issueKey === issueKey) {
        if (status === 404) {
          return HttpResponse.json(
            { errorMessages: [`Issue ${issueKey} does not exist or you do not have permission to see it.`] },
            { status: 404 },
          );
        }
        return new HttpResponse(message || 'Error', { status });
      }
      return new HttpResponse(null, { status: 404 });
    }),
  );
}

/**
 * Mock a successful Jira issue response
 */
export function mockJiraIssue(issueKey: string, fields: Record<string, unknown> = {}) {
  // Use more specific URL pattern
  server.use(
    http.get('https://example.atlassian.net/rest/api/3/issue/:issueKey', ({ params }) => {
      if (params.issueKey === issueKey) {
        return HttpResponse.json({
          id: '12345',
          key: issueKey,
          fields: {
            summary: 'Test Issue',
            description: 'Test Description',
            status: { name: 'Open' },
            priority: { name: 'Medium' },
            ...fields,
          },
        });
      }
      return new HttpResponse(null, { status: 404 });
    }),
  );
}
