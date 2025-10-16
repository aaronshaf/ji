import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { HttpResponse, http } from 'msw';
import { server } from './setup-msw';
import { IssueSchema, UserSchema } from '../lib/effects/jira/schemas';
import {
  createArbitraryIssue,
  createArbitraryUser,
  createDiverseIssues,
  createValidIssue,
  validateAndReturn,
} from './msw-schema-validation';

// MSW-based HTTP Mocking for `ji mine` command testing
// Tests the complete flow: search for assigned issues -> cache updates -> display

beforeEach(() => {});

afterEach(() => {
  // MSW's global afterEach will reset handlers automatically
  delete process.env.ALLOW_REAL_API_CALLS;
});

test('ji mine command - mock complete user issue search flow', async () => {
  // Create multiple validated issues for different projects
  const projectAlphaIssues = [
    createValidIssue({
      key: 'ALPHA-101',
      fields: {
        summary: 'Implement user authentication system',
        status: { name: 'In Progress' },
        priority: { name: 'High' },
        assignee: {
          displayName: 'Test User',
          emailAddress: 'test@company.com',
          accountId: 'test-user-123',
        },
        reporter: {
          displayName: 'Product Manager',
          emailAddress: 'pm@company.com',
          accountId: 'pm-123',
        },
        updated: '2024-01-15T10:30:00.000Z',
        created: '2024-01-10T09:00:00.000Z',
        project: { key: 'ALPHA', name: 'Alpha Project' },
      },
    }),
    createValidIssue({
      key: 'ALPHA-102',
      fields: {
        summary: 'Fix login validation bug',
        status: { name: 'To Do' },
        priority: { name: 'Medium' },
        assignee: {
          displayName: 'Test User',
          emailAddress: 'test@company.com',
          accountId: 'test-user-123',
        },
        reporter: {
          displayName: 'QA Engineer',
          emailAddress: 'qa@company.com',
          accountId: 'qa-123',
        },
        updated: '2024-01-14T16:45:00.000Z',
        created: '2024-01-12T11:30:00.000Z',
        project: { key: 'ALPHA', name: 'Alpha Project' },
      },
    }),
  ];

  const projectBetaIssues = [
    createValidIssue({
      key: 'BETA-205',
      fields: {
        summary: 'Optimize database queries',
        status: { name: 'In Review' },
        priority: { name: 'Low' },
        assignee: {
          displayName: 'Test User',
          emailAddress: 'test@company.com',
          accountId: 'test-user-123',
        },
        reporter: {
          displayName: 'Tech Lead',
          emailAddress: 'lead@company.com',
          accountId: 'lead-123',
        },
        updated: '2024-01-16T14:20:00.000Z',
        created: '2024-01-08T08:15:00.000Z',
        project: { key: 'BETA', name: 'Beta Project' },
      },
    }),
  ];

  const currentUser = createArbitraryUser({
    accountId: 'test-user-123',
    displayName: 'Test User',
    emailAddress: 'test@company.com',
    active: true,
  });

  // Mock HTTP endpoints for complete mine command flow using MSW
  server.use(
    // Mock current user endpoint
    http.get('*/rest/api/3/myself', () => {
      const validatedUser = validateAndReturn(UserSchema, currentUser, 'Current User');
      return HttpResponse.json(validatedUser);
    }),

    // Mock JQL search endpoint (handles both /search and /search/jql)
    http.get('*/rest/api/3/search*', ({ request }) => {
      const url = new URL(request.url);
      const jql = url.searchParams.get('jql') || '';

      if (jql.includes('project = ALPHA') || jql.includes('project%20%3D%20ALPHA')) {
        const searchResponse = {
          issues: projectAlphaIssues,
          total: projectAlphaIssues.length,
          startAt: 0,
          maxResults: 50,
        };
        searchResponse.issues.forEach((issue, index) => {
          validateAndReturn(IssueSchema, issue, `Search Result Issue ${index + 1}`);
        });
        return HttpResponse.json(searchResponse);
      }

      // Mock JQL search for BETA project
      if (jql.includes('project = BETA') || jql.includes('project%20%3D%20BETA')) {
        const searchResponse = {
          issues: projectBetaIssues,
          total: projectBetaIssues.length,
          startAt: 0,
          maxResults: 50,
        };
        searchResponse.issues.forEach((issue, index) => {
          validateAndReturn(IssueSchema, issue, `Beta Search Result Issue ${index + 1}`);
        });
        return HttpResponse.json(searchResponse);
      }

      // Mock general JQL search (without project filter)
      if (jql.includes('assignee = currentUser')) {
        const allIssues = [...projectAlphaIssues, ...projectBetaIssues];
        const searchResponse = {
          issues: allIssues,
          total: allIssues.length,
          startAt: 0,
          maxResults: 50,
        };
        searchResponse.issues.forEach((issue, index) => {
          validateAndReturn(IssueSchema, issue, `All Issues Search Result ${index + 1}`);
        });
        return HttpResponse.json(searchResponse);
      }

      // Default empty search
      return HttpResponse.json({ issues: [], total: 0, startAt: 0, maxResults: 50 });
    }),

    // Mock individual issue endpoints
    http.get('*/rest/api/3/issue/ALPHA-101', () => {
      const validatedIssue = validateAndReturn(IssueSchema, projectAlphaIssues[0], 'Issue ALPHA-101');
      return HttpResponse.json(validatedIssue);
    }),

    http.get('*/rest/api/3/issue/ALPHA-102', () => {
      const validatedIssue = validateAndReturn(IssueSchema, projectAlphaIssues[1], 'Issue ALPHA-102');
      return HttpResponse.json(validatedIssue);
    }),

    http.get('*/rest/api/3/issue/BETA-205', () => {
      const validatedIssue = validateAndReturn(IssueSchema, projectBetaIssues[0], 'Issue BETA-205');
      return HttpResponse.json(validatedIssue);
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  // Import and test the Jira client (simulating what mine command does)
  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@company.com',
    apiToken: 'test-token',
  });

  // Test 1: Search for all assigned issues (what mine command does initially)
  const jqlQuery = 'assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)';
  const allMyIssues = await client.searchIssues(jqlQuery);

  expect(allMyIssues.issues).toHaveLength(3);
  expect(allMyIssues.total).toBe(3);

  // Verify all issues are assigned to the test user
  allMyIssues.issues.forEach((issue) => {
    expect(issue.fields.assignee?.emailAddress).toBe('test@company.com');
    expect(['To Do', 'In Progress', 'In Review']).toContain(issue.fields.status.name);
  });

  // Test 2: Search for specific project issues (project filtering)
  const alphaJqlQuery = 'project = ALPHA AND assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)';
  const alphaIssues = await client.searchIssues(alphaJqlQuery);

  expect(alphaIssues.issues).toHaveLength(2);
  expect(alphaIssues.issues[0].key).toBe('ALPHA-101');
  expect(alphaIssues.issues[0].fields.summary).toBe('Implement user authentication system');
  expect(alphaIssues.issues[0].fields.status.name).toBe('In Progress');
  expect(alphaIssues.issues[0].fields.priority?.name).toBe('High');

  expect(alphaIssues.issues[1].key).toBe('ALPHA-102');
  expect(alphaIssues.issues[1].fields.summary).toBe('Fix login validation bug');
  expect(alphaIssues.issues[1].fields.status.name).toBe('To Do');

  // Test 3: Individual issue fetching (for cache updates)
  const issue1 = await client.getIssue('ALPHA-101');
  expect(issue1.key).toBe('ALPHA-101');
  expect(issue1.fields.summary).toBe('Implement user authentication system');

  const issue2 = await client.getIssue('BETA-205');
  expect(issue2.key).toBe('BETA-205');
  expect(issue2.fields.summary).toBe('Optimize database queries');
  expect(issue2.fields.status.name).toBe('In Review');

  // Test 4: Current user info (for email matching)
  const user = await client.getCurrentUser();
  expect(user.emailAddress).toBe('test@company.com');
  expect(user.displayName).toBe('Test User');

  // Verify all responses conform to schemas
  for (const issue of allMyIssues.issues) {
    const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
    expect(validationResult._tag).toBe('Right');
  }
});

test('ji mine command - handles empty results', async () => {
  const currentUser = createArbitraryUser({
    accountId: 'empty-user-123',
    displayName: 'User With No Issues',
    emailAddress: 'empty@company.com',
    active: true,
  });

  // Mock empty search results using MSW
  server.use(
    http.get('*/rest/api/3/myself', () => {
      const validatedUser = validateAndReturn(UserSchema, currentUser, 'Current User');
      return HttpResponse.json(validatedUser);
    }),

    http.get('*/rest/api/3/search*', () => {
      return HttpResponse.json({
        issues: [],
        total: 0,
        startAt: 0,
        maxResults: 50,
      });
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'empty@company.com',
    apiToken: 'test-token',
  });

  const jqlQuery = 'assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)';
  const noIssues = await client.searchIssues(jqlQuery);

  expect(noIssues.issues).toHaveLength(0);
  expect(noIssues.total).toBe(0);
});

test('ji mine command - handles search API errors', async () => {
  // Mock 500 error for search endpoint using MSW
  server.use(
    http.get('*/rest/api/3/search*', () => {
      return HttpResponse.json({ errorMessages: ['Internal server error during search'] }, { status: 500 });
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@company.com',
    apiToken: 'test-token',
  });

  // Should throw due to 500 error
  const jqlQuery = 'assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)';
  await expect(client.searchIssues(jqlQuery)).rejects.toThrow();
});

test('ji mine command - validates issue schema compliance', async () => {
  // Use the new createDiverseIssues function to generate test data
  const _baseDiverseIssues = createDiverseIssues(4);

  // Customize specific issues for this test
  const diverseIssues = [
    createArbitraryIssue({
      key: 'SCHEMA-001',
      fields: {
        summary: 'Critical production bug',
        status: { name: 'In Progress' },
        priority: { name: 'Critical' },
        assignee: {
          displayName: 'Senior Dev',
          emailAddress: 'senior@company.com',
          accountId: 'senior-123',
        },
        reporter: {
          displayName: 'Support Team',
          emailAddress: 'support@company.com',
          accountId: 'support-123',
        },
        updated: '2024-01-17T09:15:00.000Z',
        created: '2024-01-17T08:00:00.000Z',
        project: { key: 'PROD', name: 'Production Issues' },
        labels: ['urgent', 'customer-impact'],
      },
    }),
    createArbitraryIssue({
      key: 'SCHEMA-002',
      fields: {
        summary: 'Feature enhancement request',
        status: { name: 'To Do' },
        priority: null, // Test null priority
        assignee: {
          displayName: 'Senior Dev',
          emailAddress: 'senior@company.com',
          accountId: 'senior-123',
        },
        reporter: {
          displayName: 'Product Owner',
          emailAddress: 'po@company.com',
          accountId: 'po-123',
        },
        updated: '2024-01-16T17:30:00.000Z',
        created: '2024-01-15T14:45:00.000Z',
        project: { key: 'FEAT', name: 'Feature Requests' },
        labels: ['enhancement'],
      },
    }),
  ];

  // Mock search endpoint using MSW
  server.use(
    http.get('*/rest/api/3/search*', () => {
      const searchResponse = {
        issues: diverseIssues,
        total: diverseIssues.length,
        startAt: 0,
        maxResults: 50,
      };

      // Validate each issue before returning
      searchResponse.issues.forEach((issue, index) => {
        validateAndReturn(IssueSchema, issue, `Diverse Issue ${index + 1}`);
      });

      return HttpResponse.json(searchResponse);
    }),
  );

  process.env.ALLOW_REAL_API_CALLS = 'true';

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'senior@company.com',
    apiToken: 'test-token',
  });

  const jqlQuery = 'assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)';
  const results = await client.searchIssues(jqlQuery);

  expect(results.issues).toHaveLength(2);

  // Test issue with Critical priority
  const criticalIssue = results.issues.find((issue) => issue.key === 'SCHEMA-001');
  expect(criticalIssue).toBeDefined();
  expect(criticalIssue?.fields.priority?.name).toBe('Critical');
  expect(criticalIssue?.fields.labels).toContain('urgent');

  // Test issue with null priority
  const enhancementIssue = results.issues.find((issue) => issue.key === 'SCHEMA-002');
  expect(enhancementIssue).toBeDefined();
  expect(enhancementIssue?.fields.priority).toBeNull();
  expect(enhancementIssue?.fields.labels).toContain('enhancement');

  // Verify all issues pass schema validation
  results.issues.forEach((issue) => {
    const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
    expect(validationResult._tag).toBe('Right');
  });
});
