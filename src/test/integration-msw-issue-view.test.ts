import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { IssueSchema, UserSchema } from '../lib/effects/jira/schemas';
import { createValidIssue, createValidUser, validateAndReturn, validateMock } from './msw-schema-validation';

// Create MSW server instance
const server = setupServer();

// Start server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

// Reset handlers after each test
afterEach(() => {
  server.resetHandlers();
});

// Clean up after all tests
afterAll(() => {
  server.close();
});

test('MSW should intercept HTTP requests with schema-validated mocks', async () => {
  // Create a validated mock issue
  const mockIssue = createValidIssue({
    key: 'TEST-123',
  });
  // Override specific fields after creation
  mockIssue.fields.summary = 'MSW Integration Test Issue';
  mockIssue.fields.description = 'This issue is fetched via MSW';
  mockIssue.fields.status = { name: 'In Progress' };
  mockIssue.fields.assignee = {
    displayName: 'MSW Test User',
    emailAddress: 'msw@example.com',
    accountId: 'msw-test-user-id',
  };
  mockIssue.fields.reporter = {
    displayName: 'MSW Reporter',
    emailAddress: 'reporter@example.com',
    accountId: 'msw-reporter-id',
  };
  mockIssue.fields.priority = { name: 'High' };
  mockIssue.fields.labels = ['msw', 'integration', 'test'];
  mockIssue.fields.project = { key: 'TEST', name: 'Test Project' };

  // Create a validated mock user
  const mockUser = createValidUser({
    accountId: 'test-account-id',
    displayName: 'Test User',
    emailAddress: 'test@example.com',
  });

  // Override default handlers for this specific test
  server.use(
    // Mock Jira API endpoints with schema validation
    http.get('https://test.atlassian.net/rest/api/3/issue/TEST-123', () => {
      // Validate the mock before returning it
      const validatedIssue = validateAndReturn(IssueSchema, mockIssue, 'Issue TEST-123');
      return HttpResponse.json(validatedIssue);
    }),

    // Mock user info endpoint with schema validation
    http.get('https://test.atlassian.net/rest/api/3/myself', () => {
      const validatedUser = validateAndReturn(UserSchema, mockUser, 'Current User');
      return HttpResponse.json(validatedUser);
    }),
  );

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

    // Verify the response still conforms to our schema
    const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
    expect(validationResult._tag).toBe('Right');
  } finally {
    delete process.env.ALLOW_REAL_API_CALLS;
  }
});

test('MSW should handle 404 errors with proper error response', async () => {
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

test('MSW should handle network timeouts', async () => {
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

test('MSW should demonstrate request interception with schema validation', async () => {
  let requestCount = 0;

  // Create different validated issues for each request
  const issues = ['TEST-1', 'TEST-2', 'TEST-3'].map((key) => {
    const issue = createValidIssue({
      key,
      self: `https://test.atlassian.net/rest/api/3/issue/${key}`,
    });
    issue.fields.summary = `Issue ${key}`;
    return issue;
  });

  // Track all requests
  server.use(
    http.get('https://test.atlassian.net/rest/api/3/issue/*', ({ params }) => {
      const index = requestCount++;
      const validatedIssue = validateAndReturn(IssueSchema, issues[index % issues.length], `Issue ${index}`);
      return HttpResponse.json(validatedIssue);
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
    const issue1 = await client.getIssue('TEST-1');
    const issue2 = await client.getIssue('TEST-2');
    const issue3 = await client.getIssue('TEST-3');

    // Verify MSW intercepted all requests
    expect(requestCount).toBe(3);

    // Verify all responses conform to schema
    for (const issue of [issue1, issue2, issue3]) {
      const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
      expect(validationResult._tag).toBe('Right');
    }
  } finally {
    delete process.env.ALLOW_REAL_API_CALLS;
  }
});

test('MSW mock validation should catch schema violations', () => {
  // This test demonstrates that our validation catches invalid mocks
  const invalidIssue = {
    key: 'TEST-123',
    // Missing required 'self' field
    fields: {
      summary: 'Test',
      // Missing required fields like status, reporter, created, updated
    },
  };

  // This should throw a validation error
  expect(() => validateMock(IssueSchema, invalidIssue, 'Invalid Issue')).toThrow();
});
