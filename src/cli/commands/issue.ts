import { Effect, pipe } from 'effect';
import chalk from 'chalk';
import { JiraClient, type Issue } from '../../lib/jira-client.js';
import { CacheManager } from '../../lib/cache.js';
import { ContentManager } from '../../lib/content-manager.js';
import { ConfigManager } from '../../lib/config.js';
import { formatDescription, getJiraStatusIcon } from '../formatters/issue.js';
import { formatTimeAgo } from '../formatters/time.js';

export async function viewIssue(issueKey: string, options: { json?: boolean, sync?: boolean } = {}) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const cacheManager = new CacheManager();
  const contentManager = new ContentManager();
  const jiraClient = new JiraClient(config);

  const program = Effect.tryPromise({
    try: async () => {
      const spinner = { stop: () => {} }; // ora spinner removed for now
      
      try {
        const issue = await jiraClient.getIssue(issueKey);
        spinner.stop();
        
        // Update cache
        await cacheManager.saveIssue(issue);
        
        // Update search index
        const transformed = await contentManager.saveJiraIssue(issue);
        
        formatIssueOutput(issue);
        
        // Trigger background refresh
        await refreshInBackground(config, issue);
      } catch (error: any) {
        spinner.stop();
        
        // Try to get from cache
        const cachedIssue = await cacheManager.getIssue(issueKey);
        if (cachedIssue) {
          console.log(chalk.yellow('⚠️  Showing cached data (network error occurred)'));
          formatIssueOutput(cachedIssue);
        } else {
          throw error;
        }
      }
    },
    catch: (error) => {
      if (error instanceof Error) {
        if (error.message.includes('404')) {
          return new Error(`Issue ${issueKey} not found`);
        }
        if (error.message.includes('401')) {
          return new Error('Authentication failed. Please run "ji auth" again.');
        }
        return error;
      }
      return new Error('Unknown error occurred');
    },
  });

  await Effect.runPromise(program).catch((error) => {
    console.error(chalk.red('Error:'), error.message);
    process.exit(1);
  }).finally(() => {
    cacheManager.close();
    contentManager.close();
  });
}

function formatIssueOutput(issue: Issue) {
  console.log('\n' + chalk.bold.blue(issue.key) + ' - ' + chalk.bold(issue.fields.summary));
  console.log(chalk.dim('─'.repeat(50)));
  
  console.log(chalk.gray('Status:') + ' ' + getJiraStatusIcon(issue.fields.status.name) + ' ' + issue.fields.status.name);
  
  if (issue.fields.assignee) {
    console.log(chalk.gray('Assignee:') + ' ' + issue.fields.assignee.displayName);
  } else {
    console.log(chalk.gray('Assignee:') + ' ' + chalk.dim('Unassigned'));
  }
  
  console.log(chalk.gray('Reporter:') + ' ' + issue.fields.reporter.displayName);
  
  if (issue.fields.priority) {
    console.log(chalk.gray('Priority:') + ' ' + issue.fields.priority.name);
  }
  
  console.log(chalk.gray('Created:') + ' ' + new Date(issue.fields.created).toLocaleString());
  console.log(chalk.gray('Updated:') + ' ' + new Date(issue.fields.updated).toLocaleString());
  
  if (issue.fields.labels && issue.fields.labels.length > 0) {
    console.log(chalk.gray('Labels:') + ' ' + issue.fields.labels.map((l: string) => chalk.cyan(`[${l}]`)).join(' '));
  }
  
  const sprintField = issue.fields.customfield_10020 || 
                    issue.fields.customfield_10021 || 
                    issue.fields.customfield_10016 ||
                    issue.fields.customfield_10018 ||
                    issue.fields.customfield_10019;
  
  if (sprintField) {
    let sprintName = 'Unknown Sprint';
    if (Array.isArray(sprintField) && sprintField.length > 0) {
      const sprintInfo = sprintField[0];
      if (typeof sprintInfo === 'string' && sprintInfo.includes('name=')) {
        const match = sprintInfo.match(/name=([^,\]]+)/);
        if (match) sprintName = match[1];
      } else if (sprintInfo.name) {
        sprintName = sprintInfo.name;
      }
    } else if (sprintField.name) {
      sprintName = sprintField.name;
    }
    console.log(chalk.gray('Sprint:') + ' ' + chalk.magenta(sprintName));
  }
  
  console.log('\n' + chalk.gray('Description:'));
  const description = formatDescription(issue.fields.description);
  console.log(description);
  
  if (issue.fields.comment && issue.fields.comment.comments && issue.fields.comment.comments.length > 0) {
    console.log('\n' + chalk.gray('Recent Comments:'));
    issue.fields.comment.comments.slice(-3).forEach((comment: any) => {
      console.log(chalk.dim('─'.repeat(30)));
      console.log(chalk.cyan(comment.author.displayName) + ' - ' + chalk.dim(new Date(comment.created).toLocaleString()));
      console.log(formatDescription(comment.body));
    });
  }
}

async function refreshInBackground(config: any, issue: Issue) {
  // Background refresh logic would go here
  // For now, just a placeholder
  const args = ['internal-refresh', issue.key, issue.fields.project.key];
  // Would spawn a background process here
}