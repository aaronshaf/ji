import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Effect } from 'effect';
import { HttpResponse, http } from 'msw';
import { server } from '../../test/setup-msw';
import { JiraClientIssuesRead } from './jira-client-issues-read.js';
import type { Config } from '../config.js';
import {
  mockIssueMinimal,
  mockIssueFull,
  mockSearchResultNewFormat,
  mockSearchResultNewFormatWithPagination,
  mockSearchResultEmpty,
  mockTransitions,
  mockErrorResponse404,
  mockErrorResponse401,
} from '../../test/fixtures/jira-api-responses.js';

describe('JiraClientIssuesRead', () => {
  let client: JiraClientIssuesRead;
  let mockConfig: Config;

  beforeEach(() => {
    // Allow client instantiation - MSW will intercept all network requests
    process.env.ALLOW_REAL_API_CALLS = 'true';

    mockConfig = {
      jiraUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    };
    client = new JiraClientIssuesRead(mockConfig);
  });

  afterEach(() => {
    // Reset handlers added by this test file
    // Note: The global server is managed by setup-msw.ts
    delete process.env.ALLOW_REAL_API_CALLS;
  });

  describe('getIssue', () => {
    it('should fetch and return an issue', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-123', () => {
          return HttpResponse.json(mockIssueMinimal);
        }),
      );

      const issue = await client.getIssue('PROJ-123');

      expect(issue.key).toBe('PROJ-123');
      expect(issue.fields.summary).toBe('Test issue');
    });

    it('should throw error for non-existent issue', async () => {
      server.use(
        http.get('*/rest/api/3/issue/NONEXIST-1', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      // Delegates to getIssueEffect which throws NotFoundError
      await expect(client.getIssue('NONEXIST-1')).rejects.toThrow('Issue NONEXIST-1 not found');
    });
  });

  describe('getIssueEffect', () => {
    it('should fetch issue successfully', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-123', () => {
          return HttpResponse.json(mockIssueMinimal);
        }),
      );

      const result = await Effect.runPromise(client.getIssueEffect('PROJ-123'));

      expect(result.key).toBe('PROJ-123');
      expect(result.fields.summary).toBe('Test issue');
    });

    it('should fail with ValidationError for invalid issue key format', async () => {
      const result = await Effect.runPromiseExit(client.getIssueEffect('invalid-key'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Die');
        if (result.cause._tag === 'Die') {
          expect(result.cause.defect).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('Invalid issue key format'),
          });
        }
      }
    });

    it('should fail with NotFoundError for non-existent issue', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-404', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      const result = await Effect.runPromiseExit(client.getIssueEffect('PROJ-404'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'NotFoundError',
          });
        }
      }
    });

    it('should fail with AuthenticationError for unauthorized access', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-123', () => {
          return HttpResponse.json(mockErrorResponse401, { status: 401 });
        }),
      );

      const result = await Effect.runPromiseExit(client.getIssueEffect('PROJ-123'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'AuthenticationError',
          });
        }
      }
    });
  });

  describe('searchIssues', () => {
    it('should search issues with JQL', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json(mockSearchResultNewFormatWithPagination);
        }),
      );

      const result = await client.searchIssues('project = PROJ');

      expect(result.issues).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.startAt).toBe(0);
    });

    it('should handle empty search results', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json(mockSearchResultEmpty);
        }),
      );

      const result = await client.searchIssues('project = EMPTY');

      expect(result.issues).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should use fallback for missing total field (new API format)', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json(mockSearchResultNewFormat);
        }),
      );

      const result = await client.searchIssues('project = PROJ');

      expect(result.total).toBe(result.issues.length); // Fallback
    });

    it('should support pagination options', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', ({ request }) => {
          const url = new URL(request.url);
          const startAt = url.searchParams.get('startAt');
          expect(startAt).toBe('50');
          return HttpResponse.json({
            issues: [mockIssueMinimal],
            startAt: 50,
            maxResults: 50,
            total: 100,
          });
        }),
      );

      const result = await client.searchIssues('project = PROJ', {
        startAt: 50,
        maxResults: 50,
      });

      expect(result.startAt).toBe(50);
    });
  });

  describe('searchIssuesEffect', () => {
    it('should search issues successfully', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json(mockSearchResultNewFormatWithPagination);
        }),
      );

      const result = await Effect.runPromise(client.searchIssuesEffect('project = PROJ'));

      expect(result.issues).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should fail with ValidationError for empty JQL', async () => {
      const result = await Effect.runPromiseExit(client.searchIssuesEffect(''));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Die');
        if (result.cause._tag === 'Die') {
          expect(result.cause.defect).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('JQL query cannot be empty'),
          });
        }
      }
    });

    it('should fail with AuthenticationError for unauthorized access', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json(mockErrorResponse401, { status: 401 });
        }),
      );

      const result = await Effect.runPromiseExit(client.searchIssuesEffect('project = PROJ'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'AuthenticationError',
          });
        }
      }
    });
  });

  describe('getAllProjectIssues', () => {
    it('should fetch all issues across multiple pages', async () => {
      let requestCount = 0;
      server.use(
        http.get('*/rest/api/3/search/jql', ({ request }) => {
          const url = new URL(request.url);
          const startAt = parseInt(url.searchParams.get('startAt') || '0');
          const maxResults = parseInt(url.searchParams.get('maxResults') || '100');
          requestCount++;

          // Delegates to getAllProjectIssuesEffect which makes initial count request with maxResults=1
          if (maxResults === 1) {
            return HttpResponse.json({
              issues: [mockIssueMinimal],
              total: 150,
            });
          }

          if (startAt === 0) {
            return HttpResponse.json({
              issues: Array(100).fill(mockIssueMinimal),
              startAt: 0,
              maxResults: 100,
              total: 150,
            });
          }
          return HttpResponse.json({
            issues: Array(50).fill(mockIssueMinimal),
            startAt: 100,
            maxResults: 100,
            total: 150,
          });
        }),
      );

      const issues = await client.getAllProjectIssues('PROJ');

      expect(issues).toHaveLength(150);
      // Expects 3 requests: 1 count + 2 data pages
      expect(requestCount).toBe(3);
    });

    it('should call onProgress callback', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json({
            issues: Array(10).fill(mockIssueMinimal),
            startAt: 0,
            maxResults: 100,
            total: 10,
          });
        }),
      );

      const progressCalls: Array<{ current: number; total: number }> = [];
      await client.getAllProjectIssues('PROJ', (current, total) => {
        progressCalls.push({ current, total });
      });

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0]).toEqual({ current: 10, total: 10 });
    });
  });

  describe('getAllProjectIssuesEffect', () => {
    it('should fetch all project issues with concurrent fetching', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', ({ request }) => {
          const url = new URL(request.url);
          const maxResults = parseInt(url.searchParams.get('maxResults') || '100');

          if (maxResults === 1) {
            // Initial count request
            return HttpResponse.json({
              issues: [mockIssueMinimal],
              total: 10,
            });
          }
          // Subsequent page requests
          return HttpResponse.json({
            issues: [mockIssueMinimal],
            total: 10,
          });
        }),
      );

      const result = await Effect.runPromise(client.getAllProjectIssuesEffect('PROJ'));

      expect(result.length).toBeGreaterThan(0);
    });

    it('should fail with ValidationError for empty project key', async () => {
      const result = await Effect.runPromiseExit(client.getAllProjectIssuesEffect(''));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Die');
        if (result.cause._tag === 'Die') {
          expect(result.cause.defect).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('Project key cannot be empty'),
          });
        }
      }
    });

    it('should return empty array for project with no issues', async () => {
      server.use(
        http.get('*/rest/api/3/search/jql', () => {
          return HttpResponse.json({
            issues: [],
            total: 0,
          });
        }),
      );

      const result = await Effect.runPromise(client.getAllProjectIssuesEffect('EMPTY'));

      expect(result).toEqual([]);
    });
  });

  describe('getIssueTransitions', () => {
    it('should fetch available transitions', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-123/transitions', () => {
          return HttpResponse.json(mockTransitions);
        }),
      );

      const transitions = await client.getIssueTransitions('PROJ-123');

      expect(transitions).toHaveLength(3);
      expect(transitions[0]).toEqual({ id: '11', name: 'To Do' });
    });
  });

  describe('getIssueTransitionsEffect', () => {
    it('should fetch transitions successfully', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-123/transitions', () => {
          return HttpResponse.json(mockTransitions);
        }),
      );

      const result = await Effect.runPromise(client.getIssueTransitionsEffect('PROJ-123'));

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('To Do');
    });

    it('should fail with ValidationError for invalid issue key', async () => {
      const result = await Effect.runPromiseExit(client.getIssueTransitionsEffect('invalid'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Die');
        if (result.cause._tag === 'Die') {
          expect(result.cause.defect).toMatchObject({
            _tag: 'ValidationError',
          });
        }
      }
    });

    it('should fail with NotFoundError for non-existent issue', async () => {
      server.use(
        http.get('*/rest/api/3/issue/PROJ-404/transitions', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      const result = await Effect.runPromiseExit(client.getIssueTransitionsEffect('PROJ-404'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'NotFoundError',
          });
        }
      }
    });
  });

  describe('getCustomFields', () => {
    it('should fetch custom fields', async () => {
      server.use(
        http.get('*/rest/api/3/field', () => {
          return HttpResponse.json([
            {
              id: 'customfield_10001',
              name: 'Epic Link',
              description: 'Link to parent epic',
              schema: { type: 'string' },
              custom: true,
            },
            {
              id: 'summary',
              name: 'Summary',
              schema: { type: 'string' },
              custom: false,
            },
          ]);
        }),
      );

      const fields = await client.getCustomFields();

      expect(Array.isArray(fields)).toBe(true);
      expect(fields).toHaveLength(1); // Only custom fields
      expect(fields[0].id).toBe('customfield_10001');
    });
  });

  describe('getCustomFieldsEffect', () => {
    it('should fetch custom fields successfully', async () => {
      server.use(
        http.get('*/rest/api/3/field', () => {
          return HttpResponse.json([
            {
              id: 'customfield_10001',
              name: 'Epic Link',
              description: 'Link to parent epic',
              schema: { type: 'string' },
              custom: true,
            },
            {
              id: 'summary',
              name: 'Summary',
              schema: { type: 'string' },
              custom: false,
            },
          ]);
        }),
      );

      const result = await Effect.runPromise(client.getCustomFieldsEffect());

      expect(result).toHaveLength(1); // Only custom fields
      expect(result[0].id).toBe('customfield_10001');
    });

    it('should fail with AuthenticationError for unauthorized access', async () => {
      server.use(
        http.get('*/rest/api/3/field', () => {
          return HttpResponse.json(mockErrorResponse401, { status: 401 });
        }),
      );

      const result = await Effect.runPromiseExit(client.getCustomFieldsEffect());

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'AuthenticationError',
          });
        }
      }
    });
  });
});
