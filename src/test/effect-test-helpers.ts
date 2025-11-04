import { Effect, Exit, pipe, Schedule, Duration } from 'effect';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Effect-based test helpers for better testing patterns
 */

/**
 * Get a working temp directory, falling back to project directory if system tmp has issues
 */
function getTempDir(): string {
  try {
    // Try system tmp first
    const systemTmp = tmpdir();
    // Test if we can create a directory
    const testDir = join(systemTmp, `ji-test-${Date.now()}`);
    mkdirSync(testDir);
    rmSync(testDir, { recursive: true, force: true });
    return systemTmp;
  } catch {
    // Fall back to project .tmp directory
    const projectTmp = join(process.cwd(), '.tmp');
    if (!existsSync(projectTmp)) {
      mkdirSync(projectTmp, { recursive: true });
    }
    return projectTmp;
  }
}

/**
 * Creates a temporary directory with retry logic to handle macOS permission races
 */
function createTempDirWithRetry(prefix: string, maxRetries = 3): string {
  let lastError: Error | undefined;
  const baseTmpDir = getTempDir();

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Add random suffix to avoid collisions
      const uniquePrefix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`;
      return mkdtempSync(join(baseTmpDir, uniquePrefix));
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        // Wait a bit before retrying (exponential backoff)
        const delay = Math.min(10 * 2 ** i, 50);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }

  throw lastError || new Error('Failed to create temp directory');
}

/**
 * Removes a directory with retry logic to handle cleanup races
 */
function removeDirWithRetry(dir: string, maxRetries = 3): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return; // Success
    } catch (_error) {
      if (i < maxRetries - 1) {
        // Wait before retrying
        const delay = Math.min(10 * 2 ** i, 50);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }
}

/**
 * Creates a temporary directory Effect that cleans up after itself
 */
export const withTempDir = <A, E>(
  prefix: string,
  operation: (dir: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => createTempDirWithRetry(prefix)),
    operation,
    (dir) => Effect.sync(() => removeDirWithRetry(dir)),
  );

/**
 * Creates an Effect that saves and restores environment variables
 */
export const withEnvironment = <A, E>(vars: string[], operation: () => Effect.Effect<A, E>): Effect.Effect<A, E> => {
  const saved = new Map<string, string | undefined>();

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      for (const varName of vars) {
        saved.set(varName, process.env[varName]);
      }
    }),
    () => operation(),
    () =>
      Effect.sync(() => {
        for (const [varName, value] of saved) {
          if (value === undefined) {
            delete process.env[varName];
          } else {
            process.env[varName] = value;
          }
        }
      }),
  );
};

/**
 * Test helper for asserting Effect success
 */
export const expectSuccess = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
  const result = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(result)) {
    throw new Error(`Expected success but got failure: ${JSON.stringify(result.cause)}`);
  }
  return result.value;
};

/**
 * Test helper for asserting Effect failure
 */
export const expectFailure = async <E>(effect: Effect.Effect<unknown, E>): Promise<E> => {
  const result = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(result)) {
    throw new Error(`Expected failure but got success: ${JSON.stringify(result.value)}`);
  }
  // Extract the error from the cause
  const cause = result.cause;
  if ('_tag' in cause && cause._tag === 'Fail' && 'error' in cause) {
    return cause.error as E;
  }
  throw new Error(`Unexpected failure structure: ${JSON.stringify(cause)}`);
};

/**
 * Test helper for asserting specific error type
 */
export const expectErrorType = async <E extends { _tag: string }>(
  effect: Effect.Effect<unknown, E>,
  expectedTag: string,
): Promise<E> => {
  const error = await expectFailure(effect);
  if (!error || typeof error !== 'object' || !('_tag' in error)) {
    throw new Error(`Expected error with _tag but got: ${JSON.stringify(error)}`);
  }
  if (error._tag !== expectedTag) {
    throw new Error(`Expected error with _tag="${expectedTag}" but got _tag="${error._tag}"`);
  }
  return error as E;
};

/**
 * Mock fetch implementation for testing
 */
export class MockFetch {
  private responses: Map<string, { status: number; data: unknown }> = new Map();

  addResponse(url: string, status: number, data: unknown) {
    this.responses.set(url, { status, data });
  }

  createFetch() {
    return async (url: string, _options?: RequestInit) => {
      const response = this.responses.get(url);
      if (!response) {
        throw new Error(`No mock response for URL: ${url}`);
      }

      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: this.getStatusText(response.status),
        json: async () => response.data,
        text: async () => JSON.stringify(response.data),
        headers: new Headers(),
      } as Response;
    };
  }

  private getStatusText(status: number): string {
    const statusTexts: Record<number, string> = {
      200: 'OK',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error',
    };
    return statusTexts[status] || 'Unknown';
  }
}

/**
 * Retry helper with exponential backoff
 */
export const withRetry = <A, E>(
  effect: Effect.Effect<A, E>,
  options: {
    times?: number;
    delay?: Duration.Duration;
    factor?: number;
  } = {},
): Effect.Effect<A, E> => {
  const { times = 3, delay = Duration.millis(100), factor = 2 } = options;

  return Effect.retry(effect, Schedule.exponential(delay, factor).pipe(Schedule.intersect(Schedule.recurs(times - 1))));
};

/**
 * Test data builder for Jira issues
 */
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string; emailAddress: string } | null;
    created: string;
    updated: string;
  };
}

export class JiraIssueBuilder {
  private issue: JiraIssue = {
    key: 'TEST-1',
    fields: {
      summary: 'Test Issue',
      status: { name: 'To Do' },
      assignee: null,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    },
  };

  withKey(key: string): this {
    this.issue.key = key;
    return this;
  }

  withSummary(summary: string): this {
    this.issue.fields.summary = summary;
    return this;
  }

  withStatus(status: string): this {
    this.issue.fields.status = { name: status };
    return this;
  }

  withAssignee(name: string, email: string): this {
    this.issue.fields.assignee = { displayName: name, emailAddress: email };
    return this;
  }

  build() {
    return { ...this.issue };
  }
}

/**
 * Test data builder for config
 */
interface TestConfig {
  jiraUrl: string;
  email: string;
  apiToken: string;
  analysisCommand?: string;
}

export class ConfigBuilder {
  private config: TestConfig = {
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
  };

  withJiraUrl(url: string): this {
    this.config.jiraUrl = url;
    return this;
  }

  withEmail(email: string): this {
    this.config.email = email;
    return this;
  }

  withApiToken(token: string): this {
    this.config.apiToken = token;
    return this;
  }

  withAnalysisCommand(command: string): this {
    this.config.analysisCommand = command;
    return this;
  }

  build() {
    return { ...this.config };
  }
}

/**
 * Effect-based mock for ConfigManager
 */
export class MockConfigManager {
  private config: unknown = null;
  private settings: Record<string, unknown> = {};

  setMockConfig(config: unknown) {
    this.config = config;
  }

  setMockSettings(settings: Record<string, unknown>) {
    this.settings = settings;
  }

  getConfigEffect() {
    if (!this.config) {
      return Effect.fail(new Error('No configuration found'));
    }
    return Effect.succeed(this.config);
  }

  getSettingsEffect() {
    return Effect.succeed(this.settings);
  }

  setConfigEffect(config: unknown) {
    this.config = config;
    return Effect.succeed(undefined);
  }

  setSettingsEffect(settings: unknown) {
    this.settings = { ...this.settings, ...(settings as Record<string, unknown>) };
    return Effect.succeed(undefined);
  }
}
