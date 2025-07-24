import { exec as execOriginal } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { ConfigError, ConfigManager } from '../../lib/config';

// Allow exec to be overridden for testing
let exec = execOriginal;
export function setExecForTesting(mockExec: typeof execOriginal) {
  exec = mockExec;
}

const getExecAsync = () => promisify(exec);

// Custom error types
export class OpenCommandError extends Error {
  readonly _tag = 'OpenCommandError';
}

export class BrowserOpenError extends Error {
  readonly _tag = 'BrowserOpenError';
}

// Platform-specific browser open commands
const openCommands: Record<string, string> = {
  darwin: 'open',
  linux: 'xdg-open',
  win32: 'start',
};

// Effect to open URL in browser
const openUrlInBrowser = (url: string): Effect.Effect<void, BrowserOpenError> =>
  Effect.tryPromise({
    try: async () => {
      const platform = process.platform;
      const openCommand = openCommands[platform];

      if (!openCommand) {
        throw new Error(`Unsupported platform: ${platform}`);
      }

      // For Windows, we need to escape the URL
      const finalCommand = platform === 'win32' ? `${openCommand} "" "${url}"` : `${openCommand} "${url}"`;

      const execAsync = getExecAsync();
      await execAsync(finalCommand);
    },
    catch: (error) => new BrowserOpenError(`Failed to open browser: ${error}`),
  });

// Main command effect
const openIssueEffect = (issueKey: string): Effect.Effect<void, OpenCommandError | ConfigError | BrowserOpenError> =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new ConfigError('No configuration found. Run "ji auth" to set up authentication');
        }

        const jiraUrl = config.jiraUrl.replace(/\/$/, ''); // Remove trailing slash
        const issueUrl = `${jiraUrl}/browse/${issueKey}`;

        await Effect.runPromise(openUrlInBrowser(issueUrl));
        console.log(issueUrl);
      } finally {
        configManager.close();
      }
    },
    catch: (error) => {
      if (error instanceof ConfigError) return error;
      return new ConfigError(`Failed to load configuration: ${error}`);
    },
  });

// Error handler
const handleError = (error: OpenCommandError | ConfigError | BrowserOpenError): Effect.Effect<void> => {
  switch (error._tag) {
    case 'OpenCommandError':
      console.error(chalk.red(`Error: ${error.message}`));
      break;
    case 'ConfigError':
      console.error(chalk.red(`Configuration error: ${error.message}\nRun 'ji auth' to set up authentication`));
      break;
    case 'BrowserOpenError':
      console.error(chalk.red(`Browser error: ${error.message}`));
      break;
    default:
      console.error(chalk.red(`Unknown error: ${error}`));
  }
  return Effect.void;
};

// Validate issue key format
const validateIssueKey = (key: string): Effect.Effect<string, OpenCommandError> => {
  const uppercaseKey = key.toUpperCase();
  const issueKeyPattern = /^[A-Z]+-\d+$/;
  if (!issueKeyPattern.test(uppercaseKey)) {
    return Effect.fail(new OpenCommandError(`Invalid issue key format: ${key}. Expected format: PROJECT-123`));
  }
  return Effect.succeed(uppercaseKey);
};

// CLI command wrapper
export async function openCommand(issueKey: string): Promise<void> {
  await Effect.runPromise(
    pipe(validateIssueKey(issueKey), Effect.flatMap(openIssueEffect), Effect.catchAll(handleError)),
  );
}
