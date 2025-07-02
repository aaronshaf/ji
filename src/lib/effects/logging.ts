import type { Database } from 'bun:sqlite';
import { Context, Duration, Effect, Layer, pipe, Schedule } from 'effect';
import { ConfigError, type ValidationError } from './errors.js';

/**
 * Custom log levels for ji CLI
 */
export type JiLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: number;
  level: JiLogLevel;
  message: string;
  module: string;
  metadata?: Record<string, unknown>;
  error?: Error;
  userId?: string;
  sessionId?: string;
}

/**
 * Log configuration
 */
export interface LogConfig {
  level: JiLogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  enableStructured: boolean;
  filePath?: string;
  maxFileSize: number;
  maxFiles: number;
  enableColors: boolean;
  includeStackTrace: boolean;
}

/**
 * Logging service interface
 */
export interface LoggingService {
  trace: (message: string, metadata?: Record<string, unknown>) => Effect.Effect<void, never>;
  debug: (message: string, metadata?: Record<string, unknown>) => Effect.Effect<void, never>;
  info: (message: string, metadata?: Record<string, unknown>) => Effect.Effect<void, never>;
  warn: (message: string, metadata?: Record<string, unknown>) => Effect.Effect<void, never>;
  error: (message: string, error?: Error, metadata?: Record<string, unknown>) => Effect.Effect<void, never>;
  fatal: (message: string, error?: Error, metadata?: Record<string, unknown>) => Effect.Effect<void, never>;
  withModule: (module: string) => LoggingService;
  withContext: (context: Record<string, unknown>) => LoggingService;
  setLevel: (level: JiLogLevel) => Effect.Effect<void, never>;
  flush: () => Effect.Effect<void, never>;
}

/**
 * Enhanced logging implementation with structured output
 */
export class StructuredLogger implements LoggingService {
  private buffer: LogEntry[] = [];
  private flushSchedule = Schedule.fixed(Duration.seconds(5));

  constructor(
    private config: LogConfig,
    private module: string = 'default',
    private context: Record<string, unknown> = {},
    private db?: Database,
  ) {
    // Start background flush
    this.startBackgroundFlush();
  }

  trace(message: string, metadata: Record<string, unknown> = {}): Effect.Effect<void, never> {
    return this.log('trace', message, undefined, metadata);
  }

  debug(message: string, metadata: Record<string, unknown> = {}): Effect.Effect<void, never> {
    return this.log('debug', message, undefined, metadata);
  }

  info(message: string, metadata: Record<string, unknown> = {}): Effect.Effect<void, never> {
    return this.log('info', message, undefined, metadata);
  }

  warn(message: string, metadata: Record<string, unknown> = {}): Effect.Effect<void, never> {
    return this.log('warn', message, undefined, metadata);
  }

  error(message: string, error?: Error, metadata: Record<string, unknown> = {}): Effect.Effect<void, never> {
    return this.log('error', message, error, metadata);
  }

  fatal(message: string, error?: Error, metadata: Record<string, unknown> = {}): Effect.Effect<void, never> {
    return this.log('fatal', message, error, metadata);
  }

  withModule(module: string): LoggingService {
    return new StructuredLogger(this.config, module, this.context, this.db);
  }

  withContext(context: Record<string, unknown>): LoggingService {
    return new StructuredLogger(this.config, this.module, { ...this.context, ...context }, this.db);
  }

