import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from './config.js';
import { isolateTestEnvironment, EnvironmentSaver } from '../test/test-helpers.js';

describe('ConfigManager Extended Tests', () => {
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
    if (configManager?.close) {
      configManager.close();
    }
    cleanup();
  });

  describe('Authentication Management', () => {
    it('should save and retrieve auth configuration', async () => {
      const authData = {
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token-123',
      };

      await configManager.setConfig(authData);
      const retrieved = await configManager.getConfig();

      expect(retrieved).toEqual(authData);
    });

    it('should update existing configuration', async () => {
      const initialAuth = {
        jiraUrl: 'https://old.atlassian.net',
        email: 'old@example.com',
        apiToken: 'old-token',
      };

      await configManager.setConfig(initialAuth);

      const updatedAuth = {
        jiraUrl: 'https://new.atlassian.net',
        email: 'new@example.com',
        apiToken: 'new-token',
      };

      await configManager.setConfig(updatedAuth);
      const retrieved = await configManager.getConfig();

      expect(retrieved).toEqual(updatedAuth);
      expect(retrieved?.jiraUrl).toBe('https://new.atlassian.net');
    });

    it('should handle missing configuration gracefully', async () => {
      const config = await configManager.getConfig();
      expect(config).toBeNull();
    });

    it('should persist configuration across instances', async () => {
      const authData = {
        jiraUrl: 'https://persistent.atlassian.net',
        email: 'persist@example.com',
        apiToken: 'persist-token',
      };

      await configManager.setConfig(authData);
      configManager.close();

      // Create new instance
      const newConfigManager = new ConfigManager();
      const retrieved = await newConfigManager.getConfig();

      expect(retrieved).toEqual(authData);
      newConfigManager.close();
    });

    it('should handle close operation', () => {
      expect(() => {
        configManager.close();
      }).not.toThrow();

      // Should be able to close multiple times without error
      expect(() => {
        configManager.close();
      }).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON in auth config', async () => {
      const configPath = join(tempDir, 'config.json');
      writeFileSync(configPath, 'invalid json{', 'utf-8');

      const manager = new ConfigManager();
      const config = await manager.getConfig();

      // Should return null for invalid config
      expect(config).toBeNull();
      manager.close();
    });

    it('should create config directory if it does not exist', async () => {
      const nonExistentDir = join(tempDir, 'non-existent', 'nested', 'dir');
      const localEnvSaver = new EnvironmentSaver();
      localEnvSaver.save('JI_CONFIG_DIR');

      try {
        process.env.JI_CONFIG_DIR = nonExistentDir;

        const manager = new ConfigManager();
        await manager.setConfig({
          jiraUrl: 'https://test.atlassian.net',
          email: 'test@example.com',
          apiToken: 'test-token',
        });

        const config = await manager.getConfig();
        expect(config).not.toBeNull();
        expect(config?.jiraUrl).toBe('https://test.atlassian.net');

        manager.close();
      } finally {
        // Restore environment
        localEnvSaver.restore();

        // Clean up the created directory
        try {
          rmSync(nonExistentDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('Security', () => {
    it('should create config.json with restricted permissions', async () => {
      const authData = {
        jiraUrl: 'https://secure.atlassian.net',
        email: 'secure@example.com',
        apiToken: 'secure-token',
      };

      await configManager.setConfig(authData);

      const configPath = join(tempDir, 'config.json');
      const fs = require('node:fs');
      const stats = fs.statSync(configPath);

      // Check that file permissions are restrictive (owner read/write only)
      // On Unix-like systems, this would be 0600
      const mode = stats.mode & 0o777;

      // The file should not be world-readable
      expect(mode & 0o004).toBe(0);
    });
  });
});
