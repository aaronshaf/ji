import { Effect, Option, pipe } from 'effect';
import type { Config, ConfigManager } from '../config';
import { ConfigError, DatabaseError, ValidationError } from './errors';

/**
 * Effect-based wrapper for ConfigManager operations
 * Demonstrates Option type for nullable values and proper error handling
 */
export class ConfigEffect {
  constructor(private configManager: ConfigManager) {}

  /**
   * Get a setting value as an Option
   * Returns None for missing settings, fails for database errors
   */
  getSetting(key: string): Effect.Effect<Option.Option<string>, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const value = await this.configManager.getSetting(key);
        return Option.fromNullable(value);
      },
      catch: (error) => new DatabaseError(`Failed to get setting '${key}'`, error),
    });
  }

  /**
   * Get a required setting (fails if not found)
   */
  getRequiredSetting(key: string): Effect.Effect<string, DatabaseError | ConfigError> {
    return pipe(
      this.getSetting(key),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ConfigError(`Required setting '${key}' not found`)),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
  }

  /**
   * Set a setting value with validation
   */
  setSetting(key: string, value: string): Effect.Effect<void, DatabaseError | ValidationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!key || key.trim().length === 0) {
          throw new ValidationError('Setting key cannot be empty');
        }
        if (key.length > 255) {
          throw new ValidationError('Setting key too long (max 255 chars)');
        }
        if (value.length > 10000) {
          throw new ValidationError('Setting value too long (max 10000 chars)');
        }
      }),
      // Save to database
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: async () => {
            await this.configManager.setSetting(key, value);
          },
          catch: (error) => new DatabaseError(`Failed to set setting '${key}'`, error),
        }),
      ),
    );
  }

  /**
   * Get multiple settings at once
   */
  getSettings(keys: string[]): Effect.Effect<Map<string, Option.Option<string>>, DatabaseError> {
    return pipe(
      keys,
      Effect.forEach(
        (key) =>
          pipe(
            this.getSetting(key),
            Effect.map((value) => [key, value] as const),
          ),
        { concurrency: 5 },
      ),
      Effect.map((entries) => new Map(entries)),
    );
  }

  /**
   * Get the main configuration with detailed error handling
   */
  getConfig(): Effect.Effect<Config, ConfigError> {
    return Effect.tryPromise({
      try: async () => {
        const config = await this.configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found');
        }
        return config;
      },
      catch: (error) => new ConfigError('Failed to load configuration', error),
    });
  }
}

// Backward compatible wrappers
export const makeConfigEffect = (configManager: ConfigManager) => {
  const effect = new ConfigEffect(configManager);

  return effect;
};
