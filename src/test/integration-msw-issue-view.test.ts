import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { HttpResponse, http } from 'msw';
import { server } from './setup-msw';
import { IssueSchema, UserSchema } from '../lib/effects/jira/schemas';
import { createValidIssue, createValidUser, validateAndReturn } from './msw-schema-validation';

// MSW HTTP Mocking - Proper test isolation with MSW
// Provides schema validation and proper handler reset between tests

beforeEach(() => {
  // MSW server is started in setup-msw.ts preload
});

afterEach(() => {
  // MSW's global afterEach will reset handlers automatically
  delete process.env.ALLOW_REAL_API_CALLS;
});

test('Bun HTTP mocking with schema validation works perfectly', async () => {
  // Create validated mock data
  const mockIssue = createValidIssue({
    key: 'BUN-123',
  });
  mockIssue.fields.summary = 'Bun HTTP Mock Test Issue';
  mockIssue.fields.description = 'This issue is fetched via MSW mocking';
  mockIssue.fields.status = { name: 'In Progress' };
  mockIssue.fields.assignee = {
    displayName: 'Bun Test User',
    emailAddress: 'bun@example.com',
    accountId: 'bun-test-user-id',
  };
  mockIssue.fields.priority = { name: 'High' };
  mockIssue.fields.labels = ['bun', 'native', 'test'];

  const mockUser = createValidUser({
    accountId: 'bun-account-id',
    displayName: 'Bun Test User',
    emailAddress: 'bun@example.com',
  });

  // Mock fetch with MSW
  server.use(
    http.get('*/rest/api/3/issue/BUN-123', () => {
      const validatedIssue = validateAndReturn(IssueSchema, mockIssue, 'Issue BUN-123');
      return HttpResponse.json(validatedIssue);
    }),

    http.get('*/rest/api/3/myself', () => {
      const validatedUser = validateAndReturn(UserSchema, mockUser, 'Current User');
      return HttpResponse.json(validatedUser);
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // Test intercepted HTTP request
  const issue = await client.getIssue('BUN-123');

  // Verify mock data was returned correctly
  expect(issue.key).toBe('BUN-123');
  expect(issue.fields.summary).toBe('Bun HTTP Mock Test Issue');
  expect(issue.fields.assignee?.displayName).toBe('Bun Test User');
  expect(issue.fields.status.name).toBe('In Progress');
  expect(issue.fields.priority?.name).toBe('High');

  // Verify schema compliance
  const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
  expect(validationResult._tag).toBe('Right');
});

test('Bun HTTP mocking handles 404 errors correctly', async () => {
  // Mock 404 error response using MSW
  server.use(
    http.get('*/rest/api/3/issue/MISSING-999', () => {
      return HttpResponse.json(
        { errorMessages: ['Issue does not exist or you do not have permission to see it.'] },
        { status: 404 },
      );
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // Should throw due to 404
  await expect(client.getIssue('MISSING-999')).rejects.toThrow();
});

test('Bun HTTP mocking handles network timeouts', async () => {
  // Mock network timeout using MSW
  server.use(
    http.get('*/rest/api/3/issue/TIMEOUT-123', () => {
      return HttpResponse.error();
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // Should throw due to network error
  await expect(client.getIssue('TIMEOUT-123')).rejects.toThrow();
});

test('Bun HTTP mocking supports multiple request interception', async () => {
  let requestCount = 0;

  // Create multiple validated issues
  const issues = ['REQ-1', 'REQ-2', 'REQ-3'].map((key) => {
    const issue = createValidIssue({ key });
    issue.fields.summary = `Issue ${key}`;
    return issue;
  });

  // Mock with MSW and request counting
  server.use(
    http.get('*/rest/api/3/issue/:issueKey', () => {
      const index = requestCount++;
      const validatedIssue = validateAndReturn(IssueSchema, issues[index % issues.length], `Issue ${index}`);
      return HttpResponse.json(validatedIssue);
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // Make multiple requests
  const issue1 = await client.getIssue('REQ-1');
  const issue2 = await client.getIssue('REQ-2');
  const issue3 = await client.getIssue('REQ-3');

  // Verify all requests were intercepted
  expect(requestCount).toBe(3);

  // Verify all responses conform to schema
  for (const issue of [issue1, issue2, issue3]) {
    const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
    expect(validationResult._tag).toBe('Right');
  }
});

test('Bun HTTP mocking catches schema violations', () => {
  // Test that our validation catches invalid mocks (same as MSW)
  const invalidIssue = {
    key: 'INVALID-123',
    // Missing required 'self' field
    fields: {
      summary: 'Invalid Issue',
      // Missing required fields like status, reporter, created, updated
    },
  };

  // Suppress console.error during this test to avoid noise
  const originalConsoleError = console.error;
  console.error = () => {}; // Suppress error output

  try {
    // Should throw validation error
    expect(() => {
      validateAndReturn(IssueSchema, invalidIssue, 'Invalid Issue');
    }).toThrow('Mock validation failed for Invalid Issue');
  } finally {
    // Restore console.error
    console.error = originalConsoleError;
  }
});

test('Bun HTTP mocking performance test', async () => {
  const startTime = performance.now();

  // Mock multiple rapid requests using MSW
  server.use(
    http.get('*/rest/api/3/issue/:issueKey', () => {
      const mockIssue = createValidIssue({
        key: 'PERF-1',
      });
      return HttpResponse.json(mockIssue);
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // Make 10 rapid requests
  const promises = Array.from({ length: 10 }, (_, i) => client.getIssue(`PERF-${i}`));

  const results = await Promise.all(promises);
  const endTime = performance.now();

  // Verify all requests completed
  expect(results).toHaveLength(10);

  // Should be reasonably fast
  const duration = endTime - startTime;
  expect(duration).toBeLessThan(1000);

  console.log(`✅ Bun native mocking: ${10} requests in ${duration.toFixed(2)}ms`);
});
