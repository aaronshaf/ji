import { describe, expect, it } from 'bun:test';
import { Effect, Schema } from 'effect';
import {
  IssueSchema,
  SearchResultSchema,
  BoardSchema,
  BoardsResponseSchema,
  SprintSchema,
  SprintsResponseSchema,
} from './jira-client-types.js';

describe('jira-client-types schemas', () => {
  describe('IssueSchema', () => {
    it('should validate valid issue objects', async () => {
      const validIssue = {
        key: 'PROJ-123',
        self: 'https://company.atlassian.net/rest/api/2/issue/12345',
        fields: {
          summary: 'Test issue',
          status: { name: 'Open' },
          assignee: { displayName: 'John Doe' },
        },
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(IssueSchema)(validIssue));

      expect(result).toEqual(validIssue);
    });

    it('should accept any fields structure', async () => {
      const issueWithComplexFields = {
        key: 'ISSUE-456',
        self: 'https://test.com/api/issue/456',
        fields: {
          customField1: { nested: { value: 'test' } },
          customField2: [1, 2, 3],
          customField3: null,
          customField4: 'string',
        },
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(IssueSchema)(issueWithComplexFields));

      expect(result).toEqual(issueWithComplexFields);
    });

    it('should reject objects missing required fields', async () => {
      const invalidIssues = [
        { self: 'url', fields: {} }, // missing key
        { key: 'KEY-123' }, // missing self and fields
        {}, // missing all
      ];

      for (const [_index, invalidIssue] of invalidIssues.entries()) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(IssueSchema)(invalidIssue));
        expect(result._tag).toBe('Failure');
      }
    });

    it('should reject objects with wrong field types', async () => {
      const invalidIssues = [
        { key: 123, self: 'url', fields: {} }, // key not string
        { key: 'KEY-123', self: null, fields: {} }, // self not string
      ];

      for (const invalidIssue of invalidIssues) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(IssueSchema)(invalidIssue));
        expect(result._tag).toBe('Failure');
      }
    });
  });

  describe('SearchResultSchema', () => {
    it('should validate valid search results', async () => {
      const validSearchResult = {
        issues: [
          {
            key: 'PROJ-1',
            self: 'url1',
            fields: { summary: 'Issue 1' },
          },
          {
            key: 'PROJ-2',
            self: 'url2',
            fields: { summary: 'Issue 2' },
          },
        ],
        startAt: 0,
        maxResults: 50,
        total: 2,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SearchResultSchema)(validSearchResult));

      expect(result).toEqual(validSearchResult);
    });

    it('should validate search results with empty issues array', async () => {
      const emptySearchResult = {
        issues: [],
        startAt: 0,
        maxResults: 50,
        total: 0,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SearchResultSchema)(emptySearchResult));

      expect(result).toEqual(emptySearchResult);
    });

    it('should validate search results with optional fields (new /search/jql API)', async () => {
      // The new /rest/api/3/search/jql API may return responses without startAt, maxResults, total
      const minimalSearchResult = {
        issues: [{ key: 'TEST-1', self: 'https://test.atlassian.net/rest/api/3/issue/1', fields: {} }],
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SearchResultSchema)(minimalSearchResult));

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe('TEST-1');
    });

    it('should validate search results with nextPageToken', async () => {
      const searchResultWithToken = {
        issues: [],
        nextPageToken: 'abc123',
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SearchResultSchema)(searchResultWithToken));

      expect(result.nextPageToken).toBe('abc123');
    });

    it('should reject invalid search results', async () => {
      const invalidSearchResults = [
        { startAt: 0, maxResults: 50, total: 0 }, // missing issues
        { issues: 'not-array', startAt: 0, maxResults: 50, total: 0 }, // issues not array
        { issues: [], startAt: '0', maxResults: 50, total: 0 }, // startAt not number when provided
      ];

      for (const invalid of invalidSearchResults) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(SearchResultSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });

    it('should reject search results with invalid issues', async () => {
      const invalidSearchResult = {
        issues: [
          { key: 'VALID-1', self: 'url', fields: {} },
          { key: 'INVALID' }, // missing self and fields
        ],
        startAt: 0,
        maxResults: 50,
        total: 2,
      };

      const result = await Effect.runPromiseExit(Schema.decodeUnknown(SearchResultSchema)(invalidSearchResult));
      expect(result._tag).toBe('Failure');
    });
  });

  describe('BoardSchema', () => {
    it('should validate boards with all fields', async () => {
      const validBoard = {
        id: 1,
        name: 'Development Board',
        type: 'kanban',
        location: {
          projectKey: 'PROJ',
          projectName: 'Project Name',
        },
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(BoardSchema)(validBoard));

      expect(result).toEqual(validBoard);
    });

    it('should validate boards with minimal required fields', async () => {
      const minimalBoard = {
        id: 2,
        name: 'Test Board',
        type: 'scrum',
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(BoardSchema)(minimalBoard));

      expect(result).toEqual(minimalBoard);
    });

    it('should validate boards with partial location', async () => {
      const boardWithPartialLocation1 = {
        id: 3,
        name: 'Board 1',
        type: 'kanban',
        location: {
          projectKey: 'PROJ',
        },
      };

      const boardWithPartialLocation2 = {
        id: 4,
        name: 'Board 2',
        type: 'scrum',
        location: {
          projectName: 'Project Only',
        },
      };

      const result1 = await Effect.runPromise(Schema.decodeUnknown(BoardSchema)(boardWithPartialLocation1));
      expect(result1).toEqual(boardWithPartialLocation1);

      const result2 = await Effect.runPromise(Schema.decodeUnknown(BoardSchema)(boardWithPartialLocation2));
      expect(result2).toEqual(boardWithPartialLocation2);
    });

    it('should reject boards with missing required fields', async () => {
      const invalidBoards = [
        { name: 'Board', type: 'kanban' }, // missing id
        { id: 1, type: 'kanban' }, // missing name
        { id: 1, name: 'Board' }, // missing type
      ];

      for (const invalid of invalidBoards) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(BoardSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });

    it('should reject boards with wrong field types', async () => {
      const invalidBoards = [
        { id: '1', name: 'Board', type: 'kanban' }, // id not number
        { id: 1, name: 123, type: 'kanban' }, // name not string
        { id: 1, name: 'Board', type: null }, // type not string
      ];

      for (const invalid of invalidBoards) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(BoardSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });
  });

  describe('BoardsResponseSchema', () => {
    it('should validate valid boards response', async () => {
      const validResponse = {
        values: [
          { id: 1, name: 'Board 1', type: 'kanban' },
          { id: 2, name: 'Board 2', type: 'scrum', location: { projectKey: 'PROJ' } },
        ],
        startAt: 0,
        maxResults: 50,
        total: 2,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(BoardsResponseSchema)(validResponse));

      expect(result).toEqual(validResponse);
    });

    it('should validate empty boards response', async () => {
      const emptyResponse = {
        values: [],
        startAt: 0,
        maxResults: 50,
        total: 0,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(BoardsResponseSchema)(emptyResponse));

      expect(result).toEqual(emptyResponse);
    });

    it('should reject invalid boards response', async () => {
      const invalidResponses = [
        { startAt: 0, maxResults: 50, total: 0 }, // missing values
        { values: [], maxResults: 50, total: 0 }, // missing startAt
        { values: 'not-array', startAt: 0, maxResults: 50, total: 0 }, // values not array
      ];

      for (const invalid of invalidResponses) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(BoardsResponseSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });
  });

  describe('SprintSchema', () => {
    it('should validate sprints with all fields', async () => {
      const validSprint = {
        id: 1,
        self: 'https://company.atlassian.net/rest/agile/1.0/sprint/1',
        state: 'active',
        name: 'Sprint 1',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-14T23:59:59.999Z',
        originBoardId: 123,
        goal: 'Complete user authentication',
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SprintSchema)(validSprint));

      expect(result).toEqual(validSprint);
    });

    it('should validate sprints with minimal required fields', async () => {
      const minimalSprint = {
        id: 2,
        self: 'https://test.com/sprint/2',
        state: 'closed',
        name: 'Sprint 2',
        originBoardId: 456,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SprintSchema)(minimalSprint));

      expect(result).toEqual(minimalSprint);
    });

    it('should validate sprints with some optional fields', async () => {
      const sprintVariations = [
        {
          id: 3,
          self: 'url',
          state: 'future',
          name: 'Sprint 3',
          startDate: '2024-02-01T00:00:00.000Z',
          originBoardId: 789,
        },
        {
          id: 4,
          self: 'url',
          state: 'active',
          name: 'Sprint 4',
          endDate: '2024-02-14T23:59:59.999Z',
          originBoardId: 789,
        },
        {
          id: 5,
          self: 'url',
          state: 'active',
          name: 'Sprint 5',
          goal: 'Fix critical bugs',
          originBoardId: 789,
        },
      ];

      for (const sprint of sprintVariations) {
        const result = await Effect.runPromise(Schema.decodeUnknown(SprintSchema)(sprint));
        expect(result).toEqual(sprint);
      }
    });

    it('should reject sprints with missing required fields', async () => {
      const invalidSprints = [
        { self: 'url', state: 'active', name: 'Sprint', originBoardId: 1 }, // missing id
        { id: 1, state: 'active', name: 'Sprint', originBoardId: 1 }, // missing self
        { id: 1, self: 'url', name: 'Sprint', originBoardId: 1 }, // missing state
        { id: 1, self: 'url', state: 'active', originBoardId: 1 }, // missing name
        { id: 1, self: 'url', state: 'active', name: 'Sprint' }, // missing originBoardId
      ];

      for (const invalid of invalidSprints) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(SprintSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });

    it('should reject sprints with wrong field types', async () => {
      const invalidSprints = [
        { id: '1', self: 'url', state: 'active', name: 'Sprint', originBoardId: 1 }, // id not number
        { id: 1, self: 123, state: 'active', name: 'Sprint', originBoardId: 1 }, // self not string
        { id: 1, self: 'url', state: null, name: 'Sprint', originBoardId: 1 }, // state not string
        { id: 1, self: 'url', state: 'active', name: true, originBoardId: 1 }, // name not string
        { id: 1, self: 'url', state: 'active', name: 'Sprint', originBoardId: '1' }, // originBoardId not number
      ];

      for (const invalid of invalidSprints) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(SprintSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });
  });

  describe('SprintsResponseSchema', () => {
    it('should validate valid sprints response', async () => {
      const validResponse = {
        values: [
          {
            id: 1,
            self: 'url1',
            state: 'active',
            name: 'Sprint 1',
            originBoardId: 123,
          },
          {
            id: 2,
            self: 'url2',
            state: 'closed',
            name: 'Sprint 2',
            startDate: '2024-01-01T00:00:00.000Z',
            endDate: '2024-01-14T23:59:59.999Z',
            originBoardId: 456,
            goal: 'Complete features',
          },
        ],
        startAt: 0,
        maxResults: 50,
        total: 2,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SprintsResponseSchema)(validResponse));

      expect(result).toEqual(validResponse);
    });

    it('should validate empty sprints response', async () => {
      const emptyResponse = {
        values: [],
        startAt: 0,
        maxResults: 50,
        total: 0,
      };

      const result = await Effect.runPromise(Schema.decodeUnknown(SprintsResponseSchema)(emptyResponse));

      expect(result).toEqual(emptyResponse);
    });

    it('should reject invalid sprints response structure', async () => {
      const invalidResponses = [
        { startAt: 0, maxResults: 50, total: 0 }, // missing values
        { values: [], maxResults: 50, total: 0 }, // missing startAt
        { values: 'not-array', startAt: 0, maxResults: 50, total: 0 }, // values not array
      ];

      for (const invalid of invalidResponses) {
        const result = await Effect.runPromiseExit(Schema.decodeUnknown(SprintsResponseSchema)(invalid));
        expect(result._tag).toBe('Failure');
      }
    });

    it('should reject response with invalid sprints', async () => {
      const responseWithInvalidSprint = {
        values: [
          { id: 1, self: 'url', state: 'active', name: 'Valid Sprint', originBoardId: 123 },
          { id: 2, self: 'url', state: 'active', name: 'Invalid Sprint' }, // missing originBoardId
        ],
        startAt: 0,
        maxResults: 50,
        total: 2,
      };

      const result = await Effect.runPromiseExit(
        Schema.decodeUnknown(SprintsResponseSchema)(responseWithInvalidSprint),
      );
      expect(result._tag).toBe('Failure');
    });
  });

  describe('schema integration', () => {
    it('should handle complex nested validation scenarios', async () => {
      // Test that schemas work together in realistic scenarios
      const searchResultWithBoards = {
        issues: [
          {
            key: 'PROJ-123',
            self: 'https://company.atlassian.net/rest/api/2/issue/123',
            fields: {
              summary: 'Test issue',
              customBoard: {
                id: 1,
                name: 'Development',
                type: 'kanban',
                location: {
                  projectKey: 'PROJ',
                  projectName: 'Test Project',
                },
              },
            },
          },
        ],
        startAt: 0,
        maxResults: 1,
        total: 1,
      };

      // This tests that the Unknown fields in IssueSchema can contain complex objects
      const result = await Effect.runPromise(Schema.decodeUnknown(SearchResultSchema)(searchResultWithBoards));

      expect((result.issues[0].fields as any).customBoard.name).toBe('Development');
      expect((result.issues[0].fields as any).customBoard.location?.projectKey).toBe('PROJ');
    });
  });
});
