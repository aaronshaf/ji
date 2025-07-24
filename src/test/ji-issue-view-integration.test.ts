import { afterEach, beforeEach, expect, test } from 'bun:test';
import { IssueSchema } from '../lib/effects/jira/schemas';
import { createValidIssue, validateAndReturn } from './msw-schema-validation';
import { installFetchMock, restoreFetch } from './test-fetch-mock';

// Integration tests for the actual `ji EVAL-5767` command flow
// Tests the real viewIssue function from issue.ts with comments

beforeEach(() => {
  // Clean state for each test
});

afterEach(() => {
  restoreFetch();
  delete process.env.ALLOW_REAL_API_CALLS;
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
        displayName: 'Aaron Shafovaloff',
        emailAddress: 'ashafovaloff@instructure.com',
        accountId: 'aaron-123',
      },
      reporter: {
        displayName: 'Nathan Warkentin',
        emailAddress: 'nwarkentin@instructure.com',
        accountId: 'nathan-123',
      },
      priority: { name: 'P3' },
      created: '2025-07-17T10:00:00.000Z',
      updated: '2025-07-24T14:38:02.910Z',
      project: { key: 'EVAL', name: 'Evaluate' },
      comment: {
        comments: [
          {
            author: {
              displayName: 'Josh Lebo',
              emailAddress: 'josh@instructure.com',
              accountId: 'josh-123',
            },
            created: '2025-07-18T19:48:00.000Z',
            body: '@@Nathan Warkentin the teams which own the Assignments page / Assignment Enhancements and the new Speedgrader are two different teams (and their code lives in two different repositories) so we will need two separate Jiras, one to send to each team. Can you edit this Jira to just focus on one of the two areas then create a second Jira for the other?',
          },
          {
            author: {
              displayName: 'Nathan Warkentin',
              emailAddress: 'nathan@instructure.com',
              accountId: 'nathan-123',
            },
            created: '2025-07-19T10:47:00.000Z',
            body: 'I created https://instructure.atlassian.net/browse/CNVS-67475 and updated this one to focus on the new SpeedGrader.',
          },
          {
            author: {
              displayName: 'Josh Lebo',
              emailAddress: 'josh@instructure.com',
              accountId: 'josh-123',
            },
            created: '2025-07-19T12:50:00.000Z',
            body: 'Watching the network traffic it looks like the similarity report button in the new SpeedGrader is just redirecting users to the launch URL for the report with a GET request, while in the old SpeedGrader the similarity report button will actually initiate an LTI launch for the tool which will end up POSTing to the report URL with all the extra params that are needed for an LTI launch in the request body.',
          },
        ],
      },
    },
  });

  // Mock the Jira API endpoints
  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    // Mock config endpoint (for ConfigManager)
    if (urlString.includes('/rest/api/3/myself')) {
      return new Response(
        JSON.stringify({
          accountId: 'current-user-123',
          displayName: 'Test User',
          emailAddress: 'test@instructure.com',
          active: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Mock the specific issue endpoint
    if (urlString.includes('/rest/api/3/issue/EVAL-5767')) {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithComments, 'EVAL-5767 Issue');
      return new Response(JSON.stringify(validatedIssue), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Mock Meilisearch endpoints to prevent real HTTP calls
    if (urlString.includes('localhost:7700') || urlString.includes('meilisearch')) {
      return new Response(JSON.stringify({ taskUid: 123, status: 'enqueued' }), { status: 200 });
    }

    throw new Error(`Unhandled request in ji issue view test: ${urlString}`);
  });

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
    await viewIssue('EVAL-5767', { json: false, sync: false });

    const output = consoleLogs.join('\n');

    // Verify the complete YAML structure
    expect(output).toContain('type: issue');
    expect(output).toContain('key: EVAL-5767');
    expect(output).toContain('title: Similarity report fails to open from the new SpeedGrader');
    expect(output).toContain('status: In Progress');
    expect(output).toContain('priority: P3');
    expect(output).toContain('reporter: Nathan Warkentin');
    expect(output).toContain('assignee: Aaron Shafovaloff');

    // Verify description formatting (no artificial line breaks)
    expect(output).toContain('description: |');
    expect(output).toContain(
      'Summary: • When launching the similarity report for TII LTI 1.1 or Plagiarism Framework with "Performance and Usability Upgrades for SpeedGrader" enabled, it fails to load.',
    );

    // Verify comments are formatted as YAML array (our main focus)
    expect(output).toContain('comments:');
    expect(output).not.toContain('comments: 3'); // Should NOT show count

    // Verify proper YAML array structure
    expect(output).toContain('  - author: Josh Lebo');
    expect(output).toContain('  - author: Nathan Warkentin');

    // Verify proper indentation for comment fields
    expect(output).toContain('    created:');
    expect(output).toContain('    body: |');

    // Verify long comments don't have artificial line breaks
    expect(output).toContain(
      'Watching the network traffic it looks like the similarity report button in the new SpeedGrader is just redirecting users to the launch URL for the report with a GET request, while in the old SpeedGrader the similarity report button will actually initiate an LTI launch for the tool which will end up POSTing to the report URL with all the extra params that are needed for an LTI launch in the request body.',
    );

    // Verify all 3 comments are displayed
    const joshComments = (output.match(/- author: Josh Lebo/g) || []).length;
    const nathanComments = (output.match(/- author: Nathan Warkentin/g) || []).length;
    expect(joshComments).toBe(2); // Josh has 2 comments
    expect(nathanComments).toBe(1); // Nathan has 1 comment
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

  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/rest/api/3/myself')) {
      return new Response(
        JSON.stringify({
          accountId: 'current-user-123',
          displayName: 'Test User',
          emailAddress: 'test@example.com',
          active: true,
        }),
        { status: 200 },
      );
    }

    if (urlString.includes('/rest/api/3/issue/EVAL-1234')) {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithoutComments, 'No Comments Issue');
      return new Response(JSON.stringify(validatedIssue), { status: 200 });
    }

    // Mock Meilisearch endpoints to prevent real HTTP calls
    if (urlString.includes('localhost:7700') || urlString.includes('meilisearch')) {
      return new Response(JSON.stringify({ taskUid: 123, status: 'enqueued' }), { status: 200 });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(' '));
  };

  try {
    const { viewIssue } = await import('../cli/commands/issue');
    await viewIssue('EVAL-1234', { json: false, sync: false });

    const output = consoleLogs.join('\n');

    // Should have all the basic fields
    expect(output).toContain('type: issue');
    expect(output).toContain('key: EVAL-1234');
    expect(output).toContain('title: Issue with no comments');

    // Should NOT have comments section at all
    expect(output).not.toContain('comments:');
    expect(output).not.toContain('  - author:');
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

  installFetchMock(async (url: string | URL, _init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString();

    if (urlString.includes('/rest/api/3/myself')) {
      return new Response(
        JSON.stringify({
          accountId: 'current-user-123',
          displayName: 'Test User',
          emailAddress: 'test@example.com',
          active: true,
        }),
        { status: 200 },
      );
    }

    if (urlString.includes('/rest/api/3/issue/EVAL-5678')) {
      const validatedIssue = validateAndReturn(IssueSchema, issueWithEmptyComments, 'Empty Comments Issue');
      return new Response(JSON.stringify(validatedIssue), { status: 200 });
    }

    // Mock Meilisearch endpoints to prevent real HTTP calls
    if (urlString.includes('localhost:7700') || urlString.includes('meilisearch')) {
      return new Response(JSON.stringify({ taskUid: 123, status: 'enqueued' }), { status: 200 });
    }

    throw new Error(`Unhandled request: ${urlString}`);
  });

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const consoleLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(' '));
  };

  try {
    const { viewIssue } = await import('../cli/commands/issue');
    await viewIssue('EVAL-5678', { json: false, sync: false });

    const output = consoleLogs.join('\n');

    // Should have all the basic fields
    expect(output).toContain('type: issue');
    expect(output).toContain('key: EVAL-5678');

    // Should NOT display comments section for empty array
    expect(output).not.toContain('comments:');
    expect(output).not.toContain('  - author:');
  } finally {
    console.log = originalLog;
  }
});
