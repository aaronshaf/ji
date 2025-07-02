import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { ContentManager } from '../../lib/content-manager.js';
import { type Issue, JiraClient } from '../../lib/jira-client.js';
import { formatSmartDate } from '../../lib/utils/date-formatter.js';
import { formatDescription } from '../formatters/issue.js';

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
const refreshInBackgroundEffect = (_config: { jiraUrl: string }, issue: Issue) =>
  Effect.tryPromise({
    try: async () => {
      // Background refresh logic would go here
      // For now, just a placeholder
      const args = ['internal-refresh', issue.key, issue.fields.project?.key || 'unknown'];
      // Would spawn a background process here
      return args;
    },
    catch: (error) => new Error(`Failed to trigger background refresh: ${error}`),
  });

// Effect for formatting issue output in YAML format
const formatIssueOutputEffect = (issue: Issue, config: { jiraUrl: string }) =>
  Effect.sync(() => {
    // YAML output with color highlighting (matching search results)
    console.log(`${chalk.cyan('type:')} issue`);
    console.log(`${chalk.cyan('key:')} ${chalk.bold(issue.key)}`);
    console.log(`${chalk.cyan('link:')} ${config.jiraUrl}/browse/${issue.key}`);
    console.log(`${chalk.cyan('title:')} ${issue.fields.summary}`);
    console.log(`${chalk.cyan('updated:')} ${chalk.dim(formatSmartDate(issue.fields.updated))}`);
    console.log(`${chalk.cyan('created:')} ${chalk.dim(formatSmartDate(issue.fields.created))}`);

    // Status with colors
    const statusColor =
      issue.fields.status.name.toLowerCase() === 'closed' || issue.fields.status.name.toLowerCase() === 'done'
        ? chalk.gray
        : issue.fields.status.name.toLowerCase() === 'open' || issue.fields.status.name.toLowerCase() === 'in progress'
          ? chalk.green
          : chalk.yellow;
    console.log(`${chalk.cyan('status:')} ${statusColor(issue.fields.status.name)}`);

    // Priority with colors
    if (issue.fields.priority) {
      const priority = issue.fields.priority.name;
      const priorityColor =
        priority === 'P1' || priority === 'P2' || priority === 'Highest' || priority === 'High'
          ? chalk.red
          : priority === 'P3' || priority === 'Medium'
            ? chalk.yellow
            : chalk.gray;
      console.log(`${chalk.cyan('priority:')} ${priorityColor(priority)}`);
    }

    // Reporter before Assignee
    console.log(`${chalk.cyan('reporter:')} ${issue.fields.reporter.displayName}`);

    if (issue.fields.assignee) {
      console.log(`${chalk.cyan('assignee:')} ${issue.fields.assignee.displayName}`);
    } else {
      console.log(`${chalk.cyan('assignee:')} ${chalk.dim('Unassigned')}`);
    }

    // Sprint information
    const sprintField =
      issue.fields.customfield_10020 ||
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
        } else if (sprintInfo && typeof sprintInfo === 'object' && 'name' in sprintInfo) {
          sprintName = (sprintInfo as { name: string }).name;
        }
      } else if (sprintField && typeof sprintField === 'object' && 'name' in sprintField) {
        sprintName = (sprintField as { name: string }).name;
      }
      console.log(`${chalk.cyan('sprint:')} ${chalk.magenta(sprintName)}`);
    }

    // Labels
    if (issue.fields.labels && issue.fields.labels.length > 0) {
      console.log(`${chalk.cyan('labels:')} ${issue.fields.labels.map((l: string) => chalk.cyan(l)).join(', ')}`);
    }

    // Description
    const description = formatDescription(issue.fields.description);
    if (description.trim()) {
      // Truncate description similar to search results
      const cleanDescription = description.replace(/\s+/g, ' ').trim();

      const maxLength = 300;
      let truncated = cleanDescription;
      if (cleanDescription.length > maxLength) {
        const lastSpace = cleanDescription.lastIndexOf(' ', maxLength);
        truncated = `${cleanDescription.substring(0, lastSpace > 0 ? lastSpace : maxLength)}...`;
      }

      console.log(`${chalk.cyan('description:')} |`);
      console.log(`  ${chalk.gray(truncated)}`);
    }

    // Comments (if any recent ones)
    if (
      issue.fields.comment &&
      typeof issue.fields.comment === 'object' &&
      'comments' in issue.fields.comment &&
      Array.isArray((issue.fields.comment as { comments: unknown[] }).comments) &&
      (issue.fields.comment as { comments: unknown[] }).comments.length > 0
    ) {
      const comments = (
        issue.fields.comment as { comments: { author: { displayName: string }; created: string; body: unknown }[] }
      ).comments;

      if (comments.length > 0) {
        console.log(`${chalk.cyan('comments:')} ${comments.length}`);
        console.log(`${chalk.cyan('latest_comment:')} |`);
        const latest = comments[comments.length - 1];
        console.log(
          `  ${chalk.gray(`${latest.author.displayName} (${formatSmartDate(latest.created)}): ${formatDescription(latest.body).replace(/\s+/g, ' ').trim().slice(0, 150)}...`)}`,
        );
      }
    }
  });

// Pure Effect-based viewIssue implementation - local-first approach
const viewIssueEffect = (issueKey: string, options: { json?: boolean; sync?: boolean } = {}) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, cacheManager, contentManager, jiraClient }) =>
      pipe(
        // First, try to get from cache (local-first approach)
        getCachedIssueEffect(cacheManager, issueKey),
        Effect.flatMap((cachedIssue) => {
          if (cachedIssue && !options.sync) {
            // We have cached data, use it immediately (local-first)
            return pipe(
              formatIssueOutputEffect(cachedIssue, config),
              // Optionally refresh in background for next time
              Effect.tap(() => refreshInBackgroundEffect(config, cachedIssue)),
              Effect.tap(() =>
                Effect.sync(() => {
                  cacheManager.close();
                  contentManager.close();
                  configManager.close();
                }),
              ),
            );
          } else {
            // No cached data or user requested fresh sync - fetch from API
            return pipe(
              getIssueFromJiraEffect(jiraClient, issueKey),
              Effect.flatMap((issue) =>
                pipe(
                  updateCacheEffect(cacheManager, issue),
                  Effect.flatMap(() => updateSearchIndexEffect(contentManager, issue)),
                  Effect.flatMap(() => formatIssueOutputEffect(issue, config)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      cacheManager.close();
                      contentManager.close();
                      configManager.close();
                    }),
                  ),
                ),
              ),
              Effect.catchAll((apiError) => {
                // API failed, try to use cache if we have it
                if (cachedIssue) {
                  return pipe(
                    Console.log(chalk.yellow('⚠️  Using cached data (API unavailable)')),
                    Effect.flatMap(() => formatIssueOutputEffect(cachedIssue, config)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        cacheManager.close();
                        contentManager.close();
                        configManager.close();
                      }),
                    ),
                  );
                } else {
                  // No cache and API failed
                  return pipe(
                    Effect.sync(() => {
                      cacheManager.close();
                      contentManager.close();
                      configManager.close();
                    }),
                    Effect.flatMap(() => Effect.fail(apiError)),
                  );
                }
              }),
            );
          }
        }),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red('Error:'), error.message),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function viewIssue(issueKey: string, options: { json?: boolean; sync?: boolean } = {}) {
  try {
    await Effect.runPromise(viewIssueEffect(issueKey, options));
  } catch (_error) {
    process.exit(1);
  }
}
