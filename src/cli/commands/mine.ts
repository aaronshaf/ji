import { Effect } from 'effect';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { CacheManager } from '../../lib/cache.js';
import { getJiraStatusIcon } from '../formatters/issue.js';
import Bun from 'bun';

export async function showMyIssues() {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const cacheManager = new CacheManager();
  
  const program = Effect.tryPromise({
    try: async () => {
      // Get cached issues immediately for instant display
      const issues = await cacheManager.listMyOpenIssues(config.email);

      if (issues.length === 0) {
        console.log('No open issues assigned to you.');
        console.log(chalk.dim('💡 Run "ji sync" to update your workspaces.'));
        return;
      }

      // Group by project
      const byProject: Record<string, typeof issues> = {};
      issues.forEach((issue) => {
        if (!byProject[issue.project_key]) {
          byProject[issue.project_key] = [];
        }
        byProject[issue.project_key].push(issue);
      });

      // Display by project
      const projectEntries = Object.entries(byProject);
      projectEntries.forEach(([projectKey, projectIssues], index) => {
        console.log(chalk.bold.blue(`${projectKey} (${projectIssues.length} issues):`));

        projectIssues.forEach((issue) => {
          const statusIcon = getJiraStatusIcon(issue.status);
          const updated = new Date(issue.updated);
          const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
          const timeStr = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;

          console.log(`  ${statusIcon} ${chalk.bold(issue.key)}: ${issue.summary}`);
          console.log(`     ${chalk.dim(`Updated ${timeStr} • Priority: ${issue.priority || 'None'}`)}`);
        });

        // Only add blank line between projects, not after the last one
        if (index < projectEntries.length - 1) {
          console.log();
        }
      });

      // Check if data might be stale and trigger background refresh if needed
      const projectKeys = Object.keys(byProject);
      if (projectKeys.length > 0) {
        // Check when we last synced these projects
        const now = Date.now();
        const staleThreshold = 60 * 60 * 1000; // 1 hour

        for (const projectKey of projectKeys) {
          const lastSync = await cacheManager.getProjectLastSync(projectKey);

          if (!lastSync || now - lastSync.getTime() > staleThreshold) {
            // Data is stale, trigger background refresh
            triggerBackgroundSync(projectKey);
            break; // Only trigger one background sync to avoid overload
          }
        }
      }
    },
    catch: (error) => {
      console.error(`Failed to retrieve issues: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    },
  });

  await Effect.runPromise(program).finally(() => {
    cacheManager.close();
    configManager.close();
  });
}

// Trigger a background sync for a specific project
function triggerBackgroundSync(projectKey: string) {
  // Use Bun's subprocess to run the sync in background
  // This won't block the current process
  const subprocess = Bun.spawn([
    process.execPath,
    process.argv[1],
    'issue',
    'sync',
    projectKey
  ], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
    env: process.env
  });
  
  // Detach the subprocess so it runs independently
  subprocess.unref();
}

export async function takeIssue(issueKey: string) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const jiraClient = new JiraClient(config);
  const spinner = ora(`Taking ownership of ${issueKey}...`).start();

  const program = Effect.tryPromise({
    try: async () => {
      // Get current user info
      const currentUser = await jiraClient.getCurrentUser();
      
      // Get the issue to verify it exists and show current assignee
      const issue = await jiraClient.getIssue(issueKey);
      
      if (issue.fields.assignee?.displayName === currentUser.displayName) {
        spinner.warn(`You already own ${issueKey}`);
        return;
      }
      
      // Assign the issue
      await jiraClient.assignIssue(issueKey, currentUser.accountId);
      
      spinner.succeed(`Successfully assigned ${issueKey} to ${currentUser.displayName}`);
      
      // Show issue details
      console.log(`\n${chalk.bold(issue.key)}: ${issue.fields.summary}`);
      console.log(`${chalk.dim('Status:')} ${issue.fields.status.name}`);
      if (issue.fields.assignee) {
        console.log(`${chalk.dim('Previous assignee:')} ${issue.fields.assignee.displayName}`);
      }
      console.log(`${chalk.dim('Now assigned to:')} ${chalk.green(currentUser.displayName)}`);
      
      // Sync the issue to update local cache, search index, and embeddings
      spinner.start('Updating local cache...');
      try {
        const cacheManager = new CacheManager();
        
        // Get fresh issue data
        const updatedIssue = await jiraClient.getIssue(issueKey);
        
        // Save to cache - this automatically:
        // 1. Updates the issues table
        // 2. Updates searchable_content table
        // 3. Updates FTS index
        // 4. Updates Meilisearch index
        // 5. Spawns background embedding generation
        await cacheManager.saveIssue(updatedIssue);
        
        cacheManager.close();
        spinner.succeed('Local cache, search index, and embeddings updated');
      } catch (syncError) {
        spinner.warn('Failed to update local cache (will sync on next view)');
      }
      
    },
    catch: (error) => {
      spinner.fail(`Failed to take issue: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    },
  });

  await Effect.runPromise(program).finally(() => {
    configManager.close();
  });
}