// Mock configuration for tests
export const mockConfig = {
  jiraUrl: 'https://example.atlassian.net',
  email: 'test@example.com',
  apiToken: 'mock-token',
  userId: 'test-user-id',
};

// Helper to capture console output
export function captureConsoleOutput() {
  let output = '';
  let errorOutput = '';

  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    output += `${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))).join(' ')}\n`;
  };

  console.error = (...args: unknown[]) => {
    errorOutput += `${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))).join(' ')}\n`;
  };

  return {
    getOutput: () => output,
    getErrorOutput: () => errorOutput,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// Helper to run CLI command in test environment
export async function runCLICommand(commandFn: () => Promise<void>) {
  const capture = captureConsoleOutput();

  try {
    await commandFn();
    return {
      output: capture.getOutput(),
      errorOutput: capture.getErrorOutput(),
      exitCode: 0,
    };
  } catch (error) {
    return {
      output: capture.getOutput(),
      errorOutput: capture.getErrorOutput(),
      error,
      exitCode: 1,
    };
  } finally {
    capture.restore();
  }
}

import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Get a working temp directory, falling back to project directory if system tmp has issues
 */
function getTempDir(): string {
  try {
    // Try system tmp first
    const systemTmp = tmpdir();
    // Test if we can create a directory
    const testDir = join(systemTmp, `ji-test-${Date.now()}`);
    mkdirSync(testDir);
    rmSync(testDir, { recursive: true, force: true });
    return systemTmp;
  } catch {
    // Fall back to project .tmp directory
    const projectTmp = join(process.cwd(), '.tmp');
    if (!existsSync(projectTmp)) {
      mkdirSync(projectTmp, { recursive: true });
    }
    return projectTmp;
  }
}

/**
 * Creates a temporary directory with retry logic to handle macOS permission races
 */
function createTempDirWithRetry(prefix: string, maxRetries = 3): string {
  let lastError: Error | undefined;
  const baseTmpDir = getTempDir();

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Add random suffix to avoid collisions
      const uniquePrefix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`;
      return mkdtempSync(join(baseTmpDir, uniquePrefix));
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        // Wait a bit before retrying (exponential backoff)
        const delay = Math.min(10 * 2 ** i, 50);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }

  throw lastError || new Error('Failed to create temp directory');
}

/**
 * Removes a directory with retry logic to handle cleanup races
 */
function removeDirWithRetry(dir: string, maxRetries = 3): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return; // Success
    } catch (_error) {
      if (i < maxRetries - 1) {
        // Wait before retrying
        const delay = Math.min(10 * 2 ** i, 50);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }
}

/**
 * Helper to isolate test environment for ConfigManager tests
 * Creates a temporary directory and sets JI_CONFIG_DIR to it
 * Returns a cleanup function that must be called in afterEach or finally
 */
export function isolateTestEnvironment(): {
  tempDir: string;
  cleanup: () => void;
} {
  const originalConfigDir = process.env.JI_CONFIG_DIR;
  const tempDir = createTempDirWithRetry('ji-test');

  process.env.JI_CONFIG_DIR = tempDir;

  const cleanup = () => {
    // Restore original environment
    if (originalConfigDir === undefined) {
      delete process.env.JI_CONFIG_DIR;
    } else {
      process.env.JI_CONFIG_DIR = originalConfigDir;
    }

    // Clean up temp directory with retry
    removeDirWithRetry(tempDir);
  };

  return { tempDir, cleanup };
}

/**
 * Helper to save and restore environment variables
 */
export class EnvironmentSaver {
  private saved: Map<string, string | undefined> = new Map();

  save(key: string): void {
    this.saved.set(key, process.env[key]);
  }

  restore(): void {
    for (const [key, value] of this.saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    this.saved.clear();
  }
}
