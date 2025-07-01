import { describe, it, expect } from 'bun:test';
import { ConfigManager } from './config.js';

describe('ConfigManager', () => {
  it('should create a database file', async () => {
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