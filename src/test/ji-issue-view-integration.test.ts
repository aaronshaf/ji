import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { server } from './setup-msw';
import { IssueSchema } from '../lib/effects/jira/schemas';
import { createValidIssue, validateAndReturn } from './msw-schema-validation';
import { isolateTestEnvironment } from './test-helpers.js';

// Integration tests for the actual `ji EVAL-5767` command flow
// Tests the real viewIssue function from issue.ts with comments

let tempDir: string;
let cleanup: () => void;

beforeEach(() => {
  const env = isolateTestEnvironment();
  tempDir = env.tempDir;
  cleanup = env.cleanup;

  // Create mock config file
  const mockConfig = {
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token-123',
  };
  writeFileSync(join(tempDir, 'config.json'), JSON.stringify(mockConfig), { mode: 0o600 });
});

afterEach(() => {
  // MSW's global afterEach will reset handlers automatically
  delete process.env.ALLOW_REAL_API_CALLS;
  cleanup();
});

test('ji EVAL-5767 command - real issue viewing with comments array processing', async () => {
  // Create an issue that matches the structure we expect from `ji EVAL-5767`
  const issueWithComments = createValidIssue({
    key: 'EVAL-5767',
    fields: {
      summary: 'Similarity report fails to open from the new SpeedGrader',
      description:
        'Summary: • When launching the similarity report for TII LTI 1.1 or Plagiarism Framework with "Performance and Usability Upgrades for SpeedGrader" enabled, it fails to load.',
      status: { name: 'In Progress' },
      assignee: {
        displayName: 'Test User One',
        emailAddress: 'testuser1@example.com',
        accountId: 'user-123',
      },
      reporter: {
        displayName: 'Test User Two',
        emailAddress: 'testuser2@example.com',
        accountId: 'user-456',
      },
      priority: { name: 'P3' },
      created: '2025-07-17T10:00:00.000Z',
      updated: '2025-07-24T14:38:02.910Z',
      project: { key: 'EVAL', name: 'Evaluate' },
      comment: {
        comments: [
          {
            author: {
              displayName: 'Test User Three',
              emailAddress: 'testuser3@example.com',
              accountId: 'user-789',
            },
            created: '2025-07-18T19:48:00.000Z',
            body: '@@Test User Two the teams which own the Assignments page / Assignment Enhancements and the new Speedgrader are two different teams (and their code lives in two different repositories) so we will need two separate Jiras, one to send to each team. Can you edit this Jira to just focus on one of the two areas then create a second Jira for the other?',
          },
          {
            author: {
              displayName: 'Test User Two',
              emailAddress: 'testuser2@example.com',
              accountId: 'user-456',
            },
            created: '2025-07-19T10:47:00.000Z',
            body: 'I created https://example.atlassian.net/browse/ISSUE-67475 and updated this one to focus on the new SpeedGrader.',
          },
          {
            author: {
              displayName: 'Test User Three',
              emailAddress: 'testuser3@example.com',
              accountId: 'user-789',
            },
            created: '2025-07-19T12:50:00.000Z',
            body: 'Watching the network traffic it looks like the similarity report button in the new SpeedGrader is just redirecting users to the launch URL for the report with a GET request, while in the old SpeedGrader the similarity report button will actually initiate an LTI launch for the tool which will end up POSTing to the report URL with all the extra params that are needed for an LTI launch in the request body.',
          },
        ],
      },
    },
  });

  // Mock the Jira API endpoints using MSW
  server.use(
    http.get('*/rest/api/3/myself', () => {
      return HttpResponse.json({
        accountId: 'current-user-123',
        displayName: 'Test User',
        emailAddress: 'test@example.com',
        active: true,
      });
    }),

    http.get('*/rest/api/3/issue/EVAL-5767', () => {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithComments, 'EVAL-5767 Issue');
      return HttpResponse.json(validatedIssue);
    }),

    // Mock Meilisearch endpoints to prevent real HTTP calls
    http.post('*localhost:7700*', () => {
      return HttpResponse.json({ taskUid: 123, status: 'enqueued' });
    }),

    http.get('*localhost:7700*', () => {
      return HttpResponse.json({ taskUid: 123, status: 'enqueued' });
    }),

    http.patch('*localhost:7700*', () => {
      return HttpResponse.json({ taskUid: 123, status: 'enqueued' });
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  // Capture all console output to verify the real formatting
  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    // Convert all args to strings and join them
    const logLine = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
    consoleLogs.push(logLine);
  };

  try {
    // Import and call the real viewIssue function (what `ji EVAL-5767` calls)
    const { viewIssue } = await import('../cli/commands/issue');

    // This is the actual function that runs when you type `ji EVAL-5767`
    await viewIssue('EVAL-5767', { xml: true });

    const output = consoleLogs.join('\n');

    // Verify the complete XML structure
    expect(output).toContain('<type>issue</type>');
    expect(output).toContain('<key>EVAL-5767</key>');
    expect(output).toContain('<title>Similarity report fails to open from the new SpeedGrader</title>');
    expect(output).toContain('<status>In Progress</status>');
    expect(output).toContain('<priority>P3</priority>');
    expect(output).toContain('<reporter>Test User Two</reporter>');
    expect(output).toContain('<assignee>Test User One</assignee>');

    // Verify description formatting
    expect(output).toContain('<description>');
    expect(output).toContain(
      'Summary: • When launching the similarity report for TII LTI 1.1 or Plagiarism Framework with',
    );

    // Verify comments are formatted as XML
    expect(output).toContain('<comments>');

    // Verify proper XML structure
    expect(output).toContain('<author>Test User Three</author>');
    expect(output).toContain('<author>Test User Two</author>');

    // Verify comment fields
    expect(output).toContain('<created>');
    expect(output).toContain('<body>');

    // Verify long comments don't have artificial line breaks
    expect(output).toContain(
      'Watching the network traffic it looks like the similarity report button in the new SpeedGrader is just redirecting users to the launch URL for the report with a GET request, while in the old SpeedGrader the similarity report button will actually initiate an LTI launch for the tool which will end up POSTing to the report URL with all the extra params that are needed for an LTI launch in the request body.',
    );

    // Verify all 3 comments are displayed
    const userThreeComments = (output.match(/<author>Test User Three<\/author>/g) || []).length;
    const userTwoComments = (output.match(/<author>Test User Two<\/author>/g) || []).length;
    expect(userThreeComments).toBe(2); // Test User Three has 2 comments
    expect(userTwoComments).toBe(1); // Test User Two has 1 comment
  } finally {
    console.log = originalLog;
  }
});

test('ji EVAL-5767 command - handles issues with no comments', async () => {
  // Create an issue without comments
  const issueWithoutComments = createValidIssue({
    key: 'EVAL-1234',
    fields: {
      summary: 'Issue with no comments',
      description: 'This issue has no comments to test the absence of comments section',
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
      // No comment field at all
    },
  });

  server.use(
    http.get('*/rest/api/3/myself', () => {
      return HttpResponse.json({
        accountId: 'current-user-123',
        displayName: 'Test User',
        emailAddress: 'test@example.com',
        active: true,
      });
    }),

    http.get('*/rest/api/3/issue/EVAL-1234', () => {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithoutComments, 'No Comments Issue');
      return HttpResponse.json(validatedIssue);
    }),

    // Mock Meilisearch endpoints
    http.post('*localhost:7700*', () => HttpResponse.json({ taskUid: 123, status: 'enqueued' })),
    http.get('*localhost:7700*', () => HttpResponse.json({ taskUid: 123, status: 'enqueued' })),
    http.patch('*localhost:7700*', () => HttpResponse.json({ taskUid: 123, status: 'enqueued' })),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(' '));
  };

  try {
    const { viewIssue } = await import('../cli/commands/issue');
    await viewIssue('EVAL-1234', { xml: true });

    const output = consoleLogs.join('\n');

    // Should have all the basic fields
    expect(output).toContain('<type>issue</type>');
    expect(output).toContain('<key>EVAL-1234</key>');
    expect(output).toContain('<title>Issue with no comments</title>');

    // Should NOT have comments section at all
    expect(output).not.toContain('<comments>');
    expect(output).not.toContain('<author>');
  } finally {
    console.log = originalLog;
  }
});

