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
