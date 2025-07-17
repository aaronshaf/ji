import chalk from 'chalk';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

// Extract just the takeIssue function from the old implementation
export async function takeIssue(issueKey: string) {
  const configManager = new ConfigManager();
  try {
    const config = await configManager.getConfig();
    if (!config) {
      console.error(chalk.red('No configuration found. Please run "ji auth" first.'));
      process.exit(1);
    }

    const client = new JiraClient(config);

    // Get current user to get the account ID
    const currentUser = await client.getCurrentUser();

    console.log(chalk.dim(`Assigning ${issueKey} to ${currentUser.displayName}...`));

    await client.assignIssue(issueKey, currentUser.accountId);

    console.log(chalk.green(`✓ Assigned ${issueKey} to you`));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  } finally {
    configManager.close();
  }
}
