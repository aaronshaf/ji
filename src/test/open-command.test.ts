import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCommand, setExecForTesting } from '../cli/commands/open';
import { isolateTestEnvironment } from './test-helpers.js';

// Keep track of exec calls
let execCalls: string[] = [];

// Mock exec for browser opening
const mockExec = ((command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  // Track the command for verification
  execCalls.push(command);
  // Simulate successful execution
  callback(null, '', '');
}) as any;

// Test directory setup
let testDir: string;
let testConfigPath: string;
let cleanup: () => void;

beforeEach(() => {
  // Set the mock exec for testing
  setExecForTesting(mockExec);

  // Create isolated test directory
  const env = isolateTestEnvironment();
  testDir = env.tempDir;
  cleanup = env.cleanup;
  testConfigPath = join(testDir, 'config.json');

  // Create test auth file inside the isolated directory
  const testAuth = {
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
    userId: 'test-user-id',
  };
  Bun.write(testConfigPath, JSON.stringify(testAuth, null, 2));

  // Set test environment
  process.env.JI_TEST_MODE = 'true';

  // Clear exec calls
  execCalls = [];
});

afterEach(() => {
  delete process.env.JI_TEST_MODE;
  delete process.env.ALLOW_REAL_API_CALLS;
  cleanup();

  // Clear exec calls
  execCalls = [];
});

test('ji open - opens cached issue in browser', async () => {
  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };

  try {
    await openCommand('TEST-123');

    // Verify console output (just the URL)
    expect(logs.some((log) => log.includes('https://test.atlassian.net/browse/TEST-123'))).toBe(true);

    // Verify browser command was called
    expect(execCalls.length).toBe(1);
    const command = execCalls[0];

    // Check platform-specific command
    if (process.platform === 'darwin') {
      expect(command).toBe('open "https://test.atlassian.net/browse/TEST-123"');
    } else if (process.platform === 'linux') {
      expect(command).toBe('xdg-open "https://test.atlassian.net/browse/TEST-123"');
    } else if (process.platform === 'win32') {
      expect(command).toBe('start "" "https://test.atlassian.net/browse/TEST-123"');
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('ji open - opens different issue key', async () => {
  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };

  try {
    await openCommand('PROJ-999');

    // Verify console output (just the URL)
    expect(logs.some((log) => log.includes('https://test.atlassian.net/browse/PROJ-999'))).toBe(true);

    // Verify browser command was called
    expect(execCalls.length).toBe(1);
    const command = execCalls[0];
    expect(command).toContain('https://test.atlassian.net/browse/PROJ-999');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('ji open - validates issue key format', async () => {
  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };

  try {
    // Test invalid formats
    await openCommand('invalid-key');
    expect(logs.some((log) => log.includes('Invalid issue key format: invalid-key'))).toBe(true);

    logs.length = 0; // Clear logs
    await openCommand('123');
    expect(logs.some((log) => log.includes('Invalid issue key format: 123'))).toBe(true);

    logs.length = 0; // Clear logs
    await openCommand('TEST_123');
    expect(logs.some((log) => log.includes('Invalid issue key format: TEST_123'))).toBe(true);

    // Verify no browser commands were called for invalid keys
    expect(execCalls.length).toBe(0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('ji open - handles missing configuration', async () => {
  // Create a new isolated environment for this test
  const env = isolateTestEnvironment();
  const isolatedDir = env.tempDir;
  const isolatedCleanup = env.cleanup;

  // Ensure no auth file exists in the isolated directory
  const isolatedConfigPath = join(isolatedDir, 'config.json');
  rmSync(isolatedConfigPath, { force: true });

  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };

  try {
    await openCommand('TEST-123');

    // Debug logging
    if (logs.length === 0) {
      console.warn('No logs captured from openCommand');
    }

    // Verify error message - be more flexible with the check
    const hasConfigError = logs.some(
      (log) => log.toLowerCase().includes('configuration') || log.toLowerCase().includes('config'),
    );

    if (!hasConfigError && logs.length > 0) {
      console.warn('Logs captured but no config error found:', logs);
    }

    expect(hasConfigError).toBe(true);

    const hasAuthMessage = logs.some((log) => log.toLowerCase().includes('auth'));
    expect(hasAuthMessage).toBe(true);

    // Verify no browser command was called
    expect(execCalls.length).toBe(0);
  } finally {
    console.log = originalLog;
    console.error = originalError;

    // Clean up isolated directory
    isolatedCleanup();
  }
});

test('ji open - converts lowercase keys to uppercase', async () => {
  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };

  try {
    await openCommand('test-123'); // lowercase input

    // Verify it was converted to uppercase
    expect(logs.some((log) => log.includes('https://test.atlassian.net/browse/TEST-123'))).toBe(true);

    // Verify browser command used uppercase
    expect(execCalls.length).toBe(1);
    const command = execCalls[0];
    expect(command).toContain('TEST-123');
    expect(command).not.toContain('test-123');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('ji open - handles trailing slash in jiraUrl', async () => {
  // Update auth with trailing slash
  const testAuth = {
    jiraUrl: 'https://test.atlassian.net/', // trailing slash
    email: 'test@example.com',
    apiToken: 'test-token',
    userId: 'test-user-id',
  };
  Bun.write(testConfigPath, JSON.stringify(testAuth, null, 2));

  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    logs.push(msg);
  };

  try {
    await openCommand('TEST-123');

    // Verify URL doesn't have double slash
    expect(logs.some((log) => log.includes('https://test.atlassian.net/browse/TEST-123'))).toBe(true);
    expect(logs.every((log) => !log.includes('https://test.atlassian.net//browse/'))).toBe(true);

    // Verify browser command
    const command = execCalls[0];
    expect(command).toContain('https://test.atlassian.net/browse/TEST-123');
    expect(command).not.toContain('//browse/');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('ji open - performance test for multiple opens', async () => {
  const startTime = performance.now();

  // Open multiple issues in sequence
  for (let i = 1; i <= 5; i++) {
    await openCommand(`TEST-${i}`);
  }

  const endTime = performance.now();
  const duration = endTime - startTime;

  // Should be fast even with multiple opens
  expect(duration).toBeLessThan(500); // 500ms for 5 opens
  expect(execCalls.length).toBe(5);

  console.log(`✅ Opened 5 issues in ${duration.toFixed(2)}ms`);
});
