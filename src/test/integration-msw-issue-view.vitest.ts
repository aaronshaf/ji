import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '../lib/jira-client/jira-client-types';
import { server } from './setup-msw-vitest';

// Real MSW integration test for issue view command
describe('MSW Integration: ji issue view', () => {
  const mockIssue: Issue = {
    key: 'TEST-123',
    self: 'https://test.atlassian.net/rest/api/3/issue/TEST-123',
    fields: {
      summary: 'MSW Integration Test Issue',
      description: 'This issue is fetched via MSW',
      status: {
        name: 'In Progress',
      },
      assignee: {
        displayName: 'MSW Test User',
        emailAddress: 'msw@example.com',
      },
      reporter: {
        displayName: 'MSW Reporter',
        emailAddress: 'reporter@example.com',
      },
      priority: {
        name: 'High',
      },
      created: '2024-01-01T10:00:00.000Z',
      updated: '2024-01-02T15:30:00.000Z',
      issuetype: {
        name: 'Bug',
      },
      labels: ['msw', 'integration', 'test'],
      project: {
        key: 'TEST',
        name: 'Test Project',
      },
    },
  };

  beforeEach(() => {
    // Override default handlers for this specific test
    server.use(
      // Mock Jira API endpoints
      http.get('https://test.atlassian.net/rest/api/3/issue/TEST-123', () => {
        return HttpResponse.json(mockIssue);
      }),

      // Mock user info endpoint
      http.get('https://test.atlassian.net/rest/api/3/myself', () => {
        return HttpResponse.json({
          accountId: 'test-account-id',
          displayName: 'Test User',
          emailAddress: 'test@example.com',
        });
      }),
    );
  });

  it('should intercept HTTP requests with MSW', async () => {
    // Allow real API calls for this test since MSW will intercept them
    process.env.ALLOW_REAL_API_CALLS = 'true';

    try {
      // Import after setting env var to bypass protection
      const { JiraClient } = await import('../lib/jira-client');

      const client = new JiraClient({
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'mock-token',
      });

      // This should be intercepted by MSW
      const issue = await client.getIssue('TEST-123');

      // Verify MSW intercepted and returned our mock data
      expect(issue.key).toBe('TEST-123');
      expect(issue.fields.summary).toBe('MSW Integration Test Issue');
      expect(issue.fields.assignee?.displayName).toBe('MSW Test User');
      expect(issue.fields.status.name).toBe('In Progress');
      expect(issue.fields.priority?.name).toBe('High');
    } finally {
      delete process.env.ALLOW_REAL_API_CALLS;
    }
  });

  it('should handle 404 errors via MSW', async () => {
    // Mock a 404 response
    server.use(
      http.get('https://test.atlassian.net/rest/api/3/issue/MISSING-999', () => {
        return HttpResponse.json(
          { errorMessages: ['Issue does not exist or you do not have permission to see it.'] },
          { status: 404 },
        );
      }),
    );

    process.env.ALLOW_REAL_API_CALLS = 'true';

    try {
      const { JiraClient } = await import('../lib/jira-client');
      const client = new JiraClient({
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'mock-token',
      });

      // This should throw due to 404
      await expect(client.getIssue('MISSING-999')).rejects.toThrow();
    } finally {
      delete process.env.ALLOW_REAL_API_CALLS;
    }
  });

  it('should handle network timeouts via MSW', async () => {
    // Mock a network timeout
    server.use(
      http.get('https://test.atlassian.net/rest/api/3/issue/TIMEOUT-123', () => {
        // Simulate a network timeout by not responding
        return HttpResponse.error();
      }),
    );

    process.env.ALLOW_REAL_API_CALLS = 'true';

    try {
      const { JiraClient } = await import('../lib/jira-client');
      const client = new JiraClient({
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'mock-token',
      });

      // This should throw due to network error
      await expect(client.getIssue('TIMEOUT-123')).rejects.toThrow();
    } finally {
      delete process.env.ALLOW_REAL_API_CALLS;
    }
  });

  it('should demonstrate MSW is working by intercepting multiple requests', async () => {
    let requestCount = 0;

    // Track all requests
    server.use(
      http.get('https://test.atlassian.net/rest/api/3/issue/*', () => {
        requestCount++;
        return HttpResponse.json(mockIssue);
      }),
    );

    process.env.ALLOW_REAL_API_CALLS = 'true';

    try {
      const { JiraClient } = await import('../lib/jira-client');
      const client = new JiraClient({
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'mock-token',
      });

      // Make multiple requests
      await client.getIssue('TEST-1');
      await client.getIssue('TEST-2');
      await client.getIssue('TEST-3');

      // Verify MSW intercepted all requests
      expect(requestCount).toBe(3);
    } finally {
      delete process.env.ALLOW_REAL_API_CALLS;
    }
  });
});
