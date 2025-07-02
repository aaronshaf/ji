import { Effect, pipe } from 'effect';
import chalk from 'chalk';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

export async function auth() {
  const rl = readline.createInterface({ input, output });

  const program = Effect.tryPromise({
    try: async () => {
      const jiraUrl = await rl.question('Jira URL (e.g., https://company.atlassian.net): ');
      const email = await rl.question('Email: ');
      const apiToken = await rl.question('API Token: ');

      const config = {
        jiraUrl: jiraUrl.endsWith('/') ? jiraUrl.slice(0, -1) : jiraUrl,
        email,
        apiToken,
      };

      // Test the authentication
      console.log('\nVerifying credentials...');
      new JiraClient(config);

      // Test API call - get current user
      const response = await fetch(`${config.jiraUrl}/rest/api/3/myself`, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      const user = await response.json();
      // Type guard for the user object
      if (typeof user === 'object' && user !== null && 'displayName' in user && 'emailAddress' in user) {
        console.log(chalk.green(`Successfully authenticated as ${user.displayName} (${user.emailAddress})`));
      } else {
        console.log(chalk.green('Successfully authenticated'));
      }

      // Save config after successful verification
      const configManager = new ConfigManager();
      await configManager.setConfig(config);
      configManager.close();
      
      console.log(chalk.green('\nAuthentication saved successfully!'));
      console.log('You can now use "ji issue view <issue-key>" to view issues.');
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

  await Effect.runPromise(program).finally(() => rl.close());
}