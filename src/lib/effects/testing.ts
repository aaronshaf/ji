import { Duration, Effect, Option, pipe } from 'effect';
import type { CacheService } from './caching-layer.js';
import type { AppConfig, ConfigurationService } from './configuration.js';
import type { LoggingService } from './logging.js';

/**
 * Test configuration for Effect-based tests
 */
export interface TestConfig {
  timeout: Duration.Duration;
  retries: number;
  parallel: boolean;
  seed: number;
  logging: boolean;
  cleanup: boolean;
}

/**
 * Test fixture interface
 */
export interface TestFixture<T> {
  name: string;
  setup: () => Effect.Effect<T, Error>;
  teardown: (resource: T) => Effect.Effect<void, Error>;
  data: T;
}

/**
 * Property-based test generator
 */
export interface PropertyGenerator<T> {
  generate: () => Effect.Effect<T, never>;
  shrink: (value: T) => Effect.Effect<T[], never>;
  name: string;
}

/**
 * Test assertion utilities
 */
export class EffectTestAssertions {
  /**
   * Assert that an Effect succeeds with the expected value
   */
  static succeeds = <T, E>(effect: Effect.Effect<T, E>, expected: T): Effect.Effect<void, Error> =>
    pipe(
      effect,
      Effect.map((actual) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      }),
      Effect.mapError((error) => new Error(`Effect should succeed but failed: ${error}`)),
    );

  /**
   * Assert that an Effect fails with the expected error type
   */
  static fails = <T, E extends Error>(
    effect: Effect.Effect<T, E>,
    expectedErrorType: new (...args: unknown[]) => E,
  ): Effect.Effect<void, Error> =>
    pipe(
      effect,
      Effect.map(() => {
        throw new Error('Effect should fail but succeeded');
      }),
      Effect.catchAll((error) => {
        if (!(error instanceof expectedErrorType)) {
          const errorName =
            error && typeof error === 'object' && error.constructor ? error.constructor.name : String(error);
          throw new Error(`Expected error of type ${expectedErrorType.name}, got ${errorName}`);
        }
        return Effect.succeed(undefined);
      }),
    );

  /**
   * Assert that an Effect completes within the specified duration
   */
  static completesWithin = <T, E>(
    effect: Effect.Effect<T, E>,
    duration: Duration.Duration,
  ): Effect.Effect<T, E | Error> =>
    pipe(
      effect,
      Effect.timeout(duration),
      Effect.mapError((error) =>
        error instanceof Error && error.message.includes('timeout')
          ? new Error(`Effect should complete within ${Duration.toMillis(duration)}ms`)
          : error,
      ),
    );

  /**
   * Assert that two Effects produce the same result
   */
  static equivalent = <T, E>(effect1: Effect.Effect<T, E>, effect2: Effect.Effect<T, E>): Effect.Effect<void, Error> =>
    pipe(
      Effect.all([effect1, effect2]),
      Effect.map(([result1, result2]) => {
        if (JSON.stringify(result1) !== JSON.stringify(result2)) {
          throw new Error(`Effects should be equivalent: ${JSON.stringify(result1)} vs ${JSON.stringify(result2)}`);
        }
      }),
      Effect.catchAll((error) => Effect.fail(new Error(`Effects should both succeed: ${error}`))),
    );

  /**
   * Assert that an Effect is idempotent (same result when run multiple times)
   */
  static idempotent = <T, E>(effect: Effect.Effect<T, E>, iterations: number = 3): Effect.Effect<void, Error> =>
    pipe(
      Effect.all(
        Array(iterations)
          .fill(0)
          .map(() => effect),
      ),
      Effect.map((results) => {
        const first = JSON.stringify(results[0]);
        for (let i = 1; i < results.length; i++) {
          if (JSON.stringify(results[i]) !== first) {
            throw new Error(`Effect should be idempotent but result ${i} differs`);
          }
        }
      }),
      Effect.catchAll(() => Effect.fail(new Error(`Idempotency test failed`))),
    );
}

/**
 * Mock implementations for testing
 */
