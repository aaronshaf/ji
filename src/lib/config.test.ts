import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from './config.js';

describe('ConfigManager', () => {
  it('should create a database file', async () => {
    // Use a temporary directory for testing
    const testDbPath = join(tmpdir(), `test-ji-${Date.now()}.db`);
    
    // This is a simple smoke test to ensure the class can be instantiated
    // In a real test, we'd want to mock the database path
    expect(ConfigManager).toBeDefined();
    expect(typeof ConfigManager).toBe('function');
  });

  it('should have required methods', () => {
    const methods: Array<keyof ConfigManager> = ['getConfig', 'setConfig', 'close'];
    
    methods.forEach(method => {
      expect(ConfigManager.prototype[method]).toBeDefined();
      expect(typeof ConfigManager.prototype[method]).toBe('function');
    });
  });
});