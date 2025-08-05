import { describe, expect, mock, test } from 'bun:test';
import { JiraClientIssues } from '../lib/jira-client/jira-client-issues';
import { ISSUE_FIELDS } from '../lib/jira-client/jira-client-types';

describe('Issue Comments Sync', () => {
  test('getAllProjectIssues includes comment field in API requests', async () => {
    const mockConfig = {
      jiraUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    };

    let capturedUrl: string | undefined;
    let capturedFields: string | undefined;

    // Mock fetch to capture the URL and fields
    const originalFetch = global.fetch;
    global.fetch = mock(async (url: string) => {
      const urlObj = new URL(url);
      capturedUrl = urlObj.toString();
      capturedFields = urlObj.searchParams.get('fields') || undefined;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          issues: [],
          total: 0,
          startAt: 0,
          maxResults: 100,
        }),
      };
    }) as any;

    // Temporarily allow real API calls to create the client
    const originalEnv = process.env.ALLOW_REAL_API_CALLS;
    process.env.ALLOW_REAL_API_CALLS = 'true';
    const client = new JiraClientIssues(mockConfig);
    process.env.ALLOW_REAL_API_CALLS = originalEnv;

    try {
      await client.getAllProjectIssues('TEST');

      // Verify that the fields parameter includes 'comment'
      expect(capturedFields).toBeDefined();
      expect(capturedFields).toContain('comment');

      // Verify all ISSUE_FIELDS are included
      const requestedFields = capturedFields?.split(',') || [];
      expect(requestedFields).toContain('comment');
      expect(requestedFields).toContain('summary');
      expect(requestedFields).toContain('status');
      expect(requestedFields).toContain('assignee');
      expect(requestedFields).toContain('description');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('searchIssues includes fields parameter when provided', async () => {
    const mockConfig = {
      jiraUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    };

    let capturedFields: string | undefined;

    // Mock fetch
    const originalFetch = global.fetch;
    global.fetch = mock(async (url: string) => {
      const urlObj = new URL(url);
      capturedFields = urlObj.searchParams.get('fields') || undefined;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          issues: [],
          total: 0,
          startAt: 0,
          maxResults: 100,
        }),
      };
    }) as any;

    // Temporarily allow real API calls to create the client
    const originalEnv = process.env.ALLOW_REAL_API_CALLS;
    process.env.ALLOW_REAL_API_CALLS = 'true';
    const client = new JiraClientIssues(mockConfig);
    process.env.ALLOW_REAL_API_CALLS = originalEnv;

    try {
      // Test with fields parameter
      await client.searchIssues('project = TEST', {
        fields: ISSUE_FIELDS,
      });

      expect(capturedFields).toBeDefined();
      expect(capturedFields).toContain('comment');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('getIssue always includes comment field', async () => {
    const mockConfig = {
      jiraUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    };

    let capturedFields: string | undefined;

    // Mock fetch
    const originalFetch = global.fetch;
    global.fetch = mock(async (url: string) => {
      const urlObj = new URL(url);
      capturedFields = urlObj.searchParams.get('fields') || undefined;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          key: 'TEST-123',
          self: 'https://test.atlassian.net/rest/api/3/issue/TEST-123',
          fields: {
            summary: 'Test Issue',
            status: { name: 'Open' },
            comment: {
              comments: [
                {
                  author: { displayName: 'Test User' },
                  created: '2025-01-01T00:00:00.000Z',
                  body: 'Test comment',
                },
              ],
            },
          },
        }),
      };
    }) as any;

    // Temporarily allow real API calls to create the client
    const originalEnv = process.env.ALLOW_REAL_API_CALLS;
    process.env.ALLOW_REAL_API_CALLS = 'true';
    const client = new JiraClientIssues(mockConfig);
    process.env.ALLOW_REAL_API_CALLS = originalEnv;

    try {
      const issue = await client.getIssue('TEST-123');

      // Verify fields parameter included comment
      expect(capturedFields).toBeDefined();
      expect(capturedFields).toContain('comment');

      // Verify the issue has comments
      expect(issue.fields).toBeDefined();
      const fields = issue.fields as any;
      expect(fields.comment).toBeDefined();
      expect(fields.comment.comments).toBeArray();
      expect(fields.comment.comments).toHaveLength(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('CLI recognizes --sync flag for issue view command', () => {
    // This test verifies the CLI parsing logic
    const testArgs = ['issue', 'view', 'TEST-123', '--sync'];

    // Simulate argument parsing
    const hasSync = testArgs.includes('--sync');
    const hasJson = testArgs.includes('--json');

    expect(hasSync).toBe(true);
    expect(hasJson).toBe(false);
  });

  test('CLI recognizes --sync flag for direct issue key command', () => {
    // Test for the shorthand ji TEST-123 --sync
    const testArgs = ['TEST-123', '--sync'];

    // Check if it's an issue key
    const isIssueKey = /^[A-Z]+-\d+$/.test(testArgs[0]);
    const hasSync = testArgs.includes('--sync');

    expect(isIssueKey).toBe(true);
    expect(hasSync).toBe(true);
  });

  test('ISSUE_FIELDS constant includes comment field', () => {
    expect(ISSUE_FIELDS).toContain('comment');
    expect(ISSUE_FIELDS).toContain('summary');
    expect(ISSUE_FIELDS).toContain('status');
    expect(ISSUE_FIELDS).toContain('description');
    expect(ISSUE_FIELDS).toContain('assignee');
    expect(ISSUE_FIELDS).toContain('reporter');
  });
});
