import { Effect, Console, pipe } from 'effect';
import chalk from 'chalk';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { ConfigManager } from '../../lib/config.js';

// Effect wrapper for readline operations
const askQuestion = (question: string, rl: readline.Interface) =>
  Effect.tryPromise({
    try: () => rl.question(question),
    catch: (error) => new Error(`Failed to get user input: ${error}`),
  });

// Effect wrapper for HTTP requests
const verifyCredentials = (config: { jiraUrl: string; email: string; apiToken: string }) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${config.jiraUrl}/rest/api/3/myself`, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
          'Accept': 'application/json',
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

// Pure Effect-based auth implementation
const authEffect = (rl: readline.Interface) =>
  pipe(
    Console.log('\nJira & Confluence CLI Authentication Setup'),
    Effect.flatMap(() => askQuestion('Jira URL (e.g., https://company.atlassian.net): ', rl)),
    Effect.map((jiraUrl: string) => jiraUrl.endsWith('/') ? jiraUrl.slice(0, -1) : jiraUrl),
    Effect.flatMap((jiraUrl) =>
      pipe(
        askQuestion('Email: ', rl),
        Effect.flatMap((email: string) =>
          pipe(
            askQuestion('API Token: ', rl),
            Effect.map((apiToken: string) => ({ jiraUrl, email, apiToken }))
          )
        )
      )
    ),
    Effect.tap(() => Console.log('\nVerifying credentials...')),
    Effect.flatMap((config) =>
      pipe(
        verifyCredentials(config),
        Effect.map((user) => ({ config, user }))
      )
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
    Effect.tap(() => Console.log('You can now use "ji issue view <issue-key>" to view issues.')),
    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red(`\nAuthentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`)),
        Effect.flatMap(() => Console.error('Please check your credentials and try again.')),
        Effect.flatMap(() => Effect.fail(error))
      )
    )
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