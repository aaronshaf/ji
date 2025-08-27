import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
import { ConfigManager } from '../../lib/config.js';

// Effect wrapper for HTTP requests
const verifyCredentials = (config: { jiraUrl: string; email: string; apiToken: string }) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${config.jiraUrl}/rest/api/3/myself`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    catch: (error) => {
      if (error instanceof Error) {
        if (error.message.includes('401')) {
          return new Error('Invalid credentials. Please check your email and API token.');
        }
        if (error.message.includes('ENOTFOUND')) {
          return new Error('Could not connect to Jira. Please check the URL.');
        }
        return error;
      }
      return new Error('Unknown error occurred');
    },
  });

// Effect wrapper for config operations
const saveConfig = (config: {
  jiraUrl: string;
  email: string;
  apiToken: string;
  analysisPrompt?: string;
  analysisCommand?: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        await configManager.setConfig(config);
        return config;
      } finally {
        configManager.close();
      }
    },
    catch: (error) => new Error(`Failed to save configuration: ${error}`),
  });

// Effect wrapper for readline operations with default value
const askQuestionWithDefault = (
  question: string,
  defaultValue: string | undefined,
  rl: readline.Interface,
  isSecret = false,
) =>
  Effect.tryPromise({
    try: async () => {
      let prompt: string;

      if (defaultValue && !isSecret) {
        prompt = `${question} ${chalk.dim(`[${defaultValue}]`)}: `;
      } else if (defaultValue && isSecret) {
        prompt = `${question} ${chalk.dim('[<hidden>]')}: `;
      } else {
        prompt = `${question}: `;
      }

      // For fields without defaults, use standard readline
      if (defaultValue === undefined || defaultValue === null) {
        const answer = await rl.question(prompt);
        return answer.trim();
      }

      // For fields with defaults, implement custom input handling
      return new Promise<string>((resolve) => {
        process.stdout.write(prompt);
        
        let buffer = '';
        let currentDefault: string | undefined = defaultValue;
        let deletePressed = false;
        
        // Enable raw mode to capture special keys
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        
        const cleanup = () => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
        };
        
        const onData = (chunk: Buffer) => {
          const key = chunk[0];
          
          // Delete/Backspace at start of input (to clear default)
          if ((key === 127 || key === 8) && buffer.length === 0 && !deletePressed) {
            // Clear the line and rewrite prompt without default
            const newPrompt = `${question}: `;
            process.stdout.write('\r\x1b[K' + newPrompt);
            // Mark that delete was pressed and clear the default
            deletePressed = true;
            currentDefault = undefined;
            return;
          }
          
          // Enter key
          if (key === 13 || key === 10) {
            process.stdout.write('\n');
            cleanup();
            // If delete was pressed and nothing typed, return empty string
            // Otherwise return buffer or the current default
            resolve(deletePressed && buffer === '' ? '' : (buffer || currentDefault || ''));
            return;
          }
          
          // Ctrl+C
          if (key === 3) {
            process.stdout.write('\n');
            cleanup();
            process.exit(0);
            return;
          }
          
          // Backspace (when buffer has content)
          if ((key === 127 || key === 8) && buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            // Clear line and rewrite with appropriate prompt
            const currentPrompt = deletePressed 
              ? `${question}: `
              : prompt;
            process.stdout.write('\r\x1b[K' + currentPrompt + buffer);
            return;
          }
          
          // Regular printable character
          const char = chunk.toString();
          if (char.length === 1 && char >= ' ' && char <= '~') {
            buffer += char;
            process.stdout.write(char);
          }
        };
        
        process.stdin.on('data', onData);
      });
    },
    catch: (error) => new Error(`Failed to get user input: ${error}`),
  });

// Helper to expand tilde in file paths
const expandTilde = (path: string): string => {
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
};

// Effect wrapper for validating analysis prompt file path
const validateAnalysisPromptFile = (
  path: string,
  existingPath: string | undefined,
  rl: readline.Interface,
): Effect.Effect<string, Error> => {
  // If path is empty, use default (no custom prompt)
  if (!path) {
    return Effect.succeed('');
  }

  // Expand tilde if present
  const expandedPath = expandTilde(path);

  // Check if file exists
  if (existsSync(expandedPath)) {
    return Effect.succeed(path); // Return the original path (with tilde) for storage
  }

  // File doesn't exist, prompt user for action
  return pipe(
    Console.error(chalk.red(`File not found: ${path}`)),
    Effect.flatMap(() =>
      askQuestionWithDefault(
        `Enter a valid path or press Enter for default`,
        existingPath || '',
        rl,
      ),
    ),
    Effect.flatMap((newPath) => {
      // If empty, use default (no custom prompt)
      if (!newPath) {
        return Effect.succeed('');
      }
      // Otherwise, validate the new path
      return validateAnalysisPromptFile(newPath, existingPath, rl);
    }),
  );
};

// Effect wrapper for getting existing config
const getExistingConfig = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        return config;
      } finally {
        configManager.close();
      }
    },
    catch: () => null, // Return null if no config exists
  });

// Pure Effect-based setup implementation
const setupEffect = (rl: readline.Interface) =>
  pipe(
    getExistingConfig(),
    Effect.flatMap((existingConfig) =>
      pipe(
        Console.log('\nJira & Confluence CLI Authentication Setup'),
        Effect.flatMap(() => {
          if (existingConfig) {
            return Console.log(chalk.dim('(Press Enter to keep existing values)\n'));
          }
          return Effect.succeed(undefined);
        }),
        Effect.flatMap(() =>
          askQuestionWithDefault('Jira URL (e.g., https://company.atlassian.net)', existingConfig?.jiraUrl, rl),
        ),
        Effect.map((jiraUrl: string) => (jiraUrl.endsWith('/') ? jiraUrl.slice(0, -1) : jiraUrl)),
        Effect.flatMap((jiraUrl) =>
          pipe(
            askQuestionWithDefault('Email', existingConfig?.email, rl),
            Effect.flatMap((email: string) =>
              pipe(
                askQuestionWithDefault('API Token', existingConfig?.apiToken, rl, true),
                Effect.flatMap((apiToken: string) =>
                  pipe(
                    Console.log(chalk.yellow('Optional: AI Analysis Configuration')),
                    Effect.flatMap(() =>
                      askQuestionWithDefault(
                        'Analysis tool command (e.g., claude, gemini, opencode)',
                        existingConfig?.analysisCommand || '',
                        rl,
                      ),
                    ),
                    Effect.flatMap((analysisCommand: string) =>
                      pipe(
                        askQuestionWithDefault(
                          'Path to custom analysis prompt file (optional)',
                          existingConfig?.analysisPrompt || '',
                          rl,
                        ),
                        Effect.flatMap((analysisPrompt: string) =>
                          validateAnalysisPromptFile(analysisPrompt, existingConfig?.analysisPrompt, rl),
                        ),
                        Effect.map((analysisPrompt: string) => ({
                          jiraUrl,
                          email,
                          apiToken,
                          ...(analysisCommand && { analysisCommand }),
                          ...(analysisPrompt && { analysisPrompt }),
                        })),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    Effect.tap(() => Console.log('Verifying credentials...')),
    Effect.flatMap((config) =>
      pipe(
        verifyCredentials(config),
        Effect.map((user) => ({ config, user })),
      ),
    ),
    Effect.tap(({ user }) => {
      // Type guard for the user object
      if (typeof user === 'object' && user !== null && 'displayName' in user && 'emailAddress' in user) {
        return Console.log(chalk.green(`Successfully authenticated as ${user.displayName} (${user.emailAddress})`));
      } else {
        return Console.log(chalk.green('Successfully authenticated'));
      }
    }),
    Effect.flatMap(({ config }) => saveConfig(config)),
    Effect.tap(() => Console.log(chalk.green('\nConfiguration saved successfully!'))),
    Effect.tap(() => Console.log('You can now use:')),
    Effect.tap(() => Console.log('  • "ji mine" to view your issues')),
    Effect.tap(() => Console.log('  • "ji analyze <ISSUE-KEY>" to analyze issues with AI')),
    Effect.catchAll((error) =>
      pipe(
        Console.error(
          chalk.red(`\nAuthentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`),
        ),
        Effect.flatMap(() => Console.error('Please check your credentials and try again.')),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function setup() {
  const rl = readline.createInterface({ input, output });

  const program = setupEffect(rl);

  try {
    await Effect.runPromise(program);
  } finally {
    rl.close();
  }
}
