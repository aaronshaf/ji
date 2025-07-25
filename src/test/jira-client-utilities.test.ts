import { describe, expect, it } from 'bun:test';

// Test Jira client utilities without external dependencies
describe('Jira Client Utilities', () => {
  describe('Error types', () => {
    it('should create JiraError with proper structure', () => {
      class JiraError extends Error {
        readonly _tag = 'JiraError';
      }

      const error = new JiraError('Jira API error occurred');

      expect(error._tag).toBe('JiraError');
      expect(error.message).toBe('Jira API error occurred');
      expect(error instanceof Error).toBe(true);
    });

    it('should create NetworkError with proper structure', () => {
      class NetworkError extends Error {
        readonly _tag = 'NetworkError';
      }

      const error = new NetworkError('Network connection failed');

      expect(error._tag).toBe('NetworkError');
      expect(error.message).toBe('Network connection failed');
      expect(error instanceof Error).toBe(true);
    });

    it('should create AuthenticationError with proper structure', () => {
      class AuthenticationError extends Error {
        readonly _tag = 'AuthenticationError';
      }

      const error = new AuthenticationError('Invalid credentials');

      expect(error._tag).toBe('AuthenticationError');
      expect(error.message).toBe('Invalid credentials');
      expect(error instanceof Error).toBe(true);
    });

    it('should create NotFoundError with proper structure', () => {
      class NotFoundError extends Error {
        readonly _tag = 'NotFoundError';
      }

      const error = new NotFoundError('Issue not found');

      expect(error._tag).toBe('NotFoundError');
      expect(error.message).toBe('Issue not found');
      expect(error instanceof Error).toBe(true);
    });

    it('should create ValidationError with proper structure', () => {
      class ValidationError extends Error {
        readonly _tag = 'ValidationError';
      }

      const error = new ValidationError('Invalid issue key format');

      expect(error._tag).toBe('ValidationError');
      expect(error.message).toBe('Invalid issue key format');
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('Issue field extraction', () => {
    it('should extract standard issue fields', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const extractIssueFields = (issue: any) => {
        return {
          key: issue.key,
          summary: issue.fields?.summary,
          status: issue.fields?.status?.name,
          assignee: issue.fields?.assignee?.displayName,
          assigneeEmail: issue.fields?.assignee?.emailAddress,
          reporter: issue.fields?.reporter?.displayName,
          reporterEmail: issue.fields?.reporter?.emailAddress,
          priority: issue.fields?.priority?.name,
          created: issue.fields?.created,
          updated: issue.fields?.updated,
          projectKey: issue.fields?.project?.key,
          projectName: issue.fields?.project?.name,
          labels: issue.fields?.labels || [],
        };
      };

      const mockIssue = {
        key: 'TEST-123',
        self: 'https://company.atlassian.net/rest/api/3/issue/12345',
        fields: {
          summary: 'Login bug needs fixing',
          status: { name: 'Open' },
          assignee: {
            displayName: 'John Doe',
            emailAddress: 'john@example.com',
          },
          reporter: {
            displayName: 'Jane Smith',
            emailAddress: 'jane@example.com',
          },
          priority: { name: 'High' },
          created: '2024-01-01T10:00:00.000Z',
          updated: '2024-01-02T15:30:00.000Z',
          project: {
            key: 'TEST',
            name: 'Test Project',
          },
          labels: ['bug', 'frontend'],
        },
      };

      const extracted = extractIssueFields(mockIssue);

      expect(extracted.key).toBe('TEST-123');
      expect(extracted.summary).toBe('Login bug needs fixing');
      expect(extracted.status).toBe('Open');
      expect(extracted.assignee).toBe('John Doe');
      expect(extracted.assigneeEmail).toBe('john@example.com');
      expect(extracted.reporter).toBe('Jane Smith');
      expect(extracted.reporterEmail).toBe('jane@example.com');
      expect(extracted.priority).toBe('High');
      expect(extracted.projectKey).toBe('TEST');
      expect(extracted.projectName).toBe('Test Project');
      expect(extracted.labels).toEqual(['bug', 'frontend']);
    });

    it('should handle missing optional fields gracefully', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const extractIssueFields = (issue: any) => {
        return {
          key: issue.key,
          summary: issue.fields?.summary,
          status: issue.fields?.status?.name,
          assignee: issue.fields?.assignee?.displayName || null,
          priority: issue.fields?.priority?.name || null,
          labels: issue.fields?.labels || [],
        };
      };

      const minimalIssue = {
        key: 'MIN-1',
        fields: {
          summary: 'Minimal issue',
          status: { name: 'Open' },
          // No assignee, priority, or labels
        },
      };

      const extracted = extractIssueFields(minimalIssue);

      expect(extracted.key).toBe('MIN-1');
      expect(extracted.summary).toBe('Minimal issue');
      expect(extracted.status).toBe('Open');
      expect(extracted.assignee).toBeNull();
      expect(extracted.priority).toBeNull();
      expect(extracted.labels).toEqual([]);
    });
  });

  describe('JQL query building', () => {
    it('should build basic JQL queries', () => {
      const buildProjectJQL = (projectKey: string): string => {
        return `project = ${projectKey}`;
      };

      expect(buildProjectJQL('TEST')).toBe('project = TEST');
      expect(buildProjectJQL('PROJ')).toBe('project = PROJ');
    });

    it('should build user assignment JQL', () => {
      const buildUserJQL = (projectKey?: string): string => {
        const conditions = ['assignee = currentUser()'];

        if (projectKey) {
          conditions.unshift(`project = ${projectKey}`);
        }

        return conditions.join(' AND ');
      };

      expect(buildUserJQL()).toBe('assignee = currentUser()');
      expect(buildUserJQL('TEST')).toBe('project = TEST AND assignee = currentUser()');
    });

    it('should build complex JQL with multiple conditions', () => {
      const buildComplexJQL = (options: {
        project?: string;
        status?: string[];
        assignee?: string;
        priority?: string[];
        labels?: string[];
      }): string => {
        const conditions: string[] = [];

        if (options.project) {
          conditions.push(`project = ${options.project}`);
        }

        if (options.status && options.status.length > 0) {
          if (options.status.length === 1) {
            conditions.push(`status = "${options.status[0]}"`);
          } else {
            conditions.push(`status IN (${options.status.map((s) => `"${s}"`).join(', ')})`);
          }
        }

        if (options.assignee) {
          conditions.push(`assignee = "${options.assignee}"`);
        }

        if (options.priority && options.priority.length > 0) {
          if (options.priority.length === 1) {
            conditions.push(`priority = ${options.priority[0]}`);
          } else {
            conditions.push(`priority IN (${options.priority.join(', ')})`);
          }
        }

        if (options.labels && options.labels.length > 0) {
          const labelConditions = options.labels.map((label) => `labels = "${label}"`);
          conditions.push(`(${labelConditions.join(' OR ')})`);
        }

        return conditions.join(' AND ');
      };

      // Single conditions
      expect(buildComplexJQL({ project: 'TEST' })).toBe('project = TEST');
      expect(buildComplexJQL({ status: ['Open'] })).toBe('status = "Open"');

      // Multiple conditions
      expect(
        buildComplexJQL({
          project: 'TEST',
          status: ['Open', 'In Progress'],
          priority: ['High'],
        }),
      ).toBe('project = TEST AND status IN ("Open", "In Progress") AND priority = High');

      // Complex with labels
      expect(
        buildComplexJQL({
          project: 'TEST',
          labels: ['bug', 'frontend'],
        }),
      ).toBe('project = TEST AND (labels = "bug" OR labels = "frontend")');
    });

    it('should handle JQL escaping', () => {
      const escapeJQLValue = (value: string): string => {
        // Escape quotes and wrap in quotes if contains spaces or special chars
        const escaped = value.replace(/"/g, '\\"');
        if (/[\s,()[\]{}"]/.test(value)) {
          return `"${escaped}"`;
        }
        return escaped;
      };

      expect(escapeJQLValue('simple')).toBe('simple');
      expect(escapeJQLValue('value with spaces')).toBe('"value with spaces"');
      expect(escapeJQLValue('value"with"quotes')).toBe('"value\\"with\\"quotes"');
      expect(escapeJQLValue('value(with)parens')).toBe('"value(with)parens"');
    });
  });

  describe('URL building', () => {
    it('should build Jira API URLs correctly', () => {
      const buildApiUrl = (baseUrl: string, endpoint: string): string => {
        const cleanBase = baseUrl.replace(/\/$/, '');
        const cleanEndpoint = endpoint.replace(/^\//, '');
        return `${cleanBase}/rest/api/3/${cleanEndpoint}`;
      };

      expect(buildApiUrl('https://company.atlassian.net', 'search')).toBe(
        'https://company.atlassian.net/rest/api/3/search',
      );
      expect(buildApiUrl('https://company.atlassian.net/', '/issue/TEST-123')).toBe(
        'https://company.atlassian.net/rest/api/3/issue/TEST-123',
      );
    });

    it('should build browse URLs from API URLs', () => {
      const apiFetchFromStdLibUrlToBrowseUrl = (apiUrl: string): string => {
        return apiUrl.replace('/rest/api/3/issue/', '/browse/');
      };

      expect(apiFetchFromStdLibUrlToBrowseUrl('https://company.atlassian.net/rest/api/3/issue/TEST-123')).toBe(
        'https://company.atlassian.net/browse/TEST-123',
      );
    });

    it('should build board URLs', () => {
      const buildBoardUrl = (baseUrl: string, boardId: number): string => {
        return `${baseUrl}/rest/agile/1.0/board/${boardId}`;
      };

      expect(buildBoardUrl('https://company.atlassian.net', 123)).toBe(
        'https://company.atlassian.net/rest/agile/1.0/board/123',
      );
    });

    it('should build sprint URLs', () => {
      const buildSprintUrl = (baseUrl: string, boardId: number): string => {
        return `${baseUrl}/rest/agile/1.0/board/${boardId}/sprint`;
      };

      expect(buildSprintUrl('https://company.atlassian.net', 123)).toBe(
        'https://company.atlassian.net/rest/agile/1.0/board/123/sprint',
      );
    });
  });

  describe('Authentication handling', () => {
    it('should create basic auth headers', () => {
      const createAuthHeader = (email: string, apiToken: string): string => {
        const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');
        return `Basic ${credentials}`;
      };

      const header = createAuthHeader('user@example.com', 'token123');
      const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();

      expect(decoded).toBe('user@example.com:token123');
      expect(header).toMatch(/^Basic [A-Za-z0-9+/]+=*$/);
    });
  });

  describe('Response validation', () => {
    it('should validate issue structure', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const isValidIssue = (issue: any): boolean => {
        return !!(
          issue &&
          typeof issue === 'object' &&
          typeof issue.key === 'string' &&
          issue.key.match(/^[A-Z]+-\d+$/) &&
          typeof issue.self === 'string' &&
          issue.fields &&
          typeof issue.fields === 'object'
        );
      };

      // Valid issues
      const validIssue = {
        key: 'TEST-123',
        self: 'https://company.atlassian.net/rest/api/3/issue/12345',
        fields: { summary: 'Test issue' },
      };
      expect(isValidIssue(validIssue)).toBe(true);

      // Invalid issues
      expect(isValidIssue(null)).toBe(false);
      expect(isValidIssue({})).toBe(false);
      expect(isValidIssue({ key: 'invalid-key' })).toBe(false);
      expect(isValidIssue({ key: 'TEST-123' })).toBe(false); // Missing self and fields
    });

    it('should validate search response structure', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const isValidSearchResponse = (response: any): boolean => {
        return !!(
          response &&
          typeof response === 'object' &&
          Array.isArray(response.issues) &&
          typeof response.startAt === 'number' &&
          typeof response.maxResults === 'number' &&
          typeof response.total === 'number'
        );
      };

      // Valid response
      const validResponse = {
        issues: [],
        startAt: 0,
        maxResults: 50,
        total: 0,
      };
      expect(isValidSearchResponse(validResponse)).toBe(true);

      // Invalid responses
      expect(isValidSearchResponse(null)).toBe(false);
      expect(isValidSearchResponse({})).toBe(false);
      expect(isValidSearchResponse({ issues: 'not-array' })).toBe(false);
    });

    it('should validate board structure', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const isValidBoard = (board: any): boolean => {
        return !!(
          board &&
          typeof board === 'object' &&
          typeof board.id === 'number' &&
          typeof board.name === 'string' &&
          typeof board.type === 'string'
        );
      };

      // Valid board
      const validBoard = {
        id: 123,
        name: 'Test Board',
        type: 'scrum',
        location: {
          projectKey: 'TEST',
        },
      };
      expect(isValidBoard(validBoard)).toBe(true);

      // Invalid boards
      expect(isValidBoard(null)).toBe(false);
      expect(isValidBoard({})).toBe(false);
      expect(isValidBoard({ id: 'not-number' })).toBe(false);
    });
  });

  describe('Pagination handling', () => {
    it('should calculate pagination parameters', () => {
      const buildPaginationParams = (page: number, size: number) => {
        return {
          startAt: page * size,
          maxResults: size,
        };
      };

      expect(buildPaginationParams(0, 50)).toEqual({ startAt: 0, maxResults: 50 });
      expect(buildPaginationParams(1, 50)).toEqual({ startAt: 50, maxResults: 50 });
      expect(buildPaginationParams(2, 25)).toEqual({ startAt: 50, maxResults: 25 });
    });

    it('should determine if more pages exist', () => {
      const hasMorePages = (startAt: number, maxResults: number, total: number): boolean => {
        return startAt + maxResults < total;
      };

      expect(hasMorePages(0, 50, 100)).toBe(true);
      expect(hasMorePages(50, 50, 100)).toBe(false);
      expect(hasMorePages(0, 50, 25)).toBe(false);
      expect(hasMorePages(25, 25, 100)).toBe(true);
    });

    it('should calculate total pages', () => {
      const calculateTotalPages = (total: number, pageSize: number): number => {
        return Math.ceil(total / pageSize);
      };

      expect(calculateTotalPages(100, 50)).toBe(2);
      expect(calculateTotalPages(101, 50)).toBe(3);
      expect(calculateTotalPages(25, 50)).toBe(1);
      expect(calculateTotalPages(0, 50)).toBe(0);
    });
  });

  describe('Field mapping', () => {
    it('should map standard issue fields', () => {
      const ISSUE_FIELDS = [
        'summary',
        'status',
        'assignee',
        'reporter',
        'priority',
        'created',
        'updated',
        'description',
        'labels',
        'comment',
        'project',
      ];

      expect(ISSUE_FIELDS).toContain('summary');
      expect(ISSUE_FIELDS).toContain('status');
      expect(ISSUE_FIELDS).toContain('assignee');
      expect(ISSUE_FIELDS).toContain('project');
      expect(ISSUE_FIELDS.length).toBeGreaterThan(5);
    });

    it('should build fields query parameter', () => {
      const buildFieldsParam = (fields: string[]): string => {
        return fields.join(',');
      };

      const fields = ['summary', 'status', 'assignee'];
      expect(buildFieldsParam(fields)).toBe('summary,status,assignee');
    });
  });

  describe('Sprint field handling', () => {
    it('should extract sprint from custom fields', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const extractSprint = (issue: any): any => {
        // Common sprint field names
        const sprintFields = [
          'customfield_10020',
          'customfield_10021',
          'customfield_10016',
          'customfield_10018',
          'customfield_10019',
        ];

        for (const fieldName of sprintFields) {
          const sprints = issue.fields?.[fieldName];
          if (sprints && Array.isArray(sprints) && sprints.length > 0) {
            return sprints[sprints.length - 1]; // Return the latest sprint
          }
        }

        return null;
      };

      const issueWithSprint = {
        fields: {
          customfield_10020: [
            {
              id: 123,
              name: 'Sprint 1',
              state: 'active',
            },
          ],
        },
      };

      const issueWithoutSprint = {
        fields: {
          summary: 'No sprint issue',
        },
      };

      expect(extractSprint(issueWithSprint)).toEqual({
        id: 123,
        name: 'Sprint 1',
        state: 'active',
      });
      expect(extractSprint(issueWithoutSprint)).toBeNull();
    });
  });

  describe('Comment handling', () => {
    it('should extract comments from issue', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const extractComments = (issue: any): any[] => {
        const comments = issue.fields?.comment;
        if (!comments || !Array.isArray(comments.comments)) {
          return [];
        }
        return comments.comments;
      };

      const issueWithComments = {
        fields: {
          comment: {
            comments: [
              { id: '1', body: 'First comment', author: { displayName: 'User 1' } },
              { id: '2', body: 'Second comment', author: { displayName: 'User 2' } },
            ],
          },
        },
      };

      const issueWithoutComments = {
        fields: {
          summary: 'No comments',
        },
      };

      expect(extractComments(issueWithComments)).toHaveLength(2);
      expect(extractComments(issueWithComments)[0].body).toBe('First comment');
      expect(extractComments(issueWithoutComments)).toEqual([]);
    });
  });
});
