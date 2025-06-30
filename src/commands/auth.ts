import { Command, Flags } from '@oclif/core';
import { ConfigManager } from '../lib/config.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export default class Auth extends Command {
  static description = 'Authenticate with Jira';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
  ];

  static flags = {
    'jira-url': Flags.string({
      description: 'Jira instance URL',
    }),
    email: Flags.string({
      description: 'Your Jira email',
    }),
    'api-token': Flags.string({
      description: 'Your Jira API token',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Auth);
    const rl = readline.createInterface({ input, output });

    try {
      const jiraUrl = flags['jira-url'] || await rl.question('Jira URL (e.g., https://company.atlassian.net): ');
      const email = flags.email || await rl.question('Email: ');
      const apiToken = flags['api-token'] || await rl.question('API Token: ');

      const configManager = new ConfigManager();
      await configManager.setConfig({
        jiraUrl: jiraUrl.endsWith('/') ? jiraUrl.slice(0, -1) : jiraUrl,
        email,
        apiToken,
      });

      this.log('✅ Authentication saved successfully!');
      this.log('\nYou can now use "ji issue view <issue-key>" to view issues.');
      
      configManager.close();
    } finally {
      rl.close();
    }
  }
}