import { Effect, Console, pipe } from 'effect';
import chalk from 'chalk';
import { JiraClient, type Issue } from '../../lib/jira-client.js';
import { CacheManager } from '../../lib/cache.js';
import { ContentManager } from '../../lib/content-manager.js';
import { ConfigManager } from '../../lib/config.js';
import { formatDescription, getJiraStatusIcon } from '../formatters/issue.js';

// Effect wrapper for getting configuration and managers
const getManagersEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        const cacheManager = new CacheManager();
        const contentManager = new ContentManager();
        const jiraClient = new JiraClient(config);
        return { config, configManager, cacheManager, contentManager, jiraClient };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Effect wrapper for getting issue from Jira
const getIssueFromJiraEffect = (jiraClient: JiraClient, issueKey: string) =>
  Effect.tryPromise({
    try: () => jiraClient.getIssue(issueKey),
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

// Effect wrapper for updating cache
const updateCacheEffect = (cacheManager: CacheManager, issue: Issue) =>
  Effect.tryPromise({
    try: () => cacheManager.saveIssue(issue),
    catch: (error) => new Error(`Failed to update cache: ${error}`),
  });

// Effect wrapper for updating search index
const updateSearchIndexEffect = (contentManager: ContentManager, issue: Issue) =>
  Effect.tryPromise({
    try: () => contentManager.saveJiraIssue(issue),
    catch: (error) => new Error(`Failed to update search index: ${error}`),
  });

// Effect wrapper for getting cached issue
const getCachedIssueEffect = (cacheManager: CacheManager, issueKey: string) =>
  Effect.tryPromise({
    try: () => cacheManager.getIssue(issueKey),
    catch: (error) => new Error(`Failed to get cached issue: ${error}`),
  });

// Effect wrapper for background refresh
const refreshInBackgroundEffect = (config: { jiraUrl: string }, issue: Issue) =>
  Effect.tryPromise({
    try: async () => {
      // Background refresh logic would go here
      // For now, just a placeholder
      const args = ['internal-refresh', issue.key, issue.fields.project.key];
      // Would spawn a background process here
      return args;
    },
    catch: (error) => new Error(`Failed to trigger background refresh: ${error}`),
  });

// Effect for formatting issue output
const formatIssueOutputEffect = (issue: Issue) =>
  Effect.sync(() => {
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
      issue.fields.comment.comments.slice(-3).forEach((comment: { author: { displayName: string }; created: string; body: unknown }) => {
        console.log(chalk.dim('─'.repeat(30)));
        console.log(chalk.cyan(comment.author.displayName) + ' - ' + chalk.dim(new Date(comment.created).toLocaleString()));
        console.log(formatDescription(comment.body));
      });
    }
  });

// Pure Effect-based viewIssue implementation
const viewIssueEffect = (issueKey: string, _options: { json?: boolean, sync?: boolean } = {}) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, cacheManager, contentManager, jiraClient }) =>
      pipe(
        getIssueFromJiraEffect(jiraClient, issueKey),
        Effect.flatMap((issue) =>
          pipe(
            updateCacheEffect(cacheManager, issue),
            Effect.flatMap(() => updateSearchIndexEffect(contentManager, issue)),
            Effect.flatMap(() => formatIssueOutputEffect(issue)),
            Effect.flatMap(() => refreshInBackgroundEffect(config, issue)),
            Effect.tap(() => Effect.sync(() => {
              cacheManager.close();
              contentManager.close();
              configManager.close();
            }))
          )
        ),
        Effect.catchAll((error) => {
          // Try to get from cache on network error
          return pipe(
            getCachedIssueEffect(cacheManager, issueKey),
            Effect.flatMap((cachedIssue) => {
              if (cachedIssue) {
                return pipe(
                  Console.log(chalk.yellow('⚠️  Showing cached data (network error occurred)')),
                  Effect.flatMap(() => formatIssueOutputEffect(cachedIssue)),
                  Effect.tap(() => Effect.sync(() => {
                    cacheManager.close();
                    contentManager.close();
                    configManager.close();
                  }))
                );
              } else {
                return pipe(
                  Effect.sync(() => {
                    cacheManager.close();
                    contentManager.close();
                    configManager.close();
                  }),
                  Effect.flatMap(() => Effect.fail(error))
                );
              }
            }),
            Effect.catchAll(() => 
              pipe(
                Effect.sync(() => {
                  cacheManager.close();
                  contentManager.close();
                  configManager.close();
                }),
                Effect.flatMap(() => Effect.fail(error))
              )
            )
          );
        })
      )
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red('Error:'), error.message),
        Effect.flatMap(() => Effect.fail(error))
      )
    )
  );

export async function viewIssue(issueKey: string, options: { json?: boolean, sync?: boolean } = {}) {
  try {
    await Effect.runPromise(viewIssueEffect(issueKey, options));
  } catch (error) {
    process.exit(1);
  }
}