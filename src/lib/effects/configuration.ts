import { Context, Duration, Effect, Layer, pipe, Schedule } from 'effect';
import { ConfigError, ValidationError } from './errors.js';
import type { LogConfig } from './logging.js';

/**
 * Application configuration schema
 */
export interface AppConfig {
  // Core application settings
  app: {
    name: string;
    version: string;
    environment: 'development' | 'production' | 'test';
    debug: boolean;
  };

  // Jira configuration
  jira: {
    baseUrl: string;
    email: string;
    // API token stored separately in auth.json for security
    maxResults: number;
    timeout: number;
    retries: number;
  };

  // Confluence configuration
  confluence: {
    baseUrl: string;
    // Uses same auth as Jira
    timeout: number;
    retries: number;
    maxPages: number;
  };

  // Search configuration
  search: {
    provider: 'meilisearch' | 'sqlite' | 'hybrid';
    meilisearch?: {
      host: string;
      indexName: string;
      timeout: number;
    };
    enableSemanticSearch: boolean;
    maxResults: number;
    cacheTimeout: number;
  };

  // Database configuration
  database: {
    path: string;
    maxConnections: number;
    timeout: number;
    enableWAL: boolean;
    enableForeignKeys: boolean;
  };

  // Cache configuration
  cache: {
    enabled: boolean;
    maxSize: number;
    ttl: number;
    persistToDisk: boolean;
    compressionEnabled: boolean;
  };

  // Logging configuration
  logging: LogConfig;

  // Background jobs configuration
  jobs: {
    enabled: boolean;
    workers: number;
    syncInterval: number;
    maxRetries: number;
    retryDelay: number;
  };

  // Ollama integration
  ollama: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeout: number;
  };

  // Feature flags
  features: {
    backgroundSync: boolean;
    aiAssistant: boolean;
    searchAnalytics: boolean;
    cacheWarming: boolean;
    performanceMetrics: boolean;
  };
}

/**
 * Environment-specific configuration overrides
 */
export interface EnvironmentConfig {
  development?: Partial<AppConfig>;
  production?: Partial<AppConfig>;
  test?: Partial<AppConfig>;
}

/**
 * Configuration validation schema
 */
export interface ConfigValidation {
  required: (keyof AppConfig)[];
  optional: (keyof AppConfig)[];
  validators: Record<string, (value: unknown) => Effect.Effect<void, ValidationError>>;
}

/**
 * Configuration service interface
 */
export interface ConfigurationService {
  get: <K extends keyof AppConfig>(key: K) => Effect.Effect<AppConfig[K], ConfigError>;
  getPath: <T>(path: string) => Effect.Effect<T, ConfigError>;
  set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => Effect.Effect<void, ConfigError>;
  setPath: (path: string, value: unknown) => Effect.Effect<void, ConfigError>;
  reload: () => Effect.Effect<AppConfig, ConfigError>;
  validate: () => Effect.Effect<void, ValidationError | ConfigError>;
  watch: (callback: (config: AppConfig) => void) => Effect.Effect<void, ConfigError>;
  getEnvironment: () => Effect.Effect<string, never>;
  isDevelopment: () => Effect.Effect<boolean, never>;
  isProduction: () => Effect.Effect<boolean, never>;
  export: () => Effect.Effect<string, ConfigError>;
}

/**
 * Configuration manager implementation
 */
export class EffectConfigManager implements ConfigurationService {
  private config: AppConfig;
  private watchers: Array<(config: AppConfig) => void> = [];
  private configPath: string;
  private watchSchedule = Schedule.fixed(Duration.seconds(5));

  constructor(
    initialConfig: AppConfig,
    configPath: string,
    private validation: ConfigValidation,
  ) {
    this.config = initialConfig;
    this.configPath = configPath;
    this.startConfigWatcher();
  }

  get<K extends keyof AppConfig>(key: K): Effect.Effect<AppConfig[K], ConfigError> {
    return Effect.sync(() => {
      const value = this.config[key];
      if (value === undefined) {
        throw new ConfigError(`Configuration key not found: ${String(key)}`);
      }
      return value;
    });
  }

