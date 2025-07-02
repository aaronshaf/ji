import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { ContentManager } from '../../lib/content-manager.js';
import { type Issue, JiraClient } from '../../lib/jira-client.js';

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

// Effect wrapper for syncing a batch of issues
const syncIssuesBatch = (issues: Issue[], cacheManager: CacheManager, contentManager: ContentManager) =>
  Effect.tryPromise({
    try: async () => {
      // Save issues using batch operation
      await cacheManager.saveIssuesBatchEffect(issues).pipe(Effect.runPromise);

      // Also update search index for each issue
      for (const issue of issues) {
        await contentManager.saveJiraIssue(issue);
      }

      return issues.length;
    },
    catch: (error) => new Error(`Failed to save issues batch: ${error}`),
  });

// Pure Effect-based syncJiraProject implementation
const syncJiraProjectEffect = (projectKey: string, options: { fresh?: boolean; clean?: boolean } = {}) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, cacheManager, contentManager, jiraClient }) =>
      pipe(
        // If clean flag is set, delete existing issues first
        options.clean
          ? pipe(
              Console.log(chalk.yellow('Cleaning existing issues...')),
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: () => cacheManager.deleteProjectIssues(projectKey),
                  catch: (error) => new Error(`Failed to clean existing issues: ${error}`),
                }),
              ),
            )
          : Effect.succeed(undefined),

        // Get the latest update time if not doing a clean sync
        Effect.flatMap(() => {
          if (options.clean || options.fresh) {
            return Effect.succeed(null);
          }
          return Effect.tryPromise({
            try: () => cacheManager.getLatestIssueUpdate(projectKey),
            catch: () => null, // If error, do full sync
          });
        }),

        // Build JQL query based on latest update
        Effect.map((latestUpdate) => {
          let jql = `project = ${projectKey}`;
          if (latestUpdate && !options.fresh) {
            // Add 1 minute overlap to catch any edge cases
            const updateDate = new Date(latestUpdate);
            updateDate.setMinutes(updateDate.getMinutes() - 1);
            const formattedDate = updateDate.toISOString().split('.')[0].replace('T', ' ');
            jql += ` AND updated >= "${formattedDate}"`;
          }
          jql += ' ORDER BY updated DESC';
          return jql;
        }),

        // Fetch and sync issues
        Effect.flatMap((jql) =>
          pipe(
            Console.log(chalk.cyan(`Syncing project ${projectKey}...`)),
            Effect.flatMap(() => {
              const isIncremental = jql.includes('updated >=');
              if (isIncremental) {
                return Console.log(chalk.dim('Performing incremental sync...'));
              } else {
                return Console.log(chalk.dim('Performing full sync...'));
              }
            }),
            Effect.flatMap(() => {
              let totalSynced = 0;
              const batchSize = 50;
              const issuesBatch: Issue[] = [];

              return pipe(
                jiraClient.getAllProjectIssuesEffect(projectKey, {
                  jql,
                  onProgress: (current, total) => {
                    // Show progress
                    process.stdout.write(`\r${chalk.cyan('Progress:')} ${current}/${total} issues fetched...`);
                  },
                }),
                Effect.flatMap((issues) =>
                  pipe(
                    Effect.sync(() => {
                      console.log(); // New line after progress
                      return issues;
                    }),
                    Effect.flatMap((issues) => {
                      // Process issues in batches
                      const effects: Effect.Effect<number, Error>[] = [];

                      for (let i = 0; i < issues.length; i += batchSize) {
                        const batch = issues.slice(i, i + batchSize);
                        effects.push(
                          pipe(
                            syncIssuesBatch(batch, cacheManager, contentManager),
                            Effect.tap((count) =>
                              Effect.sync(() => {
                                totalSynced += count;
                                process.stdout.write(
                                  `\r${chalk.green('Saved:')} ${totalSynced}/${issues.length} issues...`,
                                );
                              }),
                            ),
                          ),
                        );
                      }

                      return pipe(
                        Effect.all(effects, { concurrency: 1 }), // Sequential to avoid overwhelming the DB
                        Effect.map(() => issues.length),
                      );
                    }),
                  ),
                ),
              );
            }),
            Effect.tap((count) =>
              pipe(
                Effect.sync(() => console.log()), // New line
                Effect.flatMap(() =>
                  Console.log(chalk.green(`✓ Successfully synced ${count} issues from ${projectKey}`)),
                ),
              ),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                cacheManager.close();
                contentManager.close();
                configManager.close();
              }),
            ),
          ),
        ),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red('Sync failed:'), error instanceof Error ? error.message : String(error)),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function syncJiraProject(projectKey: string, options: { fresh?: boolean; clean?: boolean } = {}) {
  try {
    await Effect.runPromise(syncJiraProjectEffect(projectKey, options));
  } catch (_error) {
    process.exit(1);
  }
}

export async function syncWorkspaces(_options: { clean?: boolean } = {}) {
  console.log(chalk.yellow('syncWorkspaces - Not yet implemented'));
  console.log(chalk.dim('This will sync all your active workspaces in the future.'));
}

export async function syncConfluence(spaceKey: string, _options: { clean?: boolean } = {}) {
  console.log(chalk.yellow(`syncConfluence ${spaceKey} - Not yet implemented`));
  console.log(chalk.dim('Confluence sync functionality coming soon.'));
}
