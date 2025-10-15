/**
 * Mock Jira API response fixtures
 *
 * These fixtures represent the various response formats from Jira's REST API,
 * including both old and new endpoint formats.
 *
 * Use these in tests to ensure consistent mocking and reduce duplication.
 */

import type { Issue } from '../../lib/jira-client/jira-client-types.js';

// ============= Issue Fixtures =============

export const mockIssueMinimal: Issue = {
  key: 'PROJ-123',
  self: 'https://company.atlassian.net/rest/api/3/issue/12345',
  fields: {
    summary: 'Test issue',
    status: { name: 'In Progress' },
    assignee: { displayName: 'John Doe', emailAddress: 'john@example.com' },
    reporter: { displayName: 'Jane Smith', emailAddress: 'jane@example.com' },
    priority: { name: 'High' },
    created: '2024-01-01T10:00:00.000Z',
    updated: '2024-01-15T14:30:00.000Z',
    labels: [],
  },
};

export const mockIssueFull: Issue = {
  key: 'PROJ-456',
  self: 'https://company.atlassian.net/rest/api/3/issue/45678',
  fields: {
    summary: 'Implement user authentication',
    description: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Add JWT-based authentication to the API',
            },
          ],
        },
      ],
    },
    status: { name: 'To Do' },
    assignee: { displayName: 'Alice Developer', emailAddress: 'alice@example.com' },
    reporter: { displayName: 'Bob Manager', emailAddress: 'bob@example.com' },
    priority: { name: 'Medium' },
    created: '2024-02-01T09:00:00.000Z',
    updated: '2024-02-10T16:45:00.000Z',
    labels: ['backend', 'security', 'api'],
    project: { key: 'PROJ', name: 'My Project' },
    comment: {
      comments: [
        {
          id: '10001',
          author: { displayName: 'Charlie Reviewer' },
          body: 'Looks good, approved!',
          created: '2024-02-05T11:00:00.000Z',
        },
      ],
    },
    customfield_10020: [
      {
        id: 1,
        name: 'Sprint 1',
        state: 'active',
      },
    ],
  },
};

export const mockIssueUnassigned: Issue = {
  key: 'PROJ-789',
  self: 'https://company.atlassian.net/rest/api/3/issue/78901',
  fields: {
    summary: 'Unassigned issue',
    status: { name: 'Open' },
    assignee: null,
    reporter: { displayName: 'System', emailAddress: 'system@example.com' },
    priority: null,
    created: '2024-03-01T08:00:00.000Z',
    updated: '2024-03-01T08:00:00.000Z',
  },
};

// ============= Search Result Fixtures =============

/**
 * Old /rest/api/3/search endpoint format (deprecated)
 * Includes all pagination fields: startAt, maxResults, total
 */
export const mockSearchResultOldFormat = {
  issues: [mockIssueMinimal, mockIssueFull],
  startAt: 0,
  maxResults: 50,
  total: 2,
};

/**
 * New /rest/api/3/search/jql endpoint format (current)
 * May omit optional fields like total, startAt, maxResults
 */
export const mockSearchResultNewFormat = {
  issues: [mockIssueMinimal],
  // Note: total, startAt, maxResults are optional in the new API
};

/**
 * New format with full pagination fields
 */
export const mockSearchResultNewFormatWithPagination = {
  issues: [mockIssueMinimal, mockIssueFull, mockIssueUnassigned],
  startAt: 0,
  maxResults: 50,
  total: 3,
};

/**
 * New format with nextPageToken (cursor-based pagination)
 */
export const mockSearchResultWithNextPageToken = {
  issues: [mockIssueMinimal],
  nextPageToken: 'eyJzdGFydEF0IjogNTB9',
};

/**
 * Empty search result (no issues found)
 */
export const mockSearchResultEmpty = {
  issues: [],
  startAt: 0,
  maxResults: 50,
  total: 0,
};

/**
 * Minimal new format (only required field: issues)
 */
export const mockSearchResultMinimal = {
  issues: [],
};

/**
 * Mixed format - has some but not all optional fields
 * Tests backward compatibility
 */
export const mockSearchResultMixed = {
  issues: [mockIssueMinimal, mockIssueFull],
  startAt: 0,
  total: 2,
  // Missing maxResults
};

/**
 * Large result set for pagination testing
 */
export const mockSearchResultLargePage = {
  issues: Array.from({ length: 100 }, (_, i) => ({
    key: `PROJ-${1000 + i}`,
    self: `https://company.atlassian.net/rest/api/3/issue/${1000 + i}`,
    fields: {
      summary: `Issue ${1000 + i}`,
      status: { name: 'Open' },
      assignee: null,
      reporter: { displayName: 'System', emailAddress: 'system@example.com' },
      priority: { name: 'Low' },
      created: '2024-01-01T00:00:00.000Z',
      updated: '2024-01-01T00:00:00.000Z',
    },
  })),
  startAt: 0,
  maxResults: 100,
  total: 250, // More issues available
};

