import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Effect, Either, Schema } from 'effect';
import { analyzeIssue, JiraApiError, ResponseExtractionError, ToolNotFoundError } from '../cli/commands/analyze.js';
import { EnvironmentSaver } from './test-helpers.js';
import type { Config } from '../lib/config.js';
import type { Issue } from '../lib/jira-client.js';

// Define Comment type locally for tests
type Comment = {
  id: string;
  author: { displayName: string };
  created: string;
  body: string;
};

import { IssueSchema } from '../lib/effects/jira/schemas.js';
import { createValidIssue, validateAndReturn } from './msw-schema-validation.js';
import { HttpResponse, http } from 'msw';
import { server } from './setup-msw';

// ============= Test Schemas =============
const TestConfigSchema = Schema.Struct({
  jiraUrl: Schema.String,
  email: Schema.String,
  apiToken: Schema.String,
  analysisCommand: Schema.optional(Schema.String),
});

const TestCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.Struct({
    displayName: Schema.String,
  }),
  created: Schema.String,
  body: Schema.String,
});

const TestOptionsSchema = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.Union(Schema.Literal('claude'), Schema.Literal('gemini'), Schema.Literal('opencode'))),
  yes: Schema.optional(Schema.Boolean),
});

// ============= Mock Data with Schema Validation =============
const createMockConfig = (overrides?: Partial<Config>): Config => {
  const config = {
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
    analysisCommand: 'claude -p',
    ...overrides,
  };

  // Validate with schema
  return Schema.decodeSync(TestConfigSchema)(config) as Config;
};

const createMockIssue = (overrides?: Partial<Issue>): Issue => {
  const issue = createValidIssue({
    key: 'TEST-123',
    ...overrides,
  });

  issue.fields.summary = 'Test Issue Summary';
  issue.fields.description = 'Test issue description with details';
  issue.fields.status = { name: 'In Progress' };
  issue.fields.assignee = {
    displayName: 'John Doe',
    emailAddress: 'john@example.com',
    accountId: 'john-account-id',
  };
  issue.fields.reporter = {
    displayName: 'Jane Smith',
    emailAddress: 'jane@example.com',
    accountId: 'jane-account-id',
  };
  issue.fields.priority = { name: 'High' };
  issue.fields.created = '2024-01-15T10:00:00.000Z';
  issue.fields.updated = '2024-01-16T14:30:00.000Z';
  issue.fields.project = { key: 'TEST', name: 'Test Project' };
  issue.fields.issuetype = { name: 'Task' } as unknown;
  issue.fields.customfield_10035 = 'Acceptance criteria text';

  return validateAndReturn(IssueSchema, issue, 'Mock Issue') as Issue;
};

const createMockComments = (): Comment[] => {
  const comments = [
    {
      id: '1',
      author: { displayName: 'Alice' },
      created: '2024-01-15T12:00:00.000Z',
      body: 'First comment',
    },
    {
      id: '2',
      author: { displayName: 'Bob' },
      created: '2024-01-15T13:00:00.000Z',
      body: 'Second comment',
    },
  ];

  // Validate each comment
  return comments.map((c) => Schema.decodeSync(TestCommentSchema)(c)) as Comment[];
};