export class TestMocks {
  /**
   * Create a mock logging service
   */
  static createMockLogger(): LoggingService {
    const logs: Array<{ level: string; message: string; metadata?: Record<string, unknown>; error?: Error }> = [];

    const createLogFunction =
      (level: string) =>
      (message: string, metadataOrError?: Record<string, unknown> | Error, metadata?: Record<string, unknown>) =>
        Effect.sync(() => {
          logs.push({
            level,
            message,
            metadata:
              metadata || (metadataOrError && !(metadataOrError instanceof Error) ? metadataOrError : undefined),
            error: metadataOrError instanceof Error ? metadataOrError : undefined,
          });
        });

    return {
      trace: createLogFunction('trace'),
      debug: createLogFunction('debug'),
      info: createLogFunction('info'),
      warn: createLogFunction('warn'),
      error: createLogFunction('error'),
      fatal: createLogFunction('fatal'),
      withModule: (_module: string) => TestMocks.createMockLogger(),
      withContext: (_context: Record<string, unknown>) => TestMocks.createMockLogger(),
      setLevel: () => Effect.succeed(undefined),
      flush: () => Effect.succeed(undefined),
      getLogs: () => logs,
    } as LoggingService & {
      getLogs: () => Array<{ level: string; message: string; metadata?: Record<string, unknown>; error?: Error }>;
    };
  }

  /**
   * Create a mock configuration service
   */
  static createMockConfig(config: Partial<AppConfig> = {}): ConfigurationService {
    const mockConfig: AppConfig = {
      app: { name: 'test', version: '1.0.0', environment: 'test', debug: true },
      jira: {
        baseUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        maxResults: 50,
        timeout: 30000,
        retries: 3,
      },
      confluence: { baseUrl: 'https://test.atlassian.net/wiki', timeout: 30000, retries: 3, maxPages: 1000 },
      search: { provider: 'sqlite', enableSemanticSearch: false, maxResults: 20, cacheTimeout: 300000 },
      database: { path: ':memory:', maxConnections: 1, timeout: 5000, enableWAL: false, enableForeignKeys: true },
      cache: { enabled: true, maxSize: 1000, ttl: 300000, persistToDisk: false, compressionEnabled: false },
      logging: {
        level: 'debug',
        enableConsole: false,
        enableFile: false,
        enableStructured: false,
        maxFileSize: 1024,
        maxFiles: 1,
        enableColors: false,
        includeStackTrace: false,
      },
      jobs: { enabled: false, workers: 1, syncInterval: 300000, maxRetries: 1, retryDelay: 1000 },
      ollama: { enabled: false, baseUrl: 'http://localhost:11434', model: 'test', timeout: 5000 },
      features: {
        backgroundSync: false,
        aiAssistant: false,
        searchAnalytics: false,
        cacheWarming: false,
        performanceMetrics: false,
      },
      ...config,
    };

    return {
      get: (key) => Effect.succeed(mockConfig[key]),
      getPath: <T>(path: string) => {
        const keys = path.split('.');
        let current: unknown = mockConfig;
        for (const key of keys) {
          if (current && typeof current === 'object' && key in current) {
            current = (current as Record<string, unknown>)[key];
          } else {
            current = undefined;
            break;
          }
        }
        return Effect.succeed(current as T);
      },
      set: (key, value) =>
        Effect.sync(() => {
          mockConfig[key] = value;
        }),
      setPath: (_path, _value) => Effect.succeed(undefined),
      reload: () => Effect.succeed(mockConfig),
      validate: () => Effect.succeed(undefined),
      watch: () => Effect.succeed(undefined),
      getEnvironment: () => Effect.succeed('test'),
      isDevelopment: () => Effect.succeed(false),
      isProduction: () => Effect.succeed(false),
      export: () => Effect.succeed(JSON.stringify(mockConfig, null, 2)),
    };
  }

  /**
   * Create a mock cache service
   */
  static createMockCache(): CacheService {
    const cache = new Map<string, unknown>();

    return {
      get: <T>(key: string) => Effect.succeed(cache.has(key) ? Option.some(cache.get(key) as T) : Option.none<T>()),
      set: (key, value) =>
        Effect.sync(() => {
          cache.set(key, value);
        }),
      delete: (key) => Effect.sync(() => cache.delete(key)),
      clear: () =>
        Effect.sync(() => {
          cache.clear();
        }),
      invalidateByTag: () => Effect.succeed(0),
      getStats: () =>
        Effect.succeed({
          hits: 0,
          misses: 0,
          evictions: 0,
          size: cache.size,
          maxSize: 1000,
          hitRate: 0,
          memoryUsage: 0,
        }),
      getOrCompute: <T, E>(key: string, compute: Effect.Effect<T, E>) =>
        pipe(
          Effect.succeed(cache.has(key)),
          Effect.flatMap((exists) =>
            exists
              ? Effect.succeed(cache.get(key) as T)
              : pipe(
                  compute,
                  Effect.tap((value) => Effect.sync(() => cache.set(key, value))),
                ),
          ),
        ),
      warmUp: () => Effect.succeed(undefined),
      refresh: <T, E>(key: string, compute: Effect.Effect<T, E>) =>
        pipe(
          compute,
          Effect.tap((value) => Effect.sync(() => cache.set(key, value))),
        ),
    };
  }

