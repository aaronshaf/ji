import { Context, type Duration, Effect, Layer, pipe, Runtime } from 'effect';
import { createJobQueueService, type JobQueueService } from './background-jobs.js';
import { type CacheService, createCacheService } from './caching-layer.js';
import { type ConfigurationService, createConfigurationService } from './configuration.js';
import { ConfigError, type DatabaseError } from './errors.js';
import { AuditLogger, createLogger, type LoggingService, PerformanceLogger } from './logging.js';
import { createStreamingSearchService, type StreamingSearchService } from './search-enhancement.js';

/**
 * Application infrastructure context that provides all core services
 */
export interface AppInfrastructure {
  logger: LoggingService;
  config: ConfigurationService;
  cache: CacheService;
  jobQueue: JobQueueService;
  search: StreamingSearchService;
  performanceLogger: PerformanceLogger;
  auditLogger: AuditLogger;
}

/**
 * Infrastructure initialization options
 */
export interface InfrastructureOptions {
  configPath?: string;
  enableJobs?: boolean;
  enableSearch?: boolean;
  enableCache?: boolean;
  logLevel?: string;
  environment?: 'development' | 'production' | 'test';
}

/**
 * Main infrastructure service that orchestrates all other services
 */
export class InfrastructureManager {
  private runtime?: Runtime.Runtime<AppInfrastructure>;
  private infrastructure?: AppInfrastructure;

  /**
   * Initialize the complete infrastructure stack
   */
  initialize(options: InfrastructureOptions = {}): Effect.Effect<AppInfrastructure, ConfigError | DatabaseError> {
    return pipe(
      Effect.gen(function* () {
        // Initialize configuration first as other services depend on it
        const config = yield* createConfigurationService(options.configPath);

        // Apply environment overrides
        if (options.environment) {
          yield* config.set('app', {
            ...(yield* config.get('app')),
            environment: options.environment,
          });
        }

        if (options.logLevel) {
          yield* config.setPath('logging.level', options.logLevel);
        }

        // Initialize logging with configuration
        const logConfig = yield* config.get('logging');
        const logger = yield* createLogger(logConfig);

        yield* logger.info('Initializing ji infrastructure', {
          environment: options.environment || 'default',
          configPath: options.configPath,
          options,
        });

        // Initialize cache service
        let cache: CacheService | undefined;
        if (options.enableCache !== false) {
          try {
            cache = yield* createCacheService();
            yield* logger.info('Cache service initialized');
          } catch (error) {
            yield* logger.warn('Failed to initialize cache service, continuing without cache', { error });
          }
        }

        // Initialize job queue service
        let jobQueue: JobQueueService | undefined;
        if (options.enableJobs !== false) {
          try {
            jobQueue = yield* createJobQueueService();
            yield* logger.info('Job queue service initialized');
          } catch (error) {
            yield* logger.warn('Failed to initialize job queue service, continuing without background jobs', { error });
          }
        }

        // Initialize search service
        let search: StreamingSearchService | undefined;
        if (options.enableSearch !== false && cache) {
          try {
            search = yield* createStreamingSearchService();
            yield* logger.info('Search service initialized');
          } catch (error) {
            yield* logger.warn('Failed to initialize search service, continuing without enhanced search', { error });
          }
        }

        // Create specialized loggers
        const performanceLogger = new PerformanceLogger(logger);
        const auditLogger = new AuditLogger(logger);

        if (!cache || !jobQueue || !search) {
          throw new Error('Failed to initialize infrastructure services');
        }

        const infrastructure: AppInfrastructure = {
          logger,
          config,
          cache,
          jobQueue,
          search,
          performanceLogger,
          auditLogger,
        };

        yield* logger.info('Infrastructure initialization complete', {
          services: {
            config: true,
            logging: true,
            cache: !!cache,
            jobQueue: !!jobQueue,
            search: !!search,
          },
        });

        return infrastructure;
      }),
      Effect.tap((infrastructure) => {
        this.infrastructure = infrastructure;
        return Effect.succeed(undefined);
      }),
    );
  }

  /**
   * Get the initialized infrastructure
   */
  getInfrastructure(): Effect.Effect<AppInfrastructure, ConfigError> {
    return Effect.sync(() => {
      if (!this.infrastructure) {
        throw new ConfigError('Infrastructure not initialized', 'initialization');
      }
      return this.infrastructure;
    });
  }

