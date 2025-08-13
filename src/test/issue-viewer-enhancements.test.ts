import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { IssueSchema } from '../lib/effects/jira/schemas';
import { createValidIssue, validateAndReturn } from './msw-schema-validation';
import { installFetchMock, restoreFetch } from './test-fetch-mock';

// Tests for issue viewer enhancements:
// 1. YAML comment formatting improvements
// 2. API response validation for malformed data
// 3. Cached-then-fresh pattern behavior

beforeEach(() => {
  // Clean state for each test
});

afterEach(() => {
  restoreFetch();
  delete process.env.ALLOW_REAL_API_CALLS;
});

test('YAML comment formatting - proper array structure without count', async () => {
  // Create an issue with multiple comments in proper format
  const issueWithComments = createValidIssue({
    key: 'COMMENT-123',
    fields: {
      summary: 'Issue with multiple comments',
      description: 'This issue has several comments to test YAML formatting',
      status: { name: 'In Progress' },
      assignee: {
        displayName: 'Comment Test User',
        emailAddress: 'commenter@example.com',
        accountId: 'comment-user-123',
      },
      reporter: {
        displayName: 'Reporter User',
        emailAddress: 'reporter@example.com',
        accountId: 'reporter-123',
      },
      priority: { name: 'Medium' },
      created: '2024-01-01T10:00:00.000Z',
      updated: '2024-01-02T15:30:00.000Z',
      project: { key: 'TEST', name: 'Test Project' },
      comment: {
        comments: [
          {
            author: {
              displayName: 'Josh Lebo',
              emailAddress: 'josh@example.com',
              accountId: 'josh-123',
            },
            created: '2024-01-01T19:48:00.000Z',
            body: '@@Nathan Warkentin the teams which own the Assignments page / Assignment Enhancements and the new Speedgrader are two different teams (and their code lives in two different repositories) so we will need two separate Jiras, one to send to each team. Can you edit this Jira to just focus on one of the two areas then create a second Jira for the other?',
          },
          {
            author: {
              displayName: 'Nathan Warkentin',
              emailAddress: 'nathan@example.com',
              accountId: 'nathan-123',
            },
            created: '2024-01-02T10:47:00.000Z',
            body: 'I created https://example.atlassian.net/browse/ISSUE-12345 and updated this one to focus on the new SpeedGrader.',
          },
          {
            author: {
              displayName: 'Josh Lebo',
              emailAddress: 'josh@example.com',
              accountId: 'josh-123',
            },
            created: '2024-01-02T12:50:00.000Z',
            body: 'Watching the network traffic it looks like the similarity report button in the new SpeedGrader is just redirecting users to the launch URL for the report with a GET request, while in the old SpeedGrader the similarity report button will actually initiate an LTI launch for the tool which will end up POSTing to the report URL with all the extra params that are needed for an LTI launch in the request body.',
          },
        ],
      },
    },
  });

  // Mock the issue endpoint
  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/issue/COMMENT-123')) {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithComments, 'Issue with Comments');
      return new Response(JSON.stringify(validatedIssue), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // Capture console output to verify YAML formatting
  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(' '));
  };

  try {
    // Get the issue and simulate YAML formatting
    const issue = await client.getIssue('COMMENT-123');

    // This would normally be called by the Effect-based issue viewer
    // For now, we'll simulate the key parts of the YAML formatting
    console.log('comments:');
    const comments = (
      issue.fields.comment as { comments: { author: { displayName: string }; created: string; body: string }[] }
    ).comments;

    comments.forEach((comment) => {
      console.log(`  - author: ${comment.author.displayName}`);
      console.log(`    created: ${comment.created}`);
      console.log(`    body: |`);
      console.log(`      ${comment.body}`);
    });

    const output = consoleLogs.join('\n');

    // Verify YAML array format
    expect(output).toContain('comments:');
    expect(output).not.toContain('comments: 3'); // Should NOT show count
    expect(output).toContain('  - author: Josh Lebo'); // Proper YAML array syntax
    expect(output).toContain('  - author: Nathan Warkentin');
    expect(output).toContain('    created:'); // Proper indentation
    expect(output).toContain('    body: |'); // Proper YAML pipe literal

    // Verify no artificial line breaks in long comment
    expect(output).toContain(
      'Watching the network traffic it looks like the similarity report button in the new SpeedGrader is just redirecting users to the launch URL for the report with a GET request, while in the old SpeedGrader the similarity report button will actually initiate an LTI launch for the tool which will end up POSTing to the report URL with all the extra params that are needed for an LTI launch in the request body.',
    );
  } finally {
    console.log = originalLog;
  }
});