  setLevel(level: JiLogLevel): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.config.level = level;
    });
  }

  flush(): Effect.Effect<void, never> {
    return pipe(
      Effect.sync(() => {
        const entriesToFlush = [...this.buffer];
        this.buffer = [];
        return entriesToFlush;
      }),
      Effect.flatMap((entries) => this.flushEntries(entries)),
    );
  }

  private log(
    level: JiLogLevel,
    message: string,
    error?: Error,
    metadata: Record<string, unknown> = {},
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (!this.shouldLog(level)) {
        return;
      }

      const entry: LogEntry = {
        timestamp: Date.now(),
        level,
        message,
        module: this.module,
        metadata: { ...this.context, ...metadata },
        error,
        userId: this.context.userId as string,
        sessionId: this.context.sessionId as string,
      };

      // Add to buffer for async processing
      this.buffer.push(entry);

      // Immediate console output if enabled
      if (this.config.enableConsole) {
        this.writeToConsole(entry);
      }

      // Force flush for fatal errors
      if (level === 'fatal') {
        this.flushEntries([entry]);
      }
    });
  }

  private shouldLog(level: JiLogLevel): boolean {
    const levels: Record<JiLogLevel, number> = {
      trace: 0,
      debug: 1,
      info: 2,
      warn: 3,
      error: 4,
      fatal: 5,
    };

    return levels[level] >= levels[this.config.level];
  }

  private writeToConsole(entry: LogEntry): void {
    const timestamp = new Date(entry.timestamp).toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const module = `[${entry.module}]`.padEnd(12);

    let output = `${timestamp} ${level} ${module} ${entry.message}`;

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      output += ` ${JSON.stringify(entry.metadata)}`;
    }

    if (entry.error && this.config.includeStackTrace) {
      output += `\n${entry.error.stack}`;
    }

    // Apply colors if enabled
    if (this.config.enableColors) {
      output = this.colorizeOutput(entry.level, output);
    }

    switch (entry.level) {
      case 'trace':
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
      case 'fatal':
        console.error(output);
        break;
    }
  }

  private colorizeOutput(level: JiLogLevel, output: string): string {
    const colors = {
      trace: '\x1b[90m', // gray
      debug: '\x1b[36m', // cyan
      info: '\x1b[32m', // green
      warn: '\x1b[33m', // yellow
      error: '\x1b[31m', // red
      fatal: '\x1b[35m', // magenta
    };

    const reset = '\x1b[0m';
    return `${colors[level]}${output}${reset}`;
  }

  private flushEntries(entries: LogEntry[]): Effect.Effect<void, never> {
    const self = this;
    return Effect.gen(function* () {
      if (entries.length === 0) return;

      // Write to file if enabled
      if (self.config.enableFile && self.config.filePath) {
        yield* self.writeToFile(entries);
      }

      // Write to database if available
      if (self.db) {
        yield* self.writeToDatabase(entries);
      }
    }).pipe(
      Effect.catchAll((error) => {
        console.error('Failed to flush log entries:', error);
        return Effect.succeed(undefined);
      }),
    );
  }

  private writeToFile(entries: LogEntry[]): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: async () => {
        const { appendFile, mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');

        if (!this.config.filePath) return;

        // Ensure directory exists
        await mkdir(dirname(this.config.filePath), { recursive: true });

        const lines = entries
          .map((entry) => {
            const logLine = this.config.enableStructured ? JSON.stringify(entry) : this.formatPlainEntry(entry);
            return `${logLine}\n`;
          })
          .join('');

        await appendFile(this.config.filePath, lines, 'utf8');

        // Check file size and rotate if needed
        await this.rotateLogFileIfNeeded();
      },
      catch: () => undefined, // Ignore file write errors
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  }

  private writeToDatabase(entries: LogEntry[]): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: async () => {
        if (!this.db) return;
        const stmt = this.db.prepare(`
          INSERT INTO logs (
            timestamp, level, message, module, metadata, error, user_id, session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const entry of entries) {
          stmt.run(
            entry.timestamp,
            entry.level,
            entry.message,
            entry.module,
            JSON.stringify(entry.metadata || {}),
            entry.error ? entry.error.stack || entry.error.message : '',
            entry.userId || '',
            entry.sessionId || '',
          );
        }
      },
      catch: () => undefined, // Ignore database write errors
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  }

  private formatPlainEntry(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    let line = `${timestamp} [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}`;

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      line += ` ${JSON.stringify(entry.metadata)}`;
    }

    if (entry.error) {
      line += ` ERROR: ${entry.error.message}`;
      if (this.config.includeStackTrace && entry.error.stack) {
        line += `\n${entry.error.stack}`;
      }
    }

    return line;
  }

  private async rotateLogFileIfNeeded(): Promise<void> {
    if (!this.config.filePath) return;

    try {
      const { stat, rename, unlink } = await import('node:fs/promises');
      const { dirname, basename, extname } = await import('node:path');

      const stats = await stat(this.config.filePath);
      if (stats.size <= this.config.maxFileSize) return;

      const dir = dirname(this.config.filePath);
      const name = basename(this.config.filePath, extname(this.config.filePath));
      const ext = extname(this.config.filePath);

      // Rotate existing files
      for (let i = this.config.maxFiles - 1; i > 0; i--) {
        const oldFile = `${dir}/${name}.${i}${ext}`;
        const newFile = `${dir}/${name}.${i + 1}${ext}`;

        try {
          await rename(oldFile, newFile);
        } catch {
          // File doesn't exist, continue
        }
      }

      // Delete oldest file if it exists
      const oldestFile = `${dir}/${name}.${this.config.maxFiles}${ext}`;
      try {
        await unlink(oldestFile);
      } catch {
        // File doesn't exist, continue
      }

      // Rotate current file
      const rotatedFile = `${dir}/${name}.1${ext}`;
      await rename(this.config.filePath, rotatedFile);
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  private startBackgroundFlush(): void {
    pipe(this.flush(), Effect.repeat(this.flushSchedule), Effect.fork, Effect.runPromise).catch((error) => {
      console.error('Background log flush failed:', error);
    });
  }
}

/**
 * Performance logging utilities
 */
export class PerformanceLogger {
  constructor(private logger: LoggingService) {}

  /**
   * Time an operation and log the duration
   */
  timeOperation<T, E>(operationName: string, operation: Effect.Effect<T, E>): Effect.Effect<T, E> {
    return pipe(
      Effect.sync(() => Date.now()),
      Effect.flatMap((startTime) =>
        pipe(
          operation,
          Effect.tap((result) =>
            pipe(
              Effect.sync(() => Date.now() - startTime),
              Effect.flatMap((duration) =>
                this.logger.info(`Operation completed: ${operationName}`, {
                  operation: operationName,
                  duration,
                  success: true,
                  result: typeof result === 'object' ? 'object' : result,
                }),
              ),
            ),
          ),
          Effect.tapError((error) =>
            pipe(
              Effect.sync(() => Date.now() - startTime),
              Effect.flatMap((duration) =>
                this.logger.error(`Operation failed: ${operationName}`, error as Error, {
                  operation: operationName,
                  duration,
                  success: false,
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * Log slow operations (over threshold)
   */
  logSlowOperation<T, E>(
    operationName: string,
    thresholdMs: number,
    operation: Effect.Effect<T, E>,
  ): Effect.Effect<T, E> {
    return pipe(
      Effect.sync(() => Date.now()),
      Effect.flatMap((startTime) =>
        pipe(
          operation,
          Effect.tap(() =>
            pipe(
              Effect.sync(() => Date.now() - startTime),
              Effect.flatMap((duration) => {
                if (duration > thresholdMs) {
                  return this.logger.warn(`Slow operation detected: ${operationName}`, {
                    operation: operationName,
                    duration,
                    threshold: thresholdMs,
                    slowness: duration - thresholdMs,
                  });
                }
                return Effect.succeed(undefined);
              }),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * Log memory usage
   */
  logMemoryUsage(operation: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (typeof process !== 'undefined' && process.memoryUsage) {
        const memory = process.memoryUsage();
        return this.logger.debug(`Memory usage for ${operation}`, {
          operation,
          heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
          external: Math.round(memory.external / 1024 / 1024),
          rss: Math.round(memory.rss / 1024 / 1024),
        });
      }
      return Effect.succeed(undefined);
    }).pipe(Effect.flatten);
  }
}

/**
 * Audit logging for security and compliance
 */
export class AuditLogger {
  constructor(private logger: LoggingService) {}

  logAuthentication(userId: string, success: boolean, metadata?: Record<string, unknown>): Effect.Effect<void, never> {
    return this.logger.info(`Authentication ${success ? 'successful' : 'failed'}`, {
      event: 'authentication',
      userId,
      success,
      timestamp: Date.now(),
      ...metadata,
    });
  }

  logDataAccess(
    userId: string,
    resource: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): Effect.Effect<void, never> {
    return this.logger.info(`Data access: ${action} on ${resource}`, {
      event: 'data_access',
      userId,
      resource,
      action,
      timestamp: Date.now(),
      ...metadata,
    });
  }

  logConfigurationChange(
    userId: string,
    setting: string,
    oldValue: unknown,
    newValue: unknown,
  ): Effect.Effect<void, never> {
    return this.logger.info(`Configuration changed: ${setting}`, {
      event: 'configuration_change',
      userId,
      setting,
      oldValue,
      newValue,
      timestamp: Date.now(),
    });
  }

  logError(operation: string, error: Error, metadata?: Record<string, unknown>): Effect.Effect<void, never> {
    return this.logger.error(`Audit error in ${operation}`, error, {
      event: 'error',
      operation,
      timestamp: Date.now(),
      ...metadata,
    });
  }
}

/**
 * Logging service context
 */
export const LoggingServiceContext = Context.GenericTag<LoggingService>('LoggingService');

/**
 * Create logging layer with configuration
 */
export const LoggingLayer = (config: LogConfig) =>
  Layer.effect(
    LoggingServiceContext,
    Effect.gen(function* () {
      let db: Database | undefined;

      // Initialize database for log storage if enabled
      if (config.enableFile || config.enableStructured) {
        try {
          const { Database } = yield* Effect.promise(() => import('bun:sqlite'));
          const { homedir: getHomedir } = yield* Effect.promise(() => import('node:os'));
          const { join } = yield* Effect.promise(() => import('node:path'));

          const dbPath = join(getHomedir(), '.ji', 'logs.db');
          db = new Database(dbPath);

          // Create logs table
          db.exec(`
          CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            module TEXT NOT NULL,
            metadata TEXT DEFAULT '{}',
            error TEXT,
            user_id TEXT,
            session_id TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
          )
        `);

          // Create indexes for performance
          db.exec(`
          CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
          CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
          CREATE INDEX IF NOT EXISTS idx_logs_module ON logs(module);
          CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
        `);
        } catch (error) {
          console.warn('Failed to initialize log database:', error);
        }
      }

      return new StructuredLogger(config, 'default', {}, db);
    }),
  );

/**
 * Default logging configuration
 */
export const defaultLogConfig: LogConfig = {
  level: 'info',
  enableConsole: true,
  enableFile: true,
  enableStructured: false,
  filePath: `${process.env.HOME || '~'}/.ji/logs/ji.log`,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  enableColors: true,
  includeStackTrace: true,
};

/**
 * Create default logging service
 */
export function createLogger(config: LogConfig = defaultLogConfig): Effect.Effect<LoggingService, ConfigError> {
  return pipe(
    LoggingLayer(config),
    Layer.build,
    Effect.scoped,
    Effect.map((context) => Context.get(context, LoggingServiceContext)),
    Effect.mapError((error) => new ConfigError(`Failed to create logger: ${error}`, error)),
  );
}

/**
 * Logger utilities for common patterns
 */
export const LoggerUtils = {
  /**
   * Log the start and end of an operation
   */
  wrapOperation: <T, E>(
    logger: LoggingService,
    operationName: string,
    operation: Effect.Effect<T, E>,
  ): Effect.Effect<T, E> =>
    pipe(
      logger.info(`Starting operation: ${operationName}`),
      Effect.flatMap(() => operation),
      Effect.tap(() => logger.info(`Completed operation: ${operationName}`)),
      Effect.tapError((error) => logger.error(`Failed operation: ${operationName}`, error as Error)),
    ),

  /**
   * Create a module-specific logger
   */
  forModule: (logger: LoggingService, module: string): LoggingService => logger.withModule(module),

  /**
   * Create a user-scoped logger
   */
  forUser: (logger: LoggingService, userId: string, sessionId?: string): LoggingService =>
    logger.withContext({ userId, sessionId }),

  /**
   * Log validation errors with context
   */
  logValidationError: (
    logger: LoggingService,
    field: string,
    value: unknown,
    error: ValidationError,
  ): Effect.Effect<void, never> =>
    logger.error(`Validation failed for ${field}`, error, {
      field,
      value: typeof value === 'object' ? 'object' : value,
      validationError: error.message,
    }),
};