  /**
   * Create a runtime with the infrastructure
   */
  createRuntime(): Effect.Effect<Runtime.Runtime<AppInfrastructure>, ConfigError> {
    return pipe(
      this.getInfrastructure(),
      Effect.map((infrastructure) => {
        if (!this.runtime) {
          // Create a simple runtime with the infrastructure context
          this.createInfrastructureLayer(infrastructure);
          this.runtime = Runtime.defaultRuntime as Runtime.Runtime<AppInfrastructure>;
        }
        return this.runtime;
      }),
    );
  }

  /**
   * Gracefully shutdown all infrastructure services
   */
  shutdown(): Effect.Effect<void, never, never> {
    if (!this.infrastructure) {
      return Effect.succeed(undefined);
    }

    const infra = this.infrastructure;

    return pipe(
      infra.logger.info('Shutting down infrastructure'),
      Effect.flatMap(() =>
        Effect.all([
          // Flush logs
          infra.logger.flush(),

          // Clear cache if needed
          infra.cache
            ? pipe(
                infra.cache.getStats(),
                Effect.flatMap((stats) =>
                  infra.logger.info('Cache stats at shutdown', {
                    hits: stats.hits,
                    misses: stats.misses,
                    hitRate: stats.hitRate,
                    size: stats.size,
                  }),
                ),
                Effect.catchAll(() => Effect.succeed(undefined)),
              )
            : Effect.succeed(undefined),

          // Stop any background jobs
          // Job queue doesn't have explicit shutdown in our implementation
          Effect.succeed(undefined),
        ]),
      ),
      Effect.map(() => undefined),
      Effect.tap(() => {
        this.infrastructure = undefined;
        this.runtime = undefined;
        return Effect.succeed(undefined);
      }),
      Effect.catchAll((error) => {
        console.error('Error during infrastructure shutdown:', error);
        return Effect.succeed(undefined);
      }),
    );
  }

  /**
   * Health check for all infrastructure services
   */
  healthCheck(): Effect.Effect<
    {
      status: 'healthy' | 'degraded' | 'unhealthy';
      services: Record<string, { status: 'up' | 'down'; error?: string }>;
      timestamp: number;
    },
    never
  > {
    if (!this.infrastructure) {
      return Effect.succeed({
        status: 'unhealthy',
        services: {},
        timestamp: Date.now(),
      });
    }

    return pipe(
      Effect.all({
        config: this.checkConfigHealth(),
        cache: this.checkCacheHealth(),
        jobQueue: this.checkJobQueueHealth(),
        search: this.checkSearchHealth(),
      }),
      Effect.map((serviceResults) => {
        const services = {
          config: serviceResults.config,
          cache: serviceResults.cache,
          jobQueue: serviceResults.jobQueue,
          search: serviceResults.search,
        };

        const unhealthyCount = Object.values(services).filter((s) => s.status === 'down').length;
        const status: 'healthy' | 'degraded' | 'unhealthy' =
          unhealthyCount === 0 ? 'healthy' : unhealthyCount < Object.keys(services).length ? 'degraded' : 'unhealthy';

        return {
          status,
          services,
          timestamp: Date.now(),
        };
      }),
      Effect.catchAll(() =>
        Effect.succeed({
          status: 'unhealthy' as const,
          services: {},
          timestamp: Date.now(),
        }),
      ),
    );
  }

  /**
   * Get infrastructure metrics
   */
  getMetrics(): Effect.Effect<
    {
      uptime: number;
      memory: {
        heapUsed: number;
        heapTotal: number;
        external: number;
        rss: number;
      } | null;
      cache?: {
        hits: number;
        misses: number;
        hitRate: number;
        size: number;
      };
      timestamp: number;
    },
    never
  > {
    return pipe(
      Effect.sync(() => {
        const memory =
          typeof process !== 'undefined' && process.memoryUsage
            ? (() => {
                const mem = process.memoryUsage();
                return {
                  heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                  heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
                  external: Math.round(mem.external / 1024 / 1024),
                  rss: Math.round(mem.rss / 1024 / 1024),
                };
              })()
            : null;

        return {
          uptime: typeof process !== 'undefined' ? process.uptime() * 1000 : 0,
          memory,
          timestamp: Date.now(),
        };
      }),
      Effect.flatMap((basicMetrics) => {
        if (!this.infrastructure?.cache) {
          return Effect.succeed(basicMetrics);
        }

        return pipe(
          this.infrastructure.cache.getStats(),
          Effect.map((cacheStats) => ({
            ...basicMetrics,
            cache: {
              hits: cacheStats.hits,
              misses: cacheStats.misses,
              hitRate: cacheStats.hitRate,
              size: cacheStats.size,
            },
          })),
          Effect.catchAll(() => Effect.succeed(basicMetrics)),
        );
      }),
    );
  }

