/**
 * Core service layers for dependency injection
 * These layers provide the foundation for the Effect-based architecture
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Layer, pipe, Ref } from 'effect';
import type { Config as JiConfig } from '../config.js';
import { ConfigError, DatabaseError, NetworkError } from './errors.js';

// ============= Configuration Layer =============
export interface ConfigService {
  readonly getConfig: Effect.Effect<JiConfig, ConfigError>;
  readonly setConfig: (config: JiConfig) => Effect.Effect<void, ConfigError>;
  readonly getSetting: (key: string) => Effect.Effect<string | null, ConfigError>;
  readonly setSetting: (key: string, value: string) => Effect.Effect<void, ConfigError>;
  readonly reload: Effect.Effect<void, ConfigError>;
}

export class ConfigServiceTag extends Context.Tag('ConfigService')<ConfigServiceTag, ConfigService>() {}

export const ConfigServiceLive = Layer.effect(
  ConfigServiceTag,
  Effect.gen(function* () {
    const configPath = join(homedir(), '.ji', 'auth.json');
    const configRef = yield* Ref.make<JiConfig | null>(null);

    const loadConfig = Effect.try({
      try: () => {
        if (existsSync(configPath)) {
          const data = readFileSync(configPath, 'utf-8');
          return JSON.parse(data) as JiConfig;
        }
        return null;
      },
      catch: (error) => new ConfigError(`Failed to load config: ${error}`),
    });

    const saveConfig = (config: JiConfig) =>
      Effect.try({
        try: () => {
          writeFileSync(configPath, JSON.stringify(config, null, 2));
        },
        catch: (error) => new ConfigError(`Failed to save config: ${error}`),
      });

    // Initialize config
    const initialConfig = yield* loadConfig;
    if (initialConfig) {
      yield* Ref.set(configRef, initialConfig);
    }

    return {
      getConfig: pipe(
        Ref.get(configRef),
        Effect.flatMap((config) =>
          config ? Effect.succeed(config) : Effect.fail(new ConfigError('No configuration found')),
        ),
      ),

      setConfig: (config: JiConfig) =>
        pipe(
          saveConfig(config),
          Effect.flatMap(() => Ref.set(configRef, config)),
        ),

      getSetting: (_key: string) => Effect.succeed(null), // TODO: Implement settings storage

      setSetting: (_key: string, _value: string) => Effect.succeed(undefined), // TODO: Implement settings storage

      reload: pipe(
        loadConfig,
        Effect.flatMap((config) =>
          config ? Ref.set(configRef, config) : Effect.fail(new ConfigError('No configuration found')),
        ),
      ),
    };
  }),
);

// ============= Database Layer =============
export interface DatabaseService {
  readonly execute: <T>(sql: string, params?: unknown[]) => Effect.Effect<T, DatabaseError>;
  readonly query: <T>(sql: string, params?: unknown[]) => Effect.Effect<T[], DatabaseError>;
  readonly transaction: <R, E, A>(effect: Effect.Effect<R, E, A>) => Effect.Effect<R, E | DatabaseError, A>;
  readonly getConnection: Effect.Effect<Database, DatabaseError>;
}

export class DatabaseServiceTag extends Context.Tag('DatabaseService')<DatabaseServiceTag, DatabaseService>() {}

export const DatabaseServiceLive = Layer.scoped(
  DatabaseServiceTag,
  Effect.gen(function* () {
    const dbPath = join(homedir(), '.ji', 'data.db');

    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(dbPath),
        catch: (error) => new DatabaseError(`Failed to open database: ${error}`),
      }),
      (db) => Effect.sync(() => db.close()),
    );

    return {
      execute: <T>(sql: string, params?: unknown[]) =>
        Effect.try({
          try: () => {
            const stmt = db.prepare(sql);
            return (params ? stmt.run(...(params as never[])) : stmt.run()) as T;
          },
          catch: (error) => new DatabaseError(`Query execution failed: ${error}`),
        }),

      query: <T>(sql: string, params?: unknown[]) =>
        Effect.try({
          try: () => {
            const stmt = db.prepare(sql);
            return (params ? stmt.all(...(params as never[])) : stmt.all()) as T[];
          },
          catch: (error) => new DatabaseError(`Query failed: ${error}`),
        }),

      transaction: <R, E, A>(effect: Effect.Effect<R, E, A>) =>
        pipe(
          Effect.try({
            try: () => db.run('BEGIN'),
            catch: (error) => new DatabaseError(`Failed to begin transaction: ${error}`),
          }),
          Effect.flatMap(() => effect),
          Effect.tap(() =>
            Effect.try({
              try: () => db.run('COMMIT'),
              catch: (error) => new DatabaseError(`Failed to commit transaction: ${error}`),
            }),
          ),
          Effect.catchAll((error) =>
            pipe(
              Effect.try({
                try: () => db.run('ROLLBACK'),
                catch: (rollbackError) => new DatabaseError(`Failed to rollback transaction: ${rollbackError}`),
              }),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        ),

      getConnection: Effect.succeed(db),
    };
  }),
);

// ============= HTTP Client Layer =============
export interface HttpClientService {
  readonly request: <T>(url: string, options?: RequestInit) => Effect.Effect<T, NetworkError>;
  readonly get: <T>(url: string, headers?: Record<string, string>) => Effect.Effect<T, NetworkError>;
  readonly post: <T>(url: string, body: unknown, headers?: Record<string, string>) => Effect.Effect<T, NetworkError>;
  readonly put: <T>(url: string, body: unknown, headers?: Record<string, string>) => Effect.Effect<T, NetworkError>;
  readonly delete: <T>(url: string, headers?: Record<string, string>) => Effect.Effect<T, NetworkError>;
}

export class HttpClientServiceTag extends Context.Tag('HttpClientService')<HttpClientServiceTag, HttpClientService>() {}

export const HttpClientServiceLive = Layer.effect(
  HttpClientServiceTag,
  Effect.sync(() => {
    // Prevent real HTTP calls in test environment unless explicitly allowed
    if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API_CALLS) {
      throw new Error(
        'Real HTTP calls detected in test environment! ' +
          'Tests must use TestHttpClientService from test-layers.ts to avoid making real HTTP requests. ' +
          'If you really need to make real calls, set ALLOW_REAL_API_CALLS=true',
      );
    }

    const defaultTimeout = 30000; // 30 seconds

    const makeRequest = <T>(url: string, options?: RequestInit) =>
      Effect.tryPromise({
        try: async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), defaultTimeout);

          try {
            const response = await fetch(url, {
              ...options,
              signal: controller.signal,
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return response.json() as Promise<T>;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        catch: (error) => {
          if (error instanceof Error && error.name === 'AbortError') {
            return new NetworkError(`Request timeout: ${url}`);
          }
          return new NetworkError(`Request failed: ${error}`);
        },
      });

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
  }),
);

// ============= Logger Layer =============
export interface LoggerService {
  readonly debug: (message: string, context?: Record<string, unknown>) => Effect.Effect<void>;
  readonly info: (message: string, context?: Record<string, unknown>) => Effect.Effect<void>;
  readonly warn: (message: string, context?: Record<string, unknown>) => Effect.Effect<void>;
  readonly error: (message: string, error?: unknown, context?: Record<string, unknown>) => Effect.Effect<void>;
}

export class LoggerServiceTag extends Context.Tag('LoggerService')<LoggerServiceTag, LoggerService>() {}

export const LoggerServiceLive = Layer.effect(
  LoggerServiceTag,
  Effect.sync(() => {
    const formatLog = (level: string, message: string, context?: Record<string, unknown>) => {
      const timestamp = new Date().toISOString();
      const contextStr = context ? ` ${JSON.stringify(context)}` : '';
      return `[${timestamp}] ${level}: ${message}${contextStr}`;
    };

    return {
      debug: (message: string, context?: Record<string, unknown>) =>
        Effect.sync(() => console.debug(formatLog('DEBUG', message, context))),

      info: (message: string, context?: Record<string, unknown>) =>
        Effect.sync(() => console.info(formatLog('INFO', message, context))),

      warn: (message: string, context?: Record<string, unknown>) =>
        Effect.sync(() => console.warn(formatLog('WARN', message, context))),

      error: (message: string, error?: unknown, context?: Record<string, unknown>) =>
        Effect.sync(() =>
          console.error(
            formatLog('ERROR', message, {
              ...context,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
    };
  }),
);

// ============= Combined Application Layer =============
export const AppLive = ConfigServiceLive.pipe(
  Layer.provideMerge(DatabaseServiceLive),
  Layer.provideMerge(HttpClientServiceLive),
  Layer.provideMerge(LoggerServiceLive),
);
