import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, pipe } from 'effect';
import { ConfigManager, ConfigError, FileError, ParseError, ValidationError, type Config } from './config.js';
import { EnvironmentSaver, isolateTestEnvironment } from '../test/test-helpers.js';

describe('ConfigManager Effect-based Tests', () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let cleanup: () => void;

  beforeEach(() => {
    const env = isolateTestEnvironment();
    tempDir = env.tempDir;
    cleanup = env.cleanup;
    configManager = new ConfigManager();
  });

  afterEach(() => {
    configManager?.close?.();
    cleanup();
  });

  describe('Effect-based getConfigEffect', () => {
    it('should successfully read valid configuration', async () => {
      const validConfig: Config = {
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token-123',
        analysisCommand: 'claude',
      };

      await configManager.setConfig(validConfig);

      const result = await Effect.runPromiseExit(configManager.getConfigEffect());

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value).toEqual(validConfig);
      }
    });

    it('should fail with ConfigError when no configuration exists', async () => {
      const result = await Effect.runPromiseExit(configManager.getConfigEffect());

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = result.cause;
        // Check if error contains ConfigError
        const failureMessage = JSON.stringify(error);
        expect(failureMessage).toContain('ConfigError');
      }
    });

    it('should fail with ParseError for invalid JSON', async () => {
      const configPath = join(tempDir, 'config.json');
      writeFileSync(configPath, 'invalid json{', 'utf-8');

      const result = await Effect.runPromiseExit(configManager.getConfigEffect());

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failureMessage = JSON.stringify(result.cause);
        expect(failureMessage).toContain('ParseError');
      }
    });

    it('should fail with ValidationError for invalid schema', async () => {
      const configPath = join(tempDir, 'config.json');
      const invalidConfig = {
        jiraUrl: 'not-a-url', // Invalid URL format
        email: 'invalid-email', // Invalid email format
        apiToken: '', // Empty token
      };
      writeFileSync(configPath, JSON.stringify(invalidConfig), 'utf-8');

      const result = await Effect.runPromiseExit(configManager.getConfigEffect());

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failureMessage = JSON.stringify(result.cause);
        expect(failureMessage).toContain('ValidationError');
      }
    });

    it('should validate URL format correctly', async () => {
      const configPath = join(tempDir, 'config.json');

      // Test invalid URL
      const invalidUrlConfig = {
        jiraUrl: 'invalid-url',
        email: 'test@example.com',
        apiToken: 'token',
      };
      writeFileSync(configPath, JSON.stringify(invalidUrlConfig), 'utf-8');

      const invalidResult = await Effect.runPromiseExit(configManager.getConfigEffect());
      expect(Exit.isFailure(invalidResult)).toBe(true);

      // Test valid URL
      const validUrlConfig = {
        jiraUrl: 'https://valid.atlassian.net',
        email: 'test@example.com',
        apiToken: 'token',
      };
      writeFileSync(configPath, JSON.stringify(validUrlConfig), 'utf-8');

      const validResult = await Effect.runPromiseExit(configManager.getConfigEffect());
      expect(Exit.isSuccess(validResult)).toBe(true);
    });

    it('should validate email format correctly', async () => {
      const configPath = join(tempDir, 'config.json');

      // Test invalid emails
      const invalidEmails = ['not-an-email', '@example.com', 'user@', 'user@.com', 'user.example.com'];

      for (const invalidEmail of invalidEmails) {
        const config = {
          jiraUrl: 'https://test.atlassian.net',
          email: invalidEmail,
          apiToken: 'token',
        };
        writeFileSync(configPath, JSON.stringify(config), 'utf-8');

        const result = await Effect.runPromiseExit(configManager.getConfigEffect());
        expect(Exit.isFailure(result)).toBe(true);
      }

      // Test valid emails
      const validEmails = ['user@example.com', 'user.name@example.com', 'user+tag@example.co.uk'];

      for (const validEmail of validEmails) {
        const config = {
          jiraUrl: 'https://test.atlassian.net',
          email: validEmail,
          apiToken: 'token',
        };
        writeFileSync(configPath, JSON.stringify(config), 'utf-8');

        const result = await Effect.runPromiseExit(configManager.getConfigEffect());
        expect(Exit.isSuccess(result)).toBe(true);
      }
    });

    it('should handle optional fields correctly', async () => {
      const minimalConfig: Config = {
        jiraUrl: 'https://minimal.atlassian.net',
        email: 'minimal@example.com',
        apiToken: 'minimal-token',
        // Optional fields omitted
      };

      await configManager.setConfig(minimalConfig);

      const result = await Effect.runPromiseExit(configManager.getConfigEffect());

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value.jiraUrl).toBe('https://minimal.atlassian.net');
        expect(result.value.email).toBe('minimal@example.com');
        expect(result.value.apiToken).toBe('minimal-token');
        expect(result.value.analysisCommand).toBeUndefined();
      }
    });
  });

  describe('Effect composition patterns', () => {
    it('should compose with other Effects using pipe', async () => {
      const validConfig: Config = {
        jiraUrl: 'https://compose.atlassian.net',
        email: 'compose@example.com',
        apiToken: 'compose-token',
      };

      await configManager.setConfig(validConfig);

      const program = pipe(
        configManager.getConfigEffect(),
        Effect.map((config) => ({
          ...config,
          baseAuth: Buffer.from(`${config.email}:${config.apiToken}`).toString('base64'),
        })),
        Effect.flatMap((config) =>
          Effect.succeed({
            url: config.jiraUrl,
            auth: config.baseAuth,
          }),
        ),
      );

      const result = await Effect.runPromiseExit(program);

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value.url).toBe('https://compose.atlassian.net');
        expect(result.value.auth).toBe(Buffer.from('compose@example.com:compose-token').toString('base64'));
      }
    });

    it('should handle errors with catchAll', async () => {
      // No config exists
      const program = pipe(
        configManager.getConfigEffect(),
        Effect.catchAll((error) => {
          if (error instanceof ConfigError) {
            return Effect.succeed({
              jiraUrl: 'https://default.atlassian.net',
              email: 'default@example.com',
              apiToken: 'default-token',
            } as Config);
          }
          return Effect.fail(error);
        }),
      );

      const result = await Effect.runPromiseExit(program);

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value.jiraUrl).toBe('https://default.atlassian.net');
      }
    });

    it('should handle specific error types with catchTag', async () => {
      const configPath = join(tempDir, 'config.json');
      writeFileSync(configPath, 'invalid json', 'utf-8');

      const program = pipe(
        configManager.getConfigEffect(),
        Effect.catchTag('ParseError', () =>
          Effect.succeed({
            jiraUrl: 'https://fallback.atlassian.net',
            email: 'fallback@example.com',
            apiToken: 'fallback-token',
          } as Config),
        ),
      );

      const result = await Effect.runPromiseExit(program);

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value.jiraUrl).toBe('https://fallback.atlassian.net');
      }
    });

    it('should retry on failure', async () => {
      let attempts = 0;
      const configPath = join(tempDir, 'config.json');

      const programWithRetry = pipe(
        Effect.sync(() => {
          attempts++;
          if (attempts === 1) {
            // First attempt: no file
            if (existsSync(configPath)) {
              rmSync(configPath);
            }
          } else {
            // Second attempt: create valid config
            writeFileSync(
              configPath,
              JSON.stringify({
                jiraUrl: 'https://retry.atlassian.net',
                email: 'retry@example.com',
                apiToken: 'retry-token',
              }),
              'utf-8',
            );
          }
        }),
        Effect.flatMap(() => configManager.getConfigEffect()),
        Effect.retry({
          times: 2,
        }),
      );

      const result = await Effect.runPromiseExit(programWithRetry);

      expect(attempts).toBe(2);
      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value.jiraUrl).toBe('https://retry.atlassian.net');
      }
    });
  });

  describe('Settings management with Effects', () => {
    it('should manage settings with Effect patterns', async () => {
      const setSettingEffect = (key: string, value: string) =>
        Effect.tryPromise({
          try: () => configManager.setSetting(key, value),
          catch: (error) => new FileError(`Failed to save setting: ${error}`),
        });

      const getSettingEffect = (key: string) =>
        Effect.tryPromise({
          try: () => configManager.getSetting(key),
          catch: (error) => new FileError(`Failed to get setting: ${error}`),
        });

      const program = pipe(
        setSettingEffect('askModel', 'claude-3-opus'),
        Effect.flatMap(() => setSettingEffect('embeddingModel', 'text-embedding-3-small')),
        Effect.flatMap(() => getSettingEffect('askModel')),
        Effect.zip(getSettingEffect('embeddingModel')),
      );

      const result = await Effect.runPromiseExit(program);

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        const [askModel, embeddingModel] = result.value;
        expect(askModel).toBe('claude-3-opus');
        expect(embeddingModel).toBe('text-embedding-3-small');
      }
    });
  });

  describe('Meilisearch index prefix', () => {
    it('should derive index prefix from email', async () => {
      const config: Config = {
        jiraUrl: 'https://test.atlassian.net',
        email: 'john.doe+test@example.com',
        apiToken: 'token',
      };

      await configManager.setConfig(config);

      const prefix = await configManager.getMeilisearchIndexPrefix();
      // Should sanitize email local part
      expect(prefix).toBe('john_doe_test');
    });

    it('should use custom prefix from settings', async () => {
      await configManager.setSetting('meilisearchIndexPrefix', 'custom_prefix');

      const prefix = await configManager.getMeilisearchIndexPrefix();
      expect(prefix).toBe('custom_prefix');
    });

    it('should fallback to default when no config exists', async () => {
      const prefix = await configManager.getMeilisearchIndexPrefix();
      expect(prefix).toBe('ji');
    });
  });

  describe('Security and permissions', () => {
    it('should create config with restricted permissions', async () => {
      const config: Config = {
        jiraUrl: 'https://secure.atlassian.net',
        email: 'secure@example.com',
        apiToken: 'secure-token',
      };

      await configManager.setConfig(config);

      const configPath = join(tempDir, 'config.json');
      const fs = require('node:fs');
      const stats = fs.statSync(configPath);
      const mode = stats.mode & 0o777;

      // Check no world/group read permissions
      expect(mode & 0o077).toBe(0);
    });

    it('should create settings with restricted permissions', async () => {
      await configManager.setSetting('testKey', 'testValue');

      const settingsPath = join(tempDir, 'settings.json');
      const fs = require('node:fs');
      const stats = fs.statSync(settingsPath);
      const mode = stats.mode & 0o777;

      // Check no world/group read permissions
      expect(mode & 0o077).toBe(0);
    });
  });
});
