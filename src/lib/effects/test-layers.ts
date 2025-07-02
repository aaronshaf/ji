/**
 * Test layers for Effect-based testing
 * These layers provide test doubles and mocks for testing
 */

import { Database } from 'bun:sqlite';
import { Effect, Layer, pipe, Ref } from 'effect';
import type { Config as JiConfig } from '../config.js';
import { DatabaseError, NetworkError } from './errors.js';
import {
  ConfigServiceTag,
  DatabaseServiceTag,
  type HttpClientService,
  HttpClientServiceTag,
  type LoggerService,
  LoggerServiceTag,
} from './layers.js';

// ============= Test Configuration Layer =============
export const TestConfigServiceLive = Layer.effect(
  ConfigServiceTag,
  Effect.gen(function* () {
    const configRef = yield* Ref.make<JiConfig>({
      jiraUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token-123',
    });

    const settingsRef = yield* Ref.make<Map<string, string>>(new Map());

    return {
      getConfig: Ref.get(configRef),

      setConfig: (config: JiConfig) => Ref.set(configRef, config),

      getSetting: (key: string) =>
        pipe(
          Ref.get(settingsRef),
          Effect.map((settings) => settings.get(key) || null),
        ),

      setSetting: (key: string, value: string) =>
        Ref.update(settingsRef, (settings) => {
          const newSettings = new Map(settings);
          newSettings.set(key, value);
          return newSettings;
        }),

      reload: Effect.succeed(undefined),
    };
  }),
);