test('ji EVAL-5767 command - handles issues with empty comments array', async () => {
  // Create an issue with empty comments array
  const issueWithEmptyComments = createValidIssue({
    key: 'EVAL-5678',
    fields: {
      summary: 'Issue with empty comments array',
      description: 'This issue has an empty comments array',
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
      comment: {
        comments: [], // Empty array
      },
    },
  });

  server.use(
    http.get('*/rest/api/3/myself', () => {
      return HttpResponse.json({
        accountId: 'current-user-123',
        displayName: 'Test User',
        emailAddress: 'test@example.com',
        active: true,
      });
    }),

    http.get('*/rest/api/3/issue/EVAL-5678', () => {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithEmptyComments, 'Empty Comments Issue');
      return HttpResponse.json(validatedIssue);
    }),

    // Mock Meilisearch endpoints
    http.post('*localhost:7700*', () => HttpResponse.json({ taskUid: 123, status: 'enqueued' })),
    http.get('*localhost:7700*', () => HttpResponse.json({ taskUid: 123, status: 'enqueued' })),
    http.patch('*localhost:7700*', () => HttpResponse.json({ taskUid: 123, status: 'enqueued' })),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(' '));
  };

  try {
    const { viewIssue } = await import('../cli/commands/issue');
    await viewIssue('EVAL-5678', { xml: true });

    const output = consoleLogs.join('\n');

    // Should have all the basic fields
    expect(output).toContain('<type>issue</type>');
    expect(output).toContain('<key>EVAL-5678</key>');

    // Should NOT display comments section for empty array
    expect(output).not.toContain('<comments>');
    expect(output).not.toContain('<author>');
  } finally {
    console.log = originalLog;
  }
});
