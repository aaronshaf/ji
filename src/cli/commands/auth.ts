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
const saveConfig = (config: { jiraUrl: string; email: string; apiToken: string }) =>
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
      const answer = await rl.question(prompt);
      return answer.trim() || defaultValue || '';
    },
    catch: (error) => new Error(`Failed to get user input: ${error}`),
  });

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

// Pure Effect-based auth implementation
const authEffect = (rl: readline.Interface) =>
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
                Effect.map((apiToken: string) => ({ jiraUrl, email, apiToken })),
              ),
            ),
          ),
        ),
      ),
    ),
    Effect.tap(() => Console.log('\nVerifying credentials...')),
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
    Effect.tap(() => Console.log(chalk.green('\nAuthentication saved successfully!'))),
    Effect.tap(() => Console.log('You can now use "ji sync" to sync your Jira data.')),
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

export async function auth() {
  const rl = readline.createInterface({ input, output });

  const program = authEffect(rl);

  try {
    await Effect.runPromise(program);
  } finally {
    rl.close();
  }
}