// ============= Test Database Layer =============
export const TestDatabaseServiceLive = Layer.scoped(
  DatabaseServiceTag,
  Effect.gen(function* () {
    // Use in-memory SQLite for tests
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(':memory:')),
      (db) => Effect.sync(() => db.close()),
    );

    // Initialize test schema
    yield* Effect.sync(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS test_table (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          value TEXT
        )
      `);
    });

    const inTransactionRef = yield* Ref.make(false);

    return {
      execute: <T>(sql: string, params?: unknown[]) =>
        Effect.try({
          try: () => {
            const stmt = db.prepare(sql);
            return (params ? stmt.run(...(params as never[])) : stmt.run()) as T;
          },
          catch: (error) => new DatabaseError(`Test query execution failed: ${error}`),
        }),

      query: <T>(sql: string, params?: unknown[]) =>
        Effect.try({
          try: () => {
            const stmt = db.prepare(sql);
            return (params ? stmt.all(...(params as never[])) : stmt.all()) as T[];
          },
          catch: (error) => new DatabaseError(`Test query failed: ${error}`),
        }),

      transaction: <R, E, A>(effect: Effect.Effect<R, E, A>) =>
        pipe(
          Ref.get(inTransactionRef),
          Effect.flatMap((inTransaction) =>
            inTransaction
              ? Effect.fail(new DatabaseError('Nested transactions not supported'))
              : Effect.succeed(undefined),
          ),
          Effect.flatMap(() => Ref.set(inTransactionRef, true)),
          Effect.flatMap(() =>
            Effect.try({
              try: () => db.run('BEGIN'),
              catch: (error) => new DatabaseError(`Failed to begin test transaction: ${error}`),
            }),
          ),
          Effect.flatMap(() => effect),
          Effect.tap(() =>
            Effect.try({
              try: () => db.run('COMMIT'),
              catch: (error) => new DatabaseError(`Failed to commit test transaction: ${error}`),
            }),
          ),
          Effect.tap(() => Ref.set(inTransactionRef, false)),
          Effect.catchAll((error) =>
            pipe(
              Effect.try({
                try: () => db.run('ROLLBACK'),
                catch: (rollbackError) => new DatabaseError(`Failed to rollback test transaction: ${rollbackError}`),
              }),
              Effect.flatMap(() => Ref.set(inTransactionRef, false)),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        ),

      getConnection: Effect.succeed(db),
    };
  }),
);

// ============= Test HTTP Client Layer =============
interface MockResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

interface MockExpectation {
  method?: string;
  url: string | RegExp;
  response: MockResponse | ((url: string, options?: RequestInit) => MockResponse);
}

export class TestHttpClientService {
  private expectations: MockExpectation[] = [];
  private calls: Array<{ url: string; options?: RequestInit }> = [];

  expectRequest(expectation: MockExpectation): void {
    this.expectations.push(expectation);
  }

  getCalls(): Array<{ url: string; options?: RequestInit }> {
    return [...this.calls];
  }

  reset(): void {
    this.expectations = [];
    this.calls = [];
  }

  makeService(): HttpClientService {
    const findExpectation = (url: string, method?: string): MockExpectation | undefined => {
      return this.expectations.find((exp) => {
        const urlMatches = exp.url instanceof RegExp ? exp.url.test(url) : exp.url === url;
        const methodMatches = !exp.method || exp.method === method;
        return urlMatches && methodMatches;
      });
    };

    const makeRequest = <T>(url: string, options?: RequestInit) => {
      this.calls.push({ url, options });

      const expectation = findExpectation(url, options?.method);
      if (!expectation) {
        return Effect.fail(new NetworkError(`No mock found for ${options?.method || 'GET'} ${url}`));
      }

      const response =
        typeof expectation.response === 'function' ? expectation.response(url, options) : expectation.response;

      if (response.status >= 400) {
        return Effect.fail(new NetworkError(`HTTP ${response.status}`));
      }

      return Effect.succeed(response.data as T);
    };

    return {
      request: makeRequest,

      get: <T>(url: string, headers?: Record<string, string>) => makeRequest<T>(url, { method: 'GET', headers }),

      post: <T>(url: string, body: unknown, headers?: Record<string, string>) =>
        makeRequest<T>(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
        }),

      put: <T>(url: string, body: unknown, headers?: Record<string, string>) =>
        makeRequest<T>(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
        }),

      delete: <T>(url: string, headers?: Record<string, string>) => makeRequest<T>(url, { method: 'DELETE', headers }),
    };
  }
}

export const createTestHttpClientLayer = (mockService: TestHttpClientService) =>
  Layer.succeed(HttpClientServiceTag, mockService.makeService());

// ============= Test Logger Layer =============
export interface TestLogEntry {
  level: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp: Date;
}

export class TestLoggerService {
  private logs: TestLogEntry[] = [];

  getLogs(): TestLogEntry[] {
    return [...this.logs];
  }

  getLogsByLevel(level: string): TestLogEntry[] {
    return this.logs.filter((log) => log.level === level);
  }

  clear(): void {
    this.logs = [];
  }

  makeService(): LoggerService {
    const log = (level: string, message: string, context?: Record<string, unknown>) => {
      this.logs.push({
        level,
        message,
        context,
        timestamp: new Date(),
      });
      return Effect.succeed(undefined);
    };

    return {
      debug: (message: string, context?: Record<string, unknown>) => log('DEBUG', message, context),

      info: (message: string, context?: Record<string, unknown>) => log('INFO', message, context),

      warn: (message: string, context?: Record<string, unknown>) => log('WARN', message, context),

      error: (message: string, error?: unknown, context?: Record<string, unknown>) =>
        log('ERROR', message, {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        }),
    };
  }
}

export const createTestLoggerLayer = (logger: TestLoggerService) =>
  Layer.succeed(LoggerServiceTag, logger.makeService());

// ============= Combined Test Layer =============
export const createTestAppLayer = (httpClient?: TestHttpClientService, logger?: TestLoggerService) => {
  const http = httpClient || new TestHttpClientService();
  const log = logger || new TestLoggerService();

  return TestConfigServiceLive.pipe(
    Layer.provideMerge(TestDatabaseServiceLive),
    Layer.provideMerge(createTestHttpClientLayer(http)),
    Layer.provideMerge(createTestLoggerLayer(log)),
  );
};

// ============= Test Utilities =============
// Helper to run effects with test layers - use Effect.runPromise directly for more control

// Example test helper for HTTP expectations
export const expectHttpCall = (
  httpClient: TestHttpClientService,
  expected: {
    method?: string;
    url: string | RegExp;
    response?: unknown;
    status?: number;
  },
) => {
  httpClient.expectRequest({
    method: expected.method,
    url: expected.url,
    response: {
      status: expected.status || 200,
      data: expected.response || {},
    },
  });
};
