import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Effect } from 'effect';
import { HttpResponse, http } from 'msw';
import { server } from '../../test/setup-msw';
import { JiraClientIssuesMutations } from './jira-client-issues-mutations.js';
import type { Config } from '../config.js';
import {
  mockTransitions,
  mockTransitionsWithVariants,
  mockTransitionsNoCompletion,
  mockErrorResponse404,
  mockErrorResponse401,
} from '../../test/fixtures/jira-api-responses.js';

describe('JiraClientIssuesMutations', () => {
  let client: JiraClientIssuesMutations;
  let mockConfig: Config;

  beforeEach(() => {
    process.env.ALLOW_REAL_API_CALLS = 'true';

    mockConfig = {
      jiraUrl: 'https://test-mutations.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    };
    client = new JiraClientIssuesMutations(mockConfig);
  });

  afterEach(() => {
    delete process.env.ALLOW_REAL_API_CALLS;
  });

  describe('transitionIssue', () => {
    it('should transition issue successfully', async () => {
      server.use(
        http.post('*/rest/api/3/issue/PMUT-001/transitions', () => {
          return HttpResponse.text('', { status: 204 });
        }),
      );

      await expect(client.transitionIssue('PMUT-001', '31')).resolves.toBeUndefined();
    });

    it('should throw error for non-existent issue', async () => {
      server.use(
        http.post('*/rest/api/3/issue/PMUT-002/transitions', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      await expect(client.transitionIssue('PMUT-002', '31')).rejects.toThrow();
    });
  });

  describe('transitionIssueEffect', () => {
    it('should transition issue successfully', async () => {
      server.use(
        http.post('*/rest/api/3/issue/PMUT-003/transitions', () => {
          return HttpResponse.text('', { status: 204 });
        }),
      );

      const result = await Effect.runPromiseExit(client.transitionIssueEffect('PMUT-003', '31'));

      expect(result._tag).toBe('Success');
    });

    it('should fail with ValidationError for invalid issue key', async () => {
      const result = await Effect.runPromiseExit(client.transitionIssueEffect('invalid', '31'));

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

    it('should fail with ValidationError for empty transition ID', async () => {
      const result = await Effect.runPromiseExit(client.transitionIssueEffect('PMUT-004', ''));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Die');
        if (result.cause._tag === 'Die') {
          expect(result.cause.defect).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('Transition ID cannot be empty'),
          });
        }
      }
    });

    it('should fail with NotFoundError for non-existent issue', async () => {
      server.use(
        http.post('*/rest/api/3/issue/PMUT-005/transitions', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      const result = await Effect.runPromiseExit(client.transitionIssueEffect('PMUT-005', '31'));

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
        http.post('*/rest/api/3/issue/PMUT-006/transitions', () => {
          return HttpResponse.json(mockErrorResponse401, { status: 401 });
        }),
      );

      const result = await Effect.runPromiseExit(client.transitionIssueEffect('PMUT-006', '31'));

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

    it('should fail with ValidationError for invalid transition', async () => {
      server.use(
        http.post('*/rest/api/3/issue/PMUT-007/transitions', () => {
          return HttpResponse.json(
            {
              errorMessages: ['Invalid transition'],
              errors: {},
            },
            { status: 400 },
          );
        }),
      );

      const result = await Effect.runPromiseExit(client.transitionIssueEffect('PMUT-007', '999'));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('Invalid transition'),
          });
        }
      }
    });
  });

  describe('closeIssueEffect', () => {
    it('should find and use "Done" transition', async () => {
      const mockGetTransitions = () => Effect.succeed(mockTransitions.transitions);
      let transitionedWith: string | null = null;

      server.use(
        http.post('*/rest/api/3/issue/PMUT-008/transitions', async ({ request }) => {
          const body = (await request.json()) as { transition: { id: string } };
          transitionedWith = body.transition.id;
          return HttpResponse.text('', { status: 204 });
        }),
      );

      const result = await Effect.runPromiseExit(client.closeIssueEffect('PMUT-008', mockGetTransitions));

      expect(result._tag).toBe('Success');
      // biome-ignore lint/style/noNonNullAssertion: Test verifies the handler sets this value
      expect(transitionedWith!).toBe('31');
    });

    it('should prioritize completion transitions in order', async () => {
      const mockGetTransitions = () => Effect.succeed(mockTransitionsWithVariants.transitions);
      let transitionedWith: string | null = null;

      server.use(
        http.post('*/rest/api/3/issue/PMUT-009/transitions', async ({ request }) => {
          const body = (await request.json()) as { transition: { id: string } };
          transitionedWith = body.transition.id;
          return HttpResponse.text('', { status: 204 });
        }),
      );

      await Effect.runPromise(client.closeIssueEffect('PMUT-009', mockGetTransitions));

      // biome-ignore lint/style/noNonNullAssertion: Test verifies the handler sets this value
      expect(transitionedWith!).toBe('31');
    });

    it('should fail with ValidationError when no completion transition exists', async () => {
      const mockGetTransitions = () => Effect.succeed(mockTransitionsNoCompletion.transitions);

      const result = await Effect.runPromiseExit(client.closeIssueEffect('PMUT-010', mockGetTransitions));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Fail');
        if (result.cause._tag === 'Fail') {
          expect(result.cause.error).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('No Done/completion transition found'),
          });
        }
      }
    });
  });

  describe('assignIssue', () => {
    it('should assign issue successfully', async () => {
      server.use(
        http.put('*/rest/api/3/issue/PMUT-011/assignee', () => {
          return HttpResponse.text('', { status: 204 });
        }),
      );

      await expect(client.assignIssue('PMUT-011', 'account-id-123')).resolves.toBeUndefined();
    });

    it('should throw error for non-existent issue', async () => {
      server.use(
        http.put('*/rest/api/3/issue/PMUT-012/assignee', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      await expect(client.assignIssue('PMUT-012', 'account-id-123')).rejects.toThrow();
    });
  });

  describe('assignIssueEffect', () => {
    it('should assign issue successfully', async () => {
      server.use(
        http.put('*/rest/api/3/issue/PMUT-013/assignee', () => {
          return HttpResponse.text('', { status: 204 });
        }),
      );

      const result = await Effect.runPromiseExit(client.assignIssueEffect('PMUT-013', 'account-id-123'));

      expect(result._tag).toBe('Success');
    });

    it('should fail with ValidationError for invalid issue key', async () => {
      const result = await Effect.runPromiseExit(client.assignIssueEffect('invalid', 'account-id-123'));

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

    it('should fail with ValidationError for empty account ID', async () => {
      const result = await Effect.runPromiseExit(client.assignIssueEffect('PMUT-014', ''));

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.cause._tag).toBe('Die');
        if (result.cause._tag === 'Die') {
          expect(result.cause.defect).toMatchObject({
            _tag: 'ValidationError',
            message: expect.stringContaining('Account ID cannot be empty'),
          });
        }
      }
    });

    it('should fail with NotFoundError for non-existent issue', async () => {
      server.use(
        http.put('*/rest/api/3/issue/PMUT-015/assignee', () => {
          return HttpResponse.json(mockErrorResponse404, { status: 404 });
        }),
      );

      const result = await Effect.runPromiseExit(client.assignIssueEffect('PMUT-015', 'account-id-123'));

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
        http.put('*/rest/api/3/issue/PMUT-016/assignee', () => {
          return HttpResponse.json(mockErrorResponse401, { status: 401 });
        }),
      );

      const result = await Effect.runPromiseExit(client.assignIssueEffect('PMUT-016', 'account-id-123'));

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

    it('should send correct request body', async () => {
      let requestBody: { accountId: string } | null = null;

      server.use(
        http.put('*/rest/api/3/issue/PMUT-017/assignee', async ({ request }) => {
          requestBody = (await request.json()) as { accountId: string };
          return HttpResponse.text('', { status: 204 });
        }),
      );

      await Effect.runPromise(client.assignIssueEffect('PMUT-017', 'account-id-456'));

      // biome-ignore lint/style/noNonNullAssertion: Test verifies the handler sets this value
      expect(requestBody!).toEqual({ accountId: 'account-id-456' });
    });
  });

  describe('backward compatibility', () => {
    it('transitionIssue should delegate to transitionIssueEffect', async () => {
      server.use(
        http.post('*/rest/api/3/issue/PMUT-018/transitions', () => {
          return HttpResponse.text('', { status: 204 });
        }),
      );

      await expect(client.transitionIssue('PMUT-018', '31')).resolves.toBeUndefined();
      await expect(Effect.runPromise(client.transitionIssueEffect('PMUT-018', '31'))).resolves.toBeUndefined();
    });

    it('assignIssue should delegate to assignIssueEffect', async () => {
      server.use(
        http.put('*/rest/api/3/issue/PMUT-019/assignee', () => {
          return HttpResponse.text('', { status: 204 });
        }),
      );

      await expect(client.assignIssue('PMUT-019', 'account-id-123')).resolves.toBeUndefined();
      await expect(Effect.runPromise(client.assignIssueEffect('PMUT-019', 'account-id-123'))).resolves.toBeUndefined();
    });
  });
});