  /**
   * Create a mock database
   */
  static createMockDatabase() {
    const tables = new Map<string, unknown[]>();

    return {
      prepare: (_sql: string) => ({
        run: (..._params: unknown[]) => ({ changes: 1, lastInsertRowid: 1 }),
        get: (..._params: unknown[]) => null,
        all: (..._params: unknown[]) => [],
      }),
      exec: (_sql: string) => undefined,
      close: () => undefined,
      transaction: (fn: () => unknown) => fn(),
      getTables: () => Array.from(tables.keys()),
      getTable: (name: string) => tables.get(name) || [],
      setTable: (name: string, data: unknown[]) => tables.set(name, data),
    };
  }
}

/**
 * Property-based testing generators
 */
export class PropertyGenerators {
  /**
   * Generate random strings
   */
  static string(minLength: number = 0, maxLength: number = 100): PropertyGenerator<string> {
    return {
      name: 'string',
      generate: () =>
        Effect.sync(() => {
          const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;
          return Array(length)
            .fill(0)
            .map(() => String.fromCharCode(Math.floor(Math.random() * 94) + 33))
            .join('');
        }),
      shrink: (value) =>
        Effect.sync(() => {
          if (value.length <= 1) return [];
          return [
            value.slice(0, Math.floor(value.length / 2)),
            value.slice(Math.floor(value.length / 2)),
            value.slice(1),
            value.slice(0, -1),
          ];
        }),
    };
  }

  /**
   * Generate random integers
   */
  static integer(min: number = 0, max: number = 1000): PropertyGenerator<number> {
    return {
      name: 'integer',
      generate: () => Effect.sync(() => Math.floor(Math.random() * (max - min + 1)) + min),
      shrink: (value) =>
        Effect.sync(() => {
          if (value === 0) return [];
          const candidates = [0, Math.floor(value / 2)];
          if (value > 0) candidates.push(value - 1);
          if (value < 0) candidates.push(value + 1);
          return candidates.filter((n) => n !== value);
        }),
    };
  }

  /**
   * Generate arrays of values
   */
  static array<T>(elementGenerator: PropertyGenerator<T>, maxLength: number = 10): PropertyGenerator<T[]> {
    return {
      name: `array<${elementGenerator.name}>`,
      generate: () =>
        pipe(
          Effect.sync(() => Math.floor(Math.random() * (maxLength + 1))),
          Effect.flatMap((length) =>
            Effect.all(
              Array(length)
                .fill(0)
                .map(() => elementGenerator.generate()),
            ),
          ),
        ),
      shrink: (value) =>
        Effect.sync(() => {
          if (value.length === 0) return [];
          return [
            [],
            value.slice(0, Math.floor(value.length / 2)),
            value.slice(Math.floor(value.length / 2)),
            value.slice(1),
            value.slice(0, -1),
          ];
        }),
    };
  }

  /**
   * Generate objects with specific shape
   */
  static object<T extends Record<string, unknown>>(
    _schema: { [K in keyof T]: PropertyGenerator<T[K]> },
  ): PropertyGenerator<T> {
    return {
      name: `object<${Object.keys(_schema).join(',')}>`,
      generate: () => pipe(Effect.succeed({} as T)),
      shrink: () => Effect.succeed([] as T[]),
    };
  }
}

/**
 * Test fixture manager
 */
export class TestFixtureManager {
  private fixtures = new Map<string, TestFixture<unknown>>();
  private activeResources = new Map<string, unknown>();

