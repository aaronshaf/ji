/**
 * This file enhances the existing ConfigManager with Effect capabilities
 * while maintaining backward compatibility
 */

import { Effect, Option, pipe } from 'effect';
import { type Config, ConfigManager } from './config.js';
import { ConfigError, DatabaseError, ValidationError } from './effects/errors.js';

export class ConfigManagerEffect extends ConfigManager {
  /**
   * Get a setting value as an Option with proper error handling
   */
  getSettingEffect(key: string): Effect.Effect<Option.Option<string>, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const value = await this.getSetting(key);
        return Option.fromNullable(value);
      },
      catch: (error) => new DatabaseError(`Failed to get setting '${key}'`, error),
    });
  }

  /**
   * Get a required setting that fails if not found
   */
  getRequiredSettingEffect(key: string): Effect.Effect<string, DatabaseError | ConfigError> {
    return pipe(
      this.getSettingEffect(key),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ConfigError(`Required setting '${key}' not found`)),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
  }

  /**
   * Set a setting with validation
   */
  setSettingEffect(key: string, value: string): Effect.Effect<void, DatabaseError | ValidationError> {
    return pipe(
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
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: async () => {
            await this.setSetting(key, value);
          },
          catch: (error) => new DatabaseError(`Failed to set setting '${key}'`, error),
        }),
      ),
    );
  }

  /**
   * Get configuration with detailed error information
   */
  getConfigEffect(): Effect.Effect<Config, ConfigError> {
    return Effect.tryPromise({
      try: async () => {
        const config = await this.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        return config;
      },
      catch: (error) => new ConfigError('Failed to load configuration', error),
    });
  }
}

// Export a factory function to create the enhanced version
export const createConfigManagerWithEffect = () => new ConfigManagerEffect();