// ============= Test Setup =============
describe.skip('Analyze Command with Effect and MSW', () => {
  const envSaver = new EnvironmentSaver();
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let mockConfig: Config;
  let mockIssue: Issue;
  let mockComments: Comment[];

  beforeEach(() => {
    // Clear any previous mocks first
    mock.restore();

    // Save environment variables properly
    envSaver.save('NODE_ENV');
    envSaver.save('ALLOW_REAL_API_CALLS');
    envSaver.save('DEBUG');

    process.env.NODE_ENV = 'test';
    process.env.ALLOW_REAL_API_CALLS = 'true'; // Allow our mocked calls

    consoleLogSpy = spyOn(console, 'log');
    consoleErrorSpy = spyOn(console, 'error');

    // Create validated mock data
    mockConfig = createMockConfig();
    mockIssue = createMockIssue();
    mockComments = createMockComments();

    // Mock ConfigManager
    mock.module('../lib/config.js', () => ({
      ConfigManager: class {
        async getConfig() {
          return mockConfig;
        }
        close() {}
      },
    }));

    // Mock file system with Effect
    mock.module('node:fs', () => ({
      existsSync: mock((path: string) => {
        return Effect.runSync(
          Effect.sync(() => {
            if (path === '/path/to/prompt.md') return true;
            if (path.includes('default-analysis-prompt.md')) return true;
            if (path === '/custom/prompt.md') return true;
            return false;
          }),
        );
      }),
      readFileSync: mock((path: string) => {
        return Effect.runSync(
          Effect.gen(function* () {
            if (path === '/path/to/prompt.md') {
              return 'Custom prompt content';
            }
            if (path.includes('default-analysis-prompt.md')) {
              return 'Default prompt content';
            }
            if (path === '/custom/prompt.md') {
              return 'Alternative prompt content';
            }
            return yield* Effect.fail(new Error(`File not found: ${path}`));
          }).pipe(
            Effect.orDie, // Convert to runtime error for fs compatibility
          ),
        );
      }),
    }));
  });

  afterEach(() => {
    // Properly restore environment
    envSaver.restore();

    // Clear all mocks
    mock.restore();

    // MSW's global afterEach will reset handlers automatically
  });

  describe('Effect Schema Validation', () => {
    test('validates issue key format with Schema', async () => {
      const IssueKeySchema = Schema.String.pipe(Schema.pattern(/^[A-Z]+-\d+$/));

      const invalidKeys = ['test-123', 'TEST123', '123-TEST', 'test', '123'];

      for (const key of invalidKeys) {
        const result = Schema.decodeUnknownEither(IssueKeySchema)(key);
        expect(Either.isLeft(result)).toBe(true);

        // The actual command should reject invalid keys
        await expect(analyzeIssue(key)).rejects.toThrow();
      }
    });

    test('validates options with Effect Schema', async () => {
      const validOptions = [
        { prompt: '/path/to/prompt.md', tool: 'claude' as const, yes: true },
        { tool: 'gemini' as const },
        { yes: false },
        {},
      ];

      for (const options of validOptions) {
        const result = Schema.decodeUnknownEither(TestOptionsSchema)(options);
        expect(Either.isRight(result)).toBe(true);
      }

      // Invalid tool should fail
      const invalidOptions = { tool: 'invalid' };
      const result = Schema.decodeUnknownEither(TestOptionsSchema)(invalidOptions);
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe('Network Request Interception', () => {
    test('intercepts all Jira API calls - no real network requests', async () => {
      let apiCallCount = 0;

      server.use(
        http.get('*/rest/api/3/issue/TEST-123', ({ request }) => {
          apiCallCount++;
          // Ensure we're not hitting real Atlassian
          expect(request.url).not.toContain('atlassian.com');
          expect(request.url).toContain('test.atlassian.net');

          return HttpResponse.json(mockIssue);
        }),
        http.get('*/rest/api/3/issue/TEST-123/comment', () => {
          apiCallCount++;
          return HttpResponse.json({ comments: mockComments });
        }),
        http.post('*/rest/api/2/issue/TEST-123/comment', () => {
          apiCallCount++;
          return HttpResponse.json({ id: '3', created: new Date().toISOString() }, { status: 201 });
        }),
      );

      // Mock tool execution
      mock.module('node:child_process', () => ({
        spawn: mock(() => {
          const mockProcess = {
            stdin: {
              write: mock(),
              end: mock(),
            },
            stdout: {
              on: mock((event: string, cb: (data: Buffer) => void) => {
                if (event === 'data') {
                  cb(Buffer.from('<ji-response>Analysis result from AI</ji-response>'));
                }
              }),
            },
            stderr: { on: mock() },
            on: mock((event: string, cb: (code?: number) => void) => {
              if (event === 'close') {
                setTimeout(() => cb(0), 10);
              }
            }),
          };
          return mockProcess;
        }),
      }));

      await analyzeIssue('TEST-123', { comment: true, yes: true });

      // Verify API was called but not real network
      expect(apiCallCount).toBeGreaterThan(0);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Comment posted successfully'));
    });

    test('fails immediately on unmocked API calls', async () => {
      // Don't install any fetch mock - should fail
      // MSW's global afterEach will reset handlers automatically

      // This should fail because fetch is not mocked
      await analyzeIssue('TEST-123');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Effect-based Tool Detection', () => {
    test('uses Effect.all for parallel tool checking', async () => {
      const toolChecks: string[] = [];

      mock.module('node:child_process', () => ({
        spawn: mock((cmd: string, args: string[]) => {
          if (cmd === 'which') {
            toolChecks.push(args[0]);
            const tool = args[0];
            const exitCode = tool === 'claude' ? 0 : 1;

            return {
              on: mock((event: string, cb: (code?: number | Error) => void) => {
                if (event === 'close') {
                  // Call immediately, no need for async delay in tests
                  setTimeout(() => cb(exitCode), 0);
                } else if (event === 'error') {
                  // Tool not found - don't call for successful tools
                  if (exitCode !== 0) {
                    setTimeout(() => cb(new Error('Command not found')), 0);
                  }
                }
              }),
              stdio: 'ignore',
            };
          }

          // Mock for actual tool execution
          return createMockToolProcess('<ji-response>Test</ji-response>');
        }),
      }));

      // Setup API mocks
      setupMockApiHandlers();

      // Remove analysisCommand to trigger detection
      mockConfig = createMockConfig({ analysisCommand: undefined });

      await analyzeIssue('TEST-123', { comment: true, yes: true });

      // Should check multiple tools
      expect(toolChecks).toContain('claude');
      // The "Using analysis tool" message has been removed for cleaner output
    });

    test('handles all tools unavailable with proper Effect error', async () => {
      mock.module('node:child_process', () => ({
        spawn: mock((cmd: string) => {
          if (cmd === 'which') {
            return {
              on: mock((event: string, cb: (code: number) => void) => {
                if (event === 'close') {
                  cb(1); // All tools unavailable
                }
              }),
              stdio: 'ignore',
            };
          }
          return null;
        }),
      }));

      setupMockApiHandlers();
      mockConfig = createMockConfig({ analysisCommand: undefined });

      await analyzeIssue('TEST-123', { yes: true });

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No analysis tool found'));
    });
  });

  describe('Effect Resource Management', () => {
    test('properly cleans up ConfigManager with Effect.acquireRelease pattern', async () => {
      let configManagerClosed = false;

      mock.module('../lib/config.js', () => ({
        ConfigManager: class {
          async getConfig() {
            return mockConfig;
          }
          close() {
            configManagerClosed = true;
          }
        },
      }));

      setupMockApiHandlers();
      mockToolExecution('<ji-response>Test</ji-response>');

      await analyzeIssue('TEST-123', { yes: true });

      // ConfigManager should be closed
      expect(configManagerClosed).toBe(true);
    });

    test('handles readline cleanup with Effect.scoped', async () => {
      let readlineInterfaceClosed = false;

      // Mock readline to track cleanup
      mock.module('node:readline/promises', () => ({
        createInterface: mock(() => ({
          question: mock(async () => 'n'), // User says no
          close: mock(() => {
            readlineInterfaceClosed = true;
          }),
        })),
      }));

      setupMockApiHandlers();
      mockToolExecution('<ji-response>Test comment</ji-response>');

      // Use comment flag but not yes flag to trigger confirmation
      await analyzeIssue('TEST-123', { comment: true, yes: false });

      // Readline should be closed even when user cancels
      expect(readlineInterfaceClosed).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Comment not posted'));
    });
  });

  describe('Effect Error Handling', () => {
    test('discriminates errors using _tag property', async () => {
      // Test ToolNotFoundError
      const toolError = new ToolNotFoundError('No tools', ['claude', 'gemini']);
      expect(toolError._tag).toBe('ToolNotFoundError');
      expect(toolError.tools).toEqual(['claude', 'gemini']);

      // Test JiraApiError
      const apiError = new JiraApiError('API failed', 'TEST-123');
      expect(apiError._tag).toBe('JiraApiError');
      expect(apiError.issueKey).toBe('TEST-123');

      // Test ResponseExtractionError
      const responseError = new ResponseExtractionError('No response', 'output text');
      expect(responseError._tag).toBe('ResponseExtractionError');
      expect(responseError.output).toBe('output text');
    });

    test('uses Effect.catchTag for specific error handling', async () => {
      server.use(
        http.get('*/rest/api/3/issue/TEST-123', () => {
          return HttpResponse.error();
        }),
      );

      await analyzeIssue('TEST-123');

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch issue'));
    });

    test('provides debug context with Effect error cause', async () => {
      // Save and set DEBUG properly
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = 'true';

      try {
        setupMockApiHandlers();
        mockToolExecution('Invalid output without tags');

        await analyzeIssue('TEST-123', { yes: true });

        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Tool output:'));
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid output without tags'));
      } finally {
        // Restore DEBUG
        if (originalDebug === undefined) {
          delete process.env.DEBUG;
        } else {
          process.env.DEBUG = originalDebug;
        }
      }
    });
  });

  describe('Effect Composition with pipe', () => {
    test('composes issue fetching and formatting with pipe', async () => {
      let issueFormatted = false;
      let commentsFetched = false;

      server.use(
        http.get('*/rest/api/3/issue/TEST-123', () => {
          return HttpResponse.json(createMockIssue());
        }),
        http.get('*/rest/api/3/issue/TEST-123/comment', () => {
          commentsFetched = true;
          return HttpResponse.json({ comments: mockComments });
        }),
      );

      mockToolExecution('<ji-response>Analysis</ji-response>', (input: string) => {
        // Verify XML was properly formatted
        expect(input).toContain('<issue>');
        expect(input).toContain('<key>TEST-123</key>');
        expect(input).toContain('</issue>');
        issueFormatted = true;
      });

      await analyzeIssue('TEST-123', { yes: true });

      expect(issueFormatted).toBe(true);
      expect(commentsFetched).toBe(true);
    });

    test('handles Effect.orElse for comment fetch failures', async () => {
      server.use(
        http.get('*/rest/api/3/issue/TEST-123', () => {
          return HttpResponse.json(createMockIssue());
        }),
        http.get('*/rest/api/3/issue/TEST-123/comment', () => {
          // Simulate comment GET failure
          return HttpResponse.text('Comments unavailable', { status: 500 });
        }),
        http.post('*/rest/api/2/issue/TEST-123/comment', () => {
          // Allow posting comment even though GET failed
          return HttpResponse.json({ id: '3', created: new Date().toISOString() }, { status: 201 });
        }),
      );

      mockToolExecution('<ji-response>Analysis without comments</ji-response>');

      // Should succeed despite comment failure
      await analyzeIssue('TEST-123', { comment: true, yes: true });

      // Check that analysis completed (either with success or graceful handling)
      const logCalls = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]);
      const _errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]);

      // Since comment fetch fails but analysis should still complete,
      // we should see either success or the posting step
      const hasPosting = logCalls.some((msg: unknown) => typeof msg === 'string' && msg.includes('Posting comment'));
      const hasSuccess = logCalls.some(
        (msg: unknown) =>
          typeof msg === 'string' && (msg.includes('Analysis complete') || msg.includes('comment posted')),
      );

      // The test should have attempted to post the comment
      expect(hasPosting || hasSuccess).toBe(true);
    });
  });

  describe('XML Generation with Effect.sync', () => {
    test('escapes XML characters properly', async () => {
      const issueWithSpecialChars = createMockIssue();
      issueWithSpecialChars.fields.summary = 'Issue with <tags> & "quotes"';
      issueWithSpecialChars.fields.description = 'Description with > and < symbols';

      let capturedXml = '';

      server.use(
        http.get('*/rest/api/3/issue/TEST-123', () => {
          return HttpResponse.json(issueWithSpecialChars);
        }),
        http.get('*/rest/api/3/issue/TEST-123/comment', () => {
          return HttpResponse.json({ comments: [] });
        }),
      );

      mockToolExecution('<ji-response>Test</ji-response>', (input: string) => {
        capturedXml = input;
      });

      await analyzeIssue('TEST-123', { yes: true });

      // Verify proper XML escaping
      expect(capturedXml).toContain('&lt;tags&gt;');
      expect(capturedXml).toContain('&amp;');
      expect(capturedXml).toContain('&quot;quotes&quot;');
      expect(capturedXml).toContain('&gt;');
      expect(capturedXml).toContain('&lt;');
    });
  });

  describe('Effect.gen for Sequential Operations', () => {
    test('loads prompts sequentially with Effect.gen', async () => {
      const loadOrder: string[] = [];

      mock.module('node:fs', () => ({
        existsSync: mock((path: string) => {
          loadOrder.push(`check:${path}`);
          return path === '/custom/prompt.md';
        }),
        readFileSync: mock((path: string) => {
          loadOrder.push(`read:${path}`);
          return 'Custom prompt from file';
        }),
      }));

      setupMockApiHandlers();
      mockToolExecution('<ji-response>Test</ji-response>');

      await analyzeIssue('TEST-123', {
        prompt: '/custom/prompt.md',
        yes: true,
      });

      // Should check then read in order
      expect(loadOrder).toEqual(['check:/custom/prompt.md', 'read:/custom/prompt.md']);
    });

    test('falls back through prompt sources with Effect.gen', async () => {
      const attempts: string[] = [];

      mock.module('node:fs', () => ({
        existsSync: mock((path: string) => {
          attempts.push(path);
          return path.includes('default-analysis-prompt.md');
        }),
        readFileSync: mock((path: string) => {
          if (path.includes('default-analysis-prompt.md')) {
            return 'Default prompt';
          }
          throw new Error('Not found');
        }),
      }));

      // Remove analysisCommand from config
      mockConfig = createMockConfig({ analysisCommand: undefined });

      setupMockApiHandlers();
      mockToolExecution('<ji-response>Test</ji-response>');

      await analyzeIssue('TEST-123', { yes: true });

      // Should have tried to find default prompt
      expect(attempts.some((p) => p.includes('default-analysis-prompt.md'))).toBe(true);
    });
  });
});

// ============= Helper Functions =============

function setupMockApiHandlers(options?: { failIssue?: boolean; failComments?: boolean }) {
  server.use(
    http.get('*/rest/api/3/issue/TEST-123', () => {
      if (options?.failIssue) {
        return HttpResponse.text('Not found', { status: 404 });
      }
      const issue = createMockIssue();
      return HttpResponse.json(issue);
    }),
    http.get('*/rest/api/3/issue/TEST-123/comment', () => {
      if (options?.failComments) {
        return HttpResponse.text('Failed to fetch comments', { status: 500 });
      }
      const comments = createMockComments();
      return HttpResponse.json({ comments });
    }),
    http.post('*/rest/api/2/issue/TEST-123/comment', () => {
      return HttpResponse.json({ id: '3', created: new Date().toISOString() }, { status: 201 });
    }),
  );
}

function createMockToolProcess(response: string, onInput?: (input: string) => void) {
  let stdinData = '';

  return {
    stdin: {
      write: mock((data: string) => {
        stdinData += data;
      }),
      end: mock(() => {
        if (onInput) {
          onInput(stdinData);
        }
      }),
    },
    stdout: {
      on: mock((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') {
          setTimeout(() => cb(Buffer.from(response)), 10);
        }
      }),
    },
    stderr: { on: mock() },
    on: mock((event: string, cb: (code?: number | Error) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    }),
  };
}

function mockToolExecution(response: string, onInput?: (input: string) => void) {
  mock.module('node:child_process', () => ({
    spawn: mock(() => createMockToolProcess(response, onInput)),
  }));
}