  /**
   * Register a test fixture
   */
  register<T>(fixture: TestFixture<T>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.fixtures.set(fixture.name, fixture as TestFixture<unknown>);
    });
  }

  /**
   * Set up a fixture for use in tests
   */
  setup<T>(name: string): Effect.Effect<T, Error> {
    return pipe(
      Effect.sync(() => {
        const fixture = this.fixtures.get(name);
        if (!fixture) {
          throw new Error(`Fixture not found: ${name}`);
        }
        return fixture;
      }),
      Effect.flatMap((fixture) =>
        pipe(
          (fixture as TestFixture<T>).setup(),
          Effect.tap((resource) =>
            Effect.sync(() => {
              this.activeResources.set(name, resource);
            }),
          ),
        ),
      ),
    );
  }

  /**
   * Tear down a specific fixture
   */
  teardown(name: string): Effect.Effect<void, Error> {
    return pipe(
      Effect.sync(() => {
        const fixture = this.fixtures.get(name);
        const resource = this.activeResources.get(name);
        if (!fixture || !resource) {
          return null;
        }
        return { fixture, resource };
      }),
      Effect.flatMap((data) =>
        data
          ? pipe(
              data.fixture.teardown(data.resource),
              Effect.tap(() =>
                Effect.sync(() => {
                  this.activeResources.delete(name);
                }),
              ),
            )
          : Effect.succeed(undefined),
      ),
    );
  }

  /**
   * Tear down all active fixtures
   */
  teardownAll(): Effect.Effect<void, Error> {
    return pipe(
      Effect.all(
        Array.from(this.activeResources.keys()).map((name) =>
          this.teardown(name).pipe(
            Effect.catchAll((error) => {
              console.error(`Failed to teardown fixture ${name}:`, error);
              return Effect.succeed(undefined);
            }),
          ),
        ),
      ),
      Effect.map(() => undefined),
    );
  }

  /**
   * Get an active fixture resource
   */
  get<T>(name: string): Effect.Effect<T, Error> {
    return Effect.sync(() => {
      const resource = this.activeResources.get(name);
      if (!resource) {
        throw new Error(`Active fixture not found: ${name}`);
      }
      return resource as T;
    });
  }
}

/**
 * Performance testing utilities
 */
export class PerformanceTestUtils {
  /**
   * Benchmark an Effect operation
   */
  static benchmark<T, E>(
    operation: Effect.Effect<T, E>,
    iterations: number = 100,
  ): Effect.Effect<
    {
      averageMs: number;
      minMs: number;
      maxMs: number;
      totalMs: number;
      successCount: number;
      errorCount: number;
    },
    never
  > {
    return pipe(
      Effect.all(
        Array(iterations)
          .fill(0)
          .map(() =>
            pipe(
              Effect.sync(() => Date.now()),
              Effect.flatMap((startTime) =>
                pipe(
                  operation,
                  Effect.map((result) => ({
                    duration: Date.now() - startTime,
                    success: true,
                    result,
                  })),
                  Effect.catchAll((error) =>
                    Effect.succeed({
                      duration: Date.now() - startTime,
                      success: false,
                      error,
                    }),
                  ),
                ),
              ),
            ),
          ),
      ),
      Effect.map((results) => {
        const durations = results.map((r) => r.duration);
        const successCount = results.filter((r) => r.success).length;

        return {
          averageMs: durations.reduce((a, b) => a + b, 0) / durations.length,
          minMs: Math.min(...durations),
          maxMs: Math.max(...durations),
          totalMs: durations.reduce((a, b) => a + b, 0),
          successCount,
          errorCount: results.length - successCount,
        };
      }),
    );
  }

  /**
   * Test memory usage of an operation
   */
  static memoryUsage<T, E>(
    operation: Effect.Effect<T, E>,
  ): Effect.Effect<
    {
      beforeMB: number;
      afterMB: number;
      deltaMB: number;
      result: T;
    },
    E
  > {
    return pipe(
      Effect.sync(() => {
        if (typeof process !== 'undefined' && process.memoryUsage) {
          return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        }
        return 0;
      }),
      Effect.flatMap((beforeMB) =>
        pipe(
          operation,
          Effect.map((result) => {
            const afterMB =
              typeof process !== 'undefined' && process.memoryUsage
                ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
                : 0;

            return {
              beforeMB,
              afterMB,
              deltaMB: afterMB - beforeMB,
              result,
            };
          }),
        ),
      ),
    );
  }

  /**
   * Test operation under load
   */
  static loadTest<T, E>(
    _operation: Effect.Effect<T, E>,
    _concurrency: number = 10,
    _duration: Duration.Duration = Duration.seconds(10),
  ): Effect.Effect<
    {
      totalOperations: number;
      successfulOperations: number;
      failedOperations: number;
      operationsPerSecond: number;
      averageLatencyMs: number;
    },
    never
  > {
    return Effect.succeed({
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 0,
      operationsPerSecond: 0,
      averageLatencyMs: 0,
    });
  }
}

/**
 * Test environment setup
 */
export class TestEnvironment {
  constructor(
    private config: TestConfig,
    private fixtures: TestFixtureManager,
    private logger: LoggingService,
  ) {}