  getPath<T>(path: string): Effect.Effect<T, ConfigError> {
    return Effect.sync(() => {
      const keys = path.split('.');
      let current: unknown = this.config;

      for (const key of keys) {
        if (current && typeof current === 'object' && key in current) {
          current = (current as Record<string, unknown>)[key];
        } else {
          throw new ConfigError(`Configuration path not found: ${path}`);
        }
      }

      return current as T;
    });
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): Effect.Effect<void, ConfigError> {
    return pipe(
      Effect.sync(() => {
        this.config = { ...this.config, [key]: value };
      }),
      Effect.flatMap(() => this.saveConfig()),
      Effect.flatMap(() => this.notifyWatchers()),
    );
  }

  setPath(path: string, value: unknown): Effect.Effect<void, ConfigError> {
    return pipe(
      Effect.sync(() => {
        const keys = path.split('.');
        const newConfig = JSON.parse(JSON.stringify(this.config));
        let current = newConfig;

        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i];
          if (!(key in current)) {
            current[key] = {};
          }
          current = current[key];
        }

        current[keys[keys.length - 1]] = value;
        this.config = newConfig;
      }),
      Effect.flatMap(() => this.saveConfig()),
      Effect.flatMap(() => this.notifyWatchers()),
    );
  }

  reload(): Effect.Effect<AppConfig, ConfigError> {
    return pipe(
      this.loadConfig(),
      Effect.tap((config) =>
        Effect.sync(() => {
          this.config = config;
        }),
      ),
      Effect.tap(() => this.notifyWatchers()),
      Effect.map(() => this.config),
    );
  }

  validate(): Effect.Effect<void, ValidationError | ConfigError> {
    return pipe(
      Effect.all(
        this.validation.required.map((key) =>
          pipe(
            this.get(key),
            Effect.mapError(
              (error) =>
                new ValidationError(`Required configuration missing: ${String(key)}`, String(key), undefined, error),
            ),
          ),
        ),
      ),
      Effect.flatMap(() => this.runCustomValidations()),
      Effect.map(() => undefined),
    );
  }

  watch(callback: (config: AppConfig) => void): Effect.Effect<void, ConfigError> {
    return Effect.sync(() => {
      this.watchers.push(callback);
    });
  }

  getEnvironment(): Effect.Effect<string, never> {
    return Effect.sync(() => this.config.app.environment);
  }

  isDevelopment(): Effect.Effect<boolean, never> {
    return Effect.sync(() => this.config.app.environment === 'development');
  }

  isProduction(): Effect.Effect<boolean, never> {
    return Effect.sync(() => this.config.app.environment === 'production');
  }

  export(): Effect.Effect<string, ConfigError> {
    return Effect.sync(() => {
      // Remove sensitive data before export
      const exportConfig = JSON.parse(JSON.stringify(this.config));

      // Remove any auth tokens or sensitive data
      if (exportConfig.jira) {
        delete exportConfig.jira.apiToken;
      }

      return JSON.stringify(exportConfig, null, 2);
    });
  }

  private loadConfig(): Effect.Effect<AppConfig, ConfigError> {
    return Effect.tryPromise({
      try: async () => {
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(this.configPath, 'utf8');
        return JSON.parse(content) as AppConfig;
      },
      catch: (error) => new ConfigError(`Failed to load configuration from ${this.configPath}: ${error}`, error),
    });
  }

  private saveConfig(): Effect.Effect<void, ConfigError> {
    return Effect.tryPromise({
      try: async () => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');

        // Ensure directory exists
        await mkdir(dirname(this.configPath), { recursive: true });

        // Save config without sensitive data
        const configToSave = this.sanitizeForSave(this.config);
        await writeFile(this.configPath, JSON.stringify(configToSave, null, 2), 'utf8');
      },
      catch: (error) => new ConfigError(`Failed to save configuration to ${this.configPath}: ${error}`, error),
    });
  }

  private sanitizeForSave(config: AppConfig): AppConfig {
    const sanitized = JSON.parse(JSON.stringify(config));

    // Remove sensitive data that should be stored separately
    if (sanitized.jira) {
      delete sanitized.jira.apiToken;
    }

    return sanitized;
  }

  private notifyWatchers(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      for (const watcher of this.watchers) {
        try {
          watcher(this.config);
        } catch (error) {
          console.error('Config watcher error:', error);
        }
      }
    });
  }

  private runCustomValidations(): Effect.Effect<void, ValidationError | ConfigError> {
    return pipe(
      Effect.all(
        Object.entries(this.validation.validators).map(([path, validator]) =>
          pipe(
            this.getPath(path),
            Effect.flatMap((value) =>
              pipe(
                validator(value),
                Effect.mapError(
                  (error) => new ValidationError(`Validation failed for ${path}: ${error.message}`, path, value),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.map(() => undefined),
    );
  }

  private startConfigWatcher(): void {
    pipe(this.watchConfigFile(), Effect.repeat(this.watchSchedule), Effect.fork, Effect.runPromise).catch((error) => {
      console.error('Config file watching failed:', error);
    });
  }

  private watchConfigFile(): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: async () => {
        const { stat } = await import('node:fs/promises');

        try {
          const stats = await stat(this.configPath);
          const lastModified = stats.mtime.getTime();

          if (this.lastConfigModified && lastModified > this.lastConfigModified) {
            await pipe(this.reload(), Effect.runPromise);
          }

          this.lastConfigModified = lastModified;
        } catch (_error) {
          // Config file doesn't exist or can't be read
          // This is fine, we'll use the current config
        }
      },
      catch: () => undefined, // Ignore watch errors
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  }

  private lastConfigModified?: number;
}

/**
 * Default application configuration
 */
export const defaultConfig: AppConfig = {
  app: {
    name: 'ji',
    version: '1.0.0',
    environment: 'development',
    debug: true,
  },
  jira: {
    baseUrl: '',
    email: '',
    maxResults: 50,
    timeout: 30000,
    retries: 3,
  },
  confluence: {
    baseUrl: '',
    timeout: 30000,
    retries: 3,
    maxPages: 1000,
  },
  search: {
    provider: 'hybrid',
    meilisearch: {
      host: 'http://localhost:7700',
      indexName: 'ji_content',
      timeout: 5000,
    },
    enableSemanticSearch: true,
    maxResults: 20,
    cacheTimeout: 300000,
  },
  database: {
    path: `${process.env.HOME || '~'}/.ji/data.db`,
    maxConnections: 5,
    timeout: 5000,
    enableWAL: true,
    enableForeignKeys: true,
  },
  cache: {
    enabled: true,
    maxSize: 10000,
    ttl: 1800000, // 30 minutes
    persistToDisk: true,
    compressionEnabled: false,
  },
  logging: {
    level: 'info',
    enableConsole: true,
    enableFile: true,
    enableStructured: false,
    filePath: `${process.env.HOME || '~'}/.ji/logs/ji.log`,
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 5,
    enableColors: true,
    includeStackTrace: true,
  },
  jobs: {
    enabled: true,
    workers: 2,
    syncInterval: 1800000, // 30 minutes
    maxRetries: 3,
    retryDelay: 5000,
  },
  ollama: {
    enabled: false,
    baseUrl: 'http://localhost:11434',
    model: 'gemma2:latest',
    timeout: 30000,
  },
  features: {
    backgroundSync: true,
    aiAssistant: false,
    searchAnalytics: true,
    cacheWarming: true,
    performanceMetrics: false,
  },
};

/**
 * Configuration validation rules
 */
export const configValidation: ConfigValidation = {
  required: ['app', 'database', 'logging'],
  optional: ['jira', 'confluence', 'search', 'cache', 'jobs', 'ollama', 'features'],
  validators: {
    'app.environment': (value) =>
      Effect.sync(() => {
        if (!['development', 'production', 'test'].includes(value as string)) {
          throw new ValidationError('Invalid environment', 'app.environment', value);
        }
      }),
    'jira.baseUrl': (value) =>
      Effect.sync(() => {
        if (value && typeof value === 'string' && value.length > 0) {
          try {
            new URL(value);
          } catch {
            throw new ValidationError('Invalid Jira base URL', 'jira.baseUrl', value);
          }
        }
      }),
    'confluence.baseUrl': (value) =>
      Effect.sync(() => {
        if (value && typeof value === 'string' && value.length > 0) {
          try {
            new URL(value);
          } catch {
            throw new ValidationError('Invalid Confluence base URL', 'confluence.baseUrl', value);
          }
        }
      }),
    'database.path': (value) =>
      Effect.sync(() => {
        if (!value || typeof value !== 'string' || value.length === 0) {
          throw new ValidationError('Database path is required', 'database.path', value);
        }
      }),
    'jobs.workers': (value) =>
      Effect.sync(() => {
        if (typeof value !== 'number' || value < 1 || value > 10) {
          throw new ValidationError('Job workers must be between 1 and 10', 'jobs.workers', value);
        }
      }),
  },
};

/**
 * Configuration migration utilities
 */
export class ConfigMigration {
  static migrateToV2(oldConfig: Record<string, unknown>): AppConfig {
    // Migrate from v1 to v2 configuration format
    const migrated = { ...defaultConfig };

    if (typeof oldConfig.jiraBaseUrl === 'string') {
      migrated.jira.baseUrl = oldConfig.jiraBaseUrl;
    }

    if (typeof oldConfig.confluenceBaseUrl === 'string') {
      migrated.confluence.baseUrl = oldConfig.confluenceBaseUrl;
    }

    if (typeof oldConfig.debug === 'boolean') {
      migrated.app.debug = oldConfig.debug;
      migrated.logging.level = oldConfig.debug ? 'debug' : 'info';
    }

    return migrated;
  }

  static getCurrentVersion(): string {
    return '2.0.0';
  }

  static needsMigration(config: Record<string, unknown>): boolean {
    if (typeof config.app !== 'object' || config.app === null) {
      return true;
    }
    const app = config.app as Record<string, unknown>;
    return !app.version || app.version !== ConfigMigration.getCurrentVersion();
  }
}

/**
 * Environment configuration loader
 */
export class EnvironmentConfigLoader {
  static loadFromEnvironment(): Partial<AppConfig> {
    const env = process.env;
    const config: Partial<AppConfig> = {};

    // Load from environment variables
    if (env.JI_ENVIRONMENT) {
      config.app = {
        name: 'ji',
        version: '1.0.0',
        debug: false,
        environment: env.JI_ENVIRONMENT as 'development' | 'production' | 'test',
      };
    }

    if (env.JI_DEBUG === 'true') {
      config.app = {
        name: 'ji',
        version: '1.0.0',
        environment: 'development',
        debug: true,
      };
    }

    if (env.JI_JIRA_BASE_URL) {
      config.jira = {
        email: '',
        maxResults: 50,
        timeout: 30000,
        retries: 3,
        baseUrl: env.JI_JIRA_BASE_URL,
      };
    }

    if (env.JI_CONFLUENCE_BASE_URL) {
      config.confluence = {
        timeout: 30000,
        retries: 3,
        maxPages: 1000,
        baseUrl: env.JI_CONFLUENCE_BASE_URL,
      };
    }

    if (env.JI_DATABASE_PATH) {
      config.database = {
        maxConnections: 5,
        timeout: 5000,
        enableWAL: true,
        enableForeignKeys: true,
        path: env.JI_DATABASE_PATH,
      };
    }

    if (env.JI_LOG_LEVEL) {
      config.logging = {
        enableConsole: true,
        enableFile: true,
        enableStructured: false,
        maxFileSize: 10 * 1024 * 1024,
        maxFiles: 5,
        enableColors: true,
        includeStackTrace: true,
        level: env.JI_LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      };
    }

    return config;
  }

  static setEnvironmentVariables(config: AppConfig): void {
    process.env.JI_ENVIRONMENT = config.app.environment;
    process.env.JI_DEBUG = config.app.debug.toString();

    if (config.jira.baseUrl) {
      process.env.JI_JIRA_BASE_URL = config.jira.baseUrl;
    }

    if (config.confluence.baseUrl) {
      process.env.JI_CONFLUENCE_BASE_URL = config.confluence.baseUrl;
    }
  }
}

/**
 * Configuration service context
 */
export const ConfigurationServiceContext = Context.GenericTag<ConfigurationService>('ConfigurationService');

/**
 * Configuration layer
 */
export const ConfigurationLayer = (configPath?: string) =>
  Layer.effect(
    ConfigurationServiceContext,
    Effect.gen(function* () {
      const finalConfigPath = configPath || `${process.env.HOME || '~'}/.ji/config.json`;

      // Load base configuration
      let config = defaultConfig;

      // Try to load existing configuration
      try {
        const loadedConfig = yield* Effect.tryPromise({
          try: async () => {
            const { readFile } = await import('node:fs/promises');
            const content = await readFile(finalConfigPath, 'utf8');
            return JSON.parse(content);
          },
          catch: () => null, // File doesn't exist, use defaults
        });

        if (loadedConfig) {
          // Check if migration is needed
          if (ConfigMigration.needsMigration(loadedConfig)) {
            config = ConfigMigration.migrateToV2(loadedConfig);
          } else {
            config = { ...defaultConfig, ...loadedConfig };
          }
        }
      } catch (error) {
        console.warn('Failed to load configuration, using defaults:', error);
      }

      // Apply environment overrides
      const envConfig = EnvironmentConfigLoader.loadFromEnvironment();
      config = { ...config, ...envConfig };

      // Set current version
      config.app.version = ConfigMigration.getCurrentVersion();

      const configManager = new EffectConfigManager(config, finalConfigPath, configValidation);

      // Validate configuration
      yield* configManager
        .validate()
        .pipe(Effect.mapError((error) => new ConfigError(`Configuration validation failed: ${error.message}`, error)));

      // Save the final configuration
      yield* configManager.set('app', config.app);

      return configManager;
    }),
  );

/**
 * Create configuration service
 */
export function createConfigurationService(configPath?: string): Effect.Effect<ConfigurationService, ConfigError> {
  return pipe(
    ConfigurationLayer(configPath),
    Layer.build,
    Effect.scoped,
    Effect.map((context) => Context.get(context, ConfigurationServiceContext)),
    Effect.mapError((error) => new ConfigError(`Failed to create configuration service: ${error}`, error)),
  );
}

/**
 * Configuration utilities
 */
export const ConfigUtils = {
  /**
   * Get nested configuration value safely
   */
  getNestedValue: <T>(config: AppConfig, path: string, defaultValue?: T): T | undefined => {
    const keys = path.split('.');
    let current: unknown = config;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return defaultValue;
      }
    }

    return current as T;
  },

  /**
   * Deep merge configuration objects
   */
  mergeConfigs: (base: AppConfig, override: Partial<AppConfig>): AppConfig => {
    const merged = JSON.parse(JSON.stringify(base));

    function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!target[key]) target[key] = {};
          deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
        } else {
          target[key] = source[key];
        }
      }
      return target;
    }

    deepMerge(merged as Record<string, unknown>, override as Record<string, unknown>);
    return merged;
  },

  /**
   * Validate URL configuration
   */
  validateUrl: (url: string, name: string): Effect.Effect<void, ValidationError> =>
    Effect.sync(() => {
      try {
        new URL(url);
      } catch {
        throw new ValidationError(`Invalid URL for ${name}`, name, url);
      }
    }),

  /**
   * Validate file path configuration
   */
  validatePath: (path: string, name: string): Effect.Effect<void, ValidationError> =>
    Effect.tryPromise({
      try: async () => {
        const { access } = await import('node:fs/promises');
        const { dirname } = await import('node:path');

        try {
          await access(dirname(path));
        } catch {
          const { mkdir } = await import('node:fs/promises');
          await mkdir(dirname(path), { recursive: true });
        }
      },
      catch: (error) => new ValidationError(`Invalid path for ${name}: ${error}`, name, path),
    }),
};