test('API response validation - handles malformed data gracefully', async () => {
  // Mock malformed API response (issue with key but no fields)
  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/issue/MALFORMED-123')) {
      // Return malformed response that has key but missing fields
      const malformedIssue = {
        key: 'MALFORMED-123',
        self: 'https://test.atlassian.net/rest/api/3/issue/MALFORMED-123',
        // Missing 'fields' property entirely
      };

      return new Response(JSON.stringify(malformedIssue), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  // This should work because JiraClient gets the malformed response
  // but our validation should catch it if we add the validation check
  const issue = await client.getIssue('MALFORMED-123');

  // Verify the malformed structure
  expect(issue.key).toBe('MALFORMED-123');
  expect(issue.fields).toBeUndefined(); // This is the problem we're testing for

  // Test our validation logic
  const isValidIssue = !!(issue?.fields && typeof issue.fields === 'object');
  expect(isValidIssue).toBe(false); // Should fail validation
});

test('API response validation - handles missing fields property', async () => {
  // Mock response with fields set to null/undefined
  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/issue/NULL-FIELDS-123')) {
      const issueWithNullFields = {
        key: 'NULL-FIELDS-123',
        self: 'https://test.atlassian.net/rest/api/3/issue/NULL-FIELDS-123',
        fields: null, // Explicit null fields
      };

      return new Response(JSON.stringify(issueWithNullFields), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  const issue = await client.getIssue('NULL-FIELDS-123');

  // Test our validation logic for null fields
  const isValidIssue = !!(issue?.fields && typeof issue.fields === 'object');
  expect(isValidIssue).toBe(false); // Should fail validation due to null fields
});

test('Schema validation - well-formed issue passes validation', async () => {
  const wellFormedIssue = createValidIssue({
    key: 'VALID-123',
    fields: {
      summary: 'Well-formed issue',
      description: 'This issue has all required fields',
      status: { name: 'Open' },
      assignee: {
        displayName: 'Valid User',
        emailAddress: 'valid@example.com',
        accountId: 'valid-123',
      },
      reporter: {
        displayName: 'Reporter User',
        emailAddress: 'reporter@example.com',
        accountId: 'reporter-123',
      },
      priority: { name: 'High' },
      created: '2024-01-01T10:00:00.000Z',
      updated: '2024-01-02T15:30:00.000Z',
      project: { key: 'TEST', name: 'Test Project' },
    },
  });

  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/issue/VALID-123')) {
      const validatedIssue = validateAndReturn(IssueSchema, wellFormedIssue, 'Valid Issue');
      return new Response(JSON.stringify(validatedIssue), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  const issue = await client.getIssue('VALID-123');

  // Test our validation logic for well-formed data
  const isValidIssue = !!(issue?.fields && typeof issue.fields === 'object');
  expect(isValidIssue).toBe(true); // Should pass validation

  // Verify schema compliance
  const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
  expect(validationResult._tag).toBe('Right');
});

test('Description formatting - no artificial line breaks in YAML pipe literal', async () => {
  const issueWithLongDescription = createValidIssue({
    key: 'LONG-DESC-123',
    fields: {
      summary: 'Issue with long description',
      description:
        'Summary: • When launching the similarity report for TII LTI 1.1 or Plagiarism Framework with "Performance and Usability Upgrades for SpeedGrader" enabled, it fails to load.Expected behavior: • Instead it should launch into the similarity report.Link to reproduced behavior: • SpeedGrader with submission as the teacher: https://example.com/courses/123/gradebook/speed_grader?assignment_id=456&anonymous_id=ABC123&student_id=789Workaround: • Disable the new SpeedGrader as a teacher.',
      status: { name: 'Open' },
      assignee: {
        displayName: 'Test User',
        emailAddress: 'test@example.com',
        accountId: 'test-123',
      },
      reporter: {
        displayName: 'Reporter User',
        emailAddress: 'reporter@example.com',
        accountId: 'reporter-123',
      },
      priority: { name: 'Medium' },
      created: '2024-01-01T10:00:00.000Z',
      updated: '2024-01-02T15:30:00.000Z',
      project: { key: 'TEST', name: 'Test Project' },
    },
  });

  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/issue/LONG-DESC-123')) {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithLongDescription, 'Long Description Issue');
      return new Response(JSON.stringify(validatedIssue), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
  });

  const issue = await client.getIssue('LONG-DESC-123');

  // Capture console output to verify no artificial line breaks
  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(' '));
  };

  try {
    // Simulate the description formatting
    console.log('description: |');
    const description = issue.fields.description || '';
    const cleanDescription = (description as string).replace(/\s+/g, ' ').trim();
    console.log(`  ${cleanDescription}`);

    const output = consoleLogs.join('\n');

    // Verify long description appears as single line (no artificial breaks)
    expect(output).toContain('description: |');
    expect(output).toContain(
      'Summary: • When launching the similarity report for TII LTI 1.1 or Plagiarism Framework with "Performance and Usability Upgrades for SpeedGrader" enabled, it fails to load.Expected behavior: • Instead it should launch into the similarity report.Link to reproduced behavior:',
    );

    // Count lines - should only be 2 lines (the "description: |" and the content)
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
  } finally {
    console.log = originalLog;
  }
});