  /**
   * Run a test with full environment setup
   */
  runTest<T>(
    testName: string,
    test: Effect.Effect<T, Error>,
    requiredFixtures: string[] = [],
  ): Effect.Effect<T, Error> {
    return pipe(
      this.logger.info(`Starting test: ${testName}`),
      Effect.flatMap(() => this.setupFixtures(requiredFixtures)),
      Effect.flatMap(() => test),
      Effect.tap((_result) => this.logger.info(`Test completed: ${testName}`)),
      Effect.tapError((error) => this.logger.error(`Test failed: ${testName}`, error)),
      Effect.ensuring(
        this.config.cleanup
          ? pipe(
              this.fixtures.teardownAll(),
              Effect.catchAll(() => Effect.succeed(undefined)),
            )
          : Effect.succeed(undefined),
      ),
    );
  }

  /**
   * Run property-based test
   */
  runPropertyTest<T>(
    testName: string,
    generator: PropertyGenerator<T>,
    property: (value: T) => Effect.Effect<boolean, Error>,
    iterations: number = 100,
  ): Effect.Effect<void, Error> {
    return pipe(
      this.logger.info(`Starting property test: ${testName} (${iterations} iterations)`),
      Effect.flatMap(() => this.runPropertyTestIterations(generator, property, iterations, 0)),
      Effect.tap(() => this.logger.info(`Property test passed: ${testName}`)),
    );
  }

  private runPropertyTestIterations<T>(
    generator: PropertyGenerator<T>,
    property: (value: T) => Effect.Effect<boolean, Error>,
    remaining: number,
    iteration: number,
  ): Effect.Effect<void, Error> {
    if (remaining <= 0) {
      return Effect.succeed(undefined);
    }

    return pipe(
      generator.generate(),
      Effect.flatMap((value) =>
        pipe(
          property(value),
          Effect.flatMap((passed) => {
            if (!passed) {
              return this.shrinkAndFail(generator, property, value, iteration);
            }
            return this.runPropertyTestIterations(generator, property, remaining - 1, iteration + 1);
          }),
        ),
      ),
    );
  }

  private shrinkAndFail<T>(
    generator: PropertyGenerator<T>,
    property: (value: T) => Effect.Effect<boolean, Error>,
    failingValue: T,
    iteration: number,
  ): Effect.Effect<void, Error> {
    return pipe(
      generator.shrink(failingValue),
      Effect.flatMap((shrunkValues) => {
        // Find the smallest failing value
        const findSmallestFailure = (values: T[], index: number): Effect.Effect<T, Error> => {
          if (index >= values.length) {
            return Effect.succeed(failingValue);
          }

          return pipe(
            property(values[index]),
            Effect.flatMap((passed) =>
              passed ? findSmallestFailure(values, index + 1) : Effect.succeed(values[index]),
            ),
            Effect.catchAll(() => Effect.succeed(values[index])),
          );
        };

        return pipe(
          findSmallestFailure(shrunkValues, 0),
          Effect.flatMap((smallestFailure) =>
            Effect.fail(
              new Error(
                `Property test failed at iteration ${iteration} with value: ${JSON.stringify(smallestFailure)}`,
              ),
            ),
          ),
        );
      }),
    );
  }

  private setupFixtures(requiredFixtures: string[]): Effect.Effect<void, Error> {
    return pipe(
      Effect.all(requiredFixtures.map((name) => this.fixtures.setup(name))),
      Effect.map(() => undefined),
    );
  }
}

/**
 * Test utilities for creating common test scenarios
 */
export const TestUtils = {
  /**
   * Create a failing Effect for testing error handling
   */
  createFailingEffect: <E>(error: E): Effect.Effect<never, E> => Effect.fail(error),

  /**
   * Create a slow Effect for testing timeouts
   */
  createSlowEffect: <T>(value: T, delay: Duration.Duration): Effect.Effect<T, never> =>
    pipe(
      Effect.sleep(delay),
      Effect.map(() => value),
    ),

  /**
   * Create an Effect that fails randomly
   */
  createFlakeyEffect: <T, E>(value: T, error: E, failureRate: number = 0.5): Effect.Effect<T, E> =>
    pipe(
      Effect.sync(() => Math.random() < failureRate),
      Effect.flatMap((shouldFail) => (shouldFail ? Effect.fail(error) : Effect.succeed(value))),
    ),

  /**
   * Create test data generators
   */
  generators: PropertyGenerators,

  /**
   * Create test assertions
   */
  assertions: EffectTestAssertions,

  /**
   * Create mock services
   */
  mocks: TestMocks,
};
