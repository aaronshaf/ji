import Bun from 'bun';
import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
import ora from 'ora';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { getJiraStatusIcon } from '../formatters/issue.js';

// Effect wrapper for getting configuration
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        return { config, configManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Effect wrapper for getting cached issues
const getCachedIssuesEffect = (email: string) =>
  Effect.tryPromise({
    try: async () => {
      const cacheManager = new CacheManager();
      try {
        return { issues: await cacheManager.listMyOpenIssues(email), cacheManager };
      } catch (error) {
        cacheManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get cached issues: ${error}`),
  });

// Effect wrapper for checking stale data and triggering sync
const checkStaleDataEffect = (projectKeys: string[], cacheManager: CacheManager) =>
  Effect.tryPromise({
    try: async () => {
      if (projectKeys.length === 0) return;

      const now = Date.now();
      const staleThreshold = 60 * 60 * 1000; // 1 hour

      for (const projectKey of projectKeys) {
        const lastSync = await cacheManager.getProjectLastSync(projectKey);

        if (!lastSync || now - lastSync.getTime() > staleThreshold) {
          triggerBackgroundSync(projectKey);
          break; // Only trigger one background sync to avoid overload
        }
      }
    },
    catch: () => new Error('Failed to check stale data'),
  });

// Pure Effect-based showMyIssues implementation
const showMyIssuesEffect = () =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) =>
      pipe(
        getCachedIssuesEffect(config.email),
        Effect.flatMap(({ issues, cacheManager: cm }) => {
          if (issues.length === 0) {
            return pipe(
              Console.log('No open issues assigned to you.'),
              Effect.flatMap(() => Console.log(chalk.dim('💡 Run "ji sync" to update your workspaces.'))),
              Effect.tap(() =>
                Effect.sync(() => {
                  cm.close();
                  configManager.close();
                }),
              ),
            );
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
          const displayEffect = Effect.all(
            projectEntries.map(([projectKey, projectIssues], index) => {
              const projectHeader = Effect.sync(() => {
                console.log(chalk.bold.blue(`${projectKey} (${projectIssues.length} issues):`));
              });

              const issuesDisplay = Effect.all(
                projectIssues.map((issue) => {
                  return Effect.sync(() => {
                    const statusIcon = getJiraStatusIcon(issue.status);
                    const updated = new Date(issue.updated);
                    const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
                    const timeStr = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;

                    console.log(`  ${statusIcon} ${chalk.bold(issue.key)}: ${issue.summary}`);
                    console.log(`     ${chalk.dim(`Updated ${timeStr} • Priority: ${issue.priority || 'None'}`)}`);
                  });
                }),
              );

              const blankLine =
                index < projectEntries.length - 1 ? Effect.sync(() => console.log()) : Effect.succeed(undefined);

              return pipe(
                projectHeader,
                Effect.flatMap(() => issuesDisplay),
                Effect.flatMap(() => blankLine),
              );
            }),
          );

          return pipe(
            displayEffect,
            Effect.flatMap(() => checkStaleDataEffect(Object.keys(byProject), cm)),
            Effect.tap(() =>
              Effect.sync(() => {
                cm.close();
                configManager.close();
              }),
            ),
          );
        }),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error(`Failed to retrieve issues: ${error.message}`),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function showMyIssues() {
  try {
    await Effect.runPromise(showMyIssuesEffect());
  } catch (_error) {
    process.exit(1);
  }
}

// Trigger a background sync for a specific project
function triggerBackgroundSync(projectKey: string) {
  // Use Bun's subprocess to run the sync in background
  // This won't block the current process
  const subprocess = Bun.spawn([process.execPath, process.argv[1], 'issue', 'sync', projectKey], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
    env: process.env,
  });

  // Detach the subprocess so it runs independently
  subprocess.unref();
}

// Effect wrapper for getting current user
const getCurrentUserEffect = (jiraClient: JiraClient) =>
  Effect.tryPromise({
    try: () => jiraClient.getCurrentUser(),
    catch: (error) => new Error(`Failed to get current user: ${error}`),
  });

// Effect wrapper for getting issue
const getIssueEffect = (jiraClient: JiraClient, issueKey: string) =>
  Effect.tryPromise({
    try: () => jiraClient.getIssue(issueKey),
    catch: (error) => new Error(`Failed to get issue: ${error}`),
  });

// Effect wrapper for assigning issue
const assignIssueEffect = (jiraClient: JiraClient, issueKey: string, accountId: string) =>
  Effect.tryPromise({
    try: () => jiraClient.assignIssue(issueKey, accountId),
    catch: (error) => new Error(`Failed to assign issue: ${error}`),
  });

// Effect wrapper for updating cache
const updateCacheEffect = (jiraClient: JiraClient, issueKey: string) =>
  Effect.tryPromise({
    try: async () => {
      const cacheManager = new CacheManager();
      try {
        const updatedIssue = await jiraClient.getIssue(issueKey);
        await cacheManager.saveIssue(updatedIssue);
        return cacheManager;
      } catch (error) {
        cacheManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to update cache: ${error}`),
  });

// Pure Effect-based takeIssue implementation
const takeIssueEffect = (issueKey: string) =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) => {
      const jiraClient = new JiraClient(config);
      const spinner = ora(`Taking ownership of ${issueKey}...`).start();

      return pipe(
        getCurrentUserEffect(jiraClient),
        Effect.flatMap((currentUser) =>
          pipe(
            getIssueEffect(jiraClient, issueKey),
            Effect.flatMap((issue) => {
              if (issue.fields.assignee?.displayName === currentUser.displayName) {
                return pipe(
                  Effect.sync(() => {
                    spinner.warn(`You already own ${issueKey}`);
                    configManager.close();
                  }),
                );
              }

              return pipe(
                assignIssueEffect(jiraClient, issueKey, currentUser.accountId),
                Effect.tap(() =>
                  Effect.sync(() => {
                    spinner.succeed(`Successfully assigned ${issueKey} to ${currentUser.displayName}`);

                    console.log(`\n${chalk.bold(issue.key)}: ${issue.fields.summary}`);
                    console.log(`${chalk.dim('Status:')} ${issue.fields.status.name}`);
                    if (issue.fields.assignee) {
                      console.log(`${chalk.dim('Previous assignee:')} ${issue.fields.assignee.displayName}`);
                    }
                    console.log(`${chalk.dim('Now assigned to:')} ${chalk.green(currentUser.displayName)}`);

                    spinner.start('Updating local cache...');
                  }),
                ),
                Effect.flatMap(() => updateCacheEffect(jiraClient, issueKey)),
                Effect.tap((cacheManager) =>
                  Effect.sync(() => {
                    cacheManager.close();
                    spinner.succeed('Local cache, search index, and embeddings updated');
                  }),
                ),
                Effect.catchAll(() =>
                  Effect.sync(() => {
                    spinner.warn('Failed to update local cache (will sync on next view)');
                  }),
                ),
                Effect.tap(() => Effect.sync(() => configManager.close())),
              );
            }),
          ),
        ),
        Effect.catchAll((error) =>
          pipe(
            Effect.sync(() => {
              spinner.fail(`Failed to take issue: ${error.message}`);
              configManager.close();
            }),
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }),
  );

export async function takeIssue(issueKey: string) {
  try {
    await Effect.runPromise(takeIssueEffect(issueKey));
  } catch (_error) {
    process.exit(1);
  }
}