  private createInfrastructureLayer(infrastructure: AppInfrastructure): Layer.Layer<AppInfrastructure> {
    return Layer.succeed(InfrastructureContext, infrastructure);
  }

  private checkConfigHealth(): Effect.Effect<{ status: 'up' | 'down'; error?: string }, never> {
    if (!this.infrastructure?.config) {
      return Effect.succeed({ status: 'down', error: 'Config service not available' });
    }

    return pipe(
      this.infrastructure.config.validate(),
      Effect.map(() => ({ status: 'up' as const })),
      Effect.catchAll((error) =>
        Effect.succeed({
          status: 'down' as const,
          error: error.message,
        }),
      ),
    );
  }

  private checkCacheHealth(): Effect.Effect<{ status: 'up' | 'down'; error?: string }, never> {
    if (!this.infrastructure?.cache) {
      return Effect.succeed({ status: 'down', error: 'Cache service not available' });
    }

    return pipe(
      this.infrastructure.cache.getStats(),
      Effect.map(() => ({ status: 'up' as const })),
      Effect.catchAll((error) =>
        Effect.succeed({
          status: 'down' as const,
          error:
            typeof error === 'object' && error !== null && 'message' in error
              ? (error as Error).message
              : String(error),
        }),
      ),
    );
  }

  private checkJobQueueHealth(): Effect.Effect<{ status: 'up' | 'down'; error?: string }, never> {
    if (!this.infrastructure?.jobQueue) {
      return Effect.succeed({ status: 'down', error: 'Job queue service not available' });
    }

    return pipe(
      this.infrastructure.jobQueue.getStats(),
      Effect.map(() => ({ status: 'up' as const })),
      Effect.catchAll((error) =>
        Effect.succeed({
          status: 'down' as const,
          error:
            typeof error === 'object' && error !== null && 'message' in error
              ? (error as Error).message
              : String(error),
        }),
      ),
    );
  }

  private checkSearchHealth(): Effect.Effect<{ status: 'up' | 'down'; error?: string }, never> {
    if (!this.infrastructure?.search) {
      return Effect.succeed({ status: 'down', error: 'Search service not available' });
    }

    // For search health, we can try a simple query
    return pipe(
      this.infrastructure.search.searchWithFacets({
        query: 'test',
        limit: 1,
      }),
      Effect.map(() => ({ status: 'up' as const })),
      Effect.catchAll((error) =>
        Effect.succeed({
          status: 'down' as const,
          error:
            typeof error === 'object' && error !== null && 'message' in error
              ? (error as Error).message
              : String(error),
        }),
      ),
    );
  }
}

/**
 * Infrastructure context for dependency injection
 */
export const InfrastructureContext = Context.GenericTag<AppInfrastructure>('AppInfrastructure');

/**
 * Global infrastructure instance
 */
let globalInfrastructure: InfrastructureManager | undefined;

/**
 * Initialize global infrastructure
 */
export function initializeGlobalInfrastructure(
  options: InfrastructureOptions = {},
): Effect.Effect<AppInfrastructure, ConfigError | DatabaseError> {
  if (!globalInfrastructure) {
    globalInfrastructure = new InfrastructureManager();
  }

  return globalInfrastructure.initialize(options);
}

/**
 * Get global infrastructure instance
 */
export function getGlobalInfrastructure(): Effect.Effect<AppInfrastructure, ConfigError> {
  if (!globalInfrastructure) {
    return Effect.fail(new ConfigError('Global infrastructure not initialized', 'global'));
  }

  return globalInfrastructure.getInfrastructure();
}