// ============= Transition Fixtures =============

export const mockTransitions = {
  transitions: [
    { id: '11', name: 'To Do', to: { name: 'To Do' } },
    { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Done', to: { name: 'Done' } },
  ],
};

export const mockTransitionsWithVariants = {
  transitions: [
    { id: '11', name: 'To Do', to: { name: 'To Do' } },
    { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Done', to: { name: 'Done' } },
    { id: '41', name: 'Closed', to: { name: 'Closed' } },
    { id: '51', name: 'Resolved', to: { name: 'Resolved' } },
    { id: '61', name: 'Complete', to: { name: 'Complete' } },
  ],
};

export const mockTransitionsNoCompletion = {
  transitions: [
    { id: '11', name: 'To Do', to: { name: 'To Do' } },
    { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Blocked', to: { name: 'Blocked' } },
  ],
};

// ============= Custom Fields Fixtures =============

export const mockCustomFields = [
  {
    id: 'customfield_10001',
    name: 'Epic Link',
    description: 'Link to parent epic',
    schema: { type: 'string', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
    custom: true,
  },
  {
    id: 'customfield_10020',
    name: 'Sprint',
    description: 'Sprint field',
    schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
    custom: true,
  },
  {
    id: 'customfield_10030',
    name: 'Story Points',
    description: 'Estimation in story points',
    schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
    custom: true,
  },
];

export const mockCustomFieldsFormatted = [
  {
    id: 'customfield_10001',
    name: 'Epic Link',
    description: 'Link to parent epic',
    type: 'string',
  },
  {
    id: 'customfield_10020',
    name: 'Sprint',
    description: 'Sprint field',
    type: 'array',
  },
  {
    id: 'customfield_10030',
    name: 'Story Points',
    description: 'Estimation in story points',
    type: 'number',
  },
];

// ============= Error Response Fixtures =============

export const mockErrorResponse401 = {
  errorMessages: [],
  errors: {},
  status: 401,
  message: 'Authentication credentials are incorrect or missing.',
};

export const mockErrorResponse403 = {
  errorMessages: ['You do not have permission to view this issue.'],
  errors: {},
  status: 403,
};

export const mockErrorResponse404 = {
  errorMessages: ['Issue does not exist or you do not have permission to see it.'],
  errors: {},
  status: 404,
};

export const mockErrorResponse400InvalidJQL = {
  errorMessages: [
    "Error in the JQL Query: The character '(' is a reserved JQL character. You must enclose it in a string or use the escape '\\u0028' instead.",
  ],
  errors: {},
  status: 400,
};

export const mockErrorResponse410Deprecated = {
  errorMessages: ['The requested API has been removed. Please migrate to the /rest/api/3/search/jql API.'],
  errors: {},
  status: 410,
};

// ============= Helper Functions =============

/**
 * Create a mock Response object for testing fetch
 */
export function createMockResponse(
  data: unknown,
  options: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  const { status = 200, statusText = 'OK', headers = {} } = options;

  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Create a mock error Response object
 */
export function createMockErrorResponse(
  status: number,
  errorData: unknown,
  options: { headers?: Record<string, string> } = {},
): Response {
  const statusTexts: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    410: 'Gone',
    500: 'Internal Server Error',
  };

  return new Response(JSON.stringify(errorData), {
    status,
    statusText: statusTexts[status] || 'Error',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

/**
 * Create a mock fetch handler for testing
 *
 * @example
 * ```ts
 * const mockFetch = createMockFetchHandler({
 *   '/rest/api/3/issue/PROJ-123': mockIssueMinimal,
 *   '/rest/api/3/search/jql': mockSearchResultNewFormat,
 * });
 * global.fetch = mockFetch;
 * ```
 */
export function createMockFetchHandler(
  routes: Record<string, unknown | Response>,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL): Promise<Response> => {
    const urlString = typeof url === 'string' ? url : url.toString();

    // Find matching route
    for (const [route, response] of Object.entries(routes)) {
      if (urlString.includes(route)) {
        if (response instanceof Response) {
          return response;
        }
        return createMockResponse(response);
      }
    }

    // Default 404 response
    return createMockErrorResponse(404, mockErrorResponse404);
  };
}

/**
 * Create a mock deprecation warning response
 * Returns data but includes a Deprecation header
 */
export function createMockDeprecationResponse(data: unknown): Response {
  return createMockResponse(data, {
    headers: {
      Deprecation: 'true',
      Sunset: 'Sun, 01 Jun 2025 00:00:00 GMT',
      Link: '<https://docs.atlassian.com/jira-software/REST/9.12.0/>; rel="deprecation"',
    },
  });
}