/**
 * Shutdown global infrastructure
 */
export function shutdownGlobalInfrastructure(): Effect.Effect<void, never> {
  if (!globalInfrastructure) {
    return Effect.succeed(undefined);
  }

  return pipe(
    globalInfrastructure.shutdown(),
    Effect.tap(() =>
      Effect.sync(() => {
        globalInfrastructure = undefined;
      }),
    ),
  );
}

/**
 * Create a development environment with sensible defaults
 */
export function createDevelopmentEnvironment(): Effect.Effect<AppInfrastructure, ConfigError | DatabaseError> {
  return initializeGlobalInfrastructure({
    environment: 'development',
    logLevel: 'debug',
    enableJobs: true,
    enableSearch: true,
    enableCache: true,
  });
}

/**
 * Create a production environment with optimized settings
 */
export function createProductionEnvironment(): Effect.Effect<AppInfrastructure, ConfigError | DatabaseError> {
  return initializeGlobalInfrastructure({
    environment: 'production',
    logLevel: 'info',
    enableJobs: true,
    enableSearch: true,
    enableCache: true,
  });
}

/**
 * Create a test environment with minimal services
 */
export function createTestEnvironment(): Effect.Effect<AppInfrastructure, ConfigError | DatabaseError> {
  return initializeGlobalInfrastructure({
    environment: 'test',
    logLevel: 'warn',
    enableJobs: false,
    enableSearch: false,
    enableCache: false,
  });
}

/**
 * Infrastructure utilities for common operations
 */
export const InfrastructureUtils = {
  /**
   * Run an Effect with the global infrastructure context
   */
  runWithInfrastructure: <T, E>(effect: Effect.Effect<T, E, AppInfrastructure>): Effect.Effect<T, E | ConfigError> =>
    pipe(
      getGlobalInfrastructure(),
      Effect.flatMap((infrastructure) => pipe(effect, Effect.provideService(InfrastructureContext, infrastructure))),
    ),

  /**
   * Access a specific service from the infrastructure
   */
  useService: <T>(selector: (infrastructure: AppInfrastructure) => T): Effect.Effect<T, ConfigError> =>
    pipe(getGlobalInfrastructure(), Effect.map(selector)),

  /**
   * Log with the infrastructure logger
   */
  log: {
    info: (message: string, metadata?: Record<string, unknown>) =>
      pipe(
        InfrastructureUtils.useService((infra) => infra.logger),
        Effect.flatMap((logger) => logger.info(message, metadata)),
      ),

    error: (message: string, error?: Error, metadata?: Record<string, unknown>) =>
      pipe(
        InfrastructureUtils.useService((infra) => infra.logger),
        Effect.flatMap((logger) => logger.error(message, error, metadata)),
      ),

    warn: (message: string, metadata?: Record<string, unknown>) =>
      pipe(
        InfrastructureUtils.useService((infra) => infra.logger),
        Effect.flatMap((logger) => logger.warn(message, metadata)),
      ),

    debug: (message: string, metadata?: Record<string, unknown>) =>
      pipe(
        InfrastructureUtils.useService((infra) => infra.logger),
        Effect.flatMap((logger) => logger.debug(message, metadata)),
      ),
  },

  /**
   * Access configuration
   */
  getConfig: <K extends keyof import('./configuration.js').AppConfig>(key: K) =>
    pipe(
      InfrastructureUtils.useService((infra) => infra.config),
      Effect.flatMap((config) => config.get(key)),
    ),

  /**
   * Cache operations
   */
  cache: {
    get: <T>(key: string) =>
      pipe(
        InfrastructureUtils.useService((infra) => infra.cache),
        Effect.flatMap((cache) => cache.get<T>(key)),
      ),

    set: <T>(key: string, value: T, ttl?: Duration.Duration) =>
      pipe(
        InfrastructureUtils.useService((infra) => infra.cache),
        Effect.flatMap((cache) => cache.set(key, value, ttl)),
      ),
  },

  /**
   * Performance monitoring
   */
  timeOperation: <T, E>(operationName: string, operation: Effect.Effect<T, E>) =>
    pipe(
      InfrastructureUtils.useService((infra) => infra.performanceLogger),
      Effect.flatMap((perfLogger) => perfLogger.timeOperation(operationName, operation)),
    ),
};
