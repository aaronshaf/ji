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
    Effect.flatMap(({ configManager, cacheManager, contentManager, jiraClient }) =>
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
            const formattedDate = updateDate.toISOString().split('.')[0].replace('T', ' ').substring(0, 16);
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
            // Track this project as a workspace
            Effect.tap(() =>
              Effect.tryPromise({
                try: () => cacheManager.trackWorkspace('jira_project', projectKey, projectKey),
                catch: (error) => new Error(`Failed to track workspace: ${error}`),
              }),
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

// Pure Effect-based syncWorkspaces implementation
const syncWorkspacesEffect = (options: { clean?: boolean } = {}) =>
  pipe(
    Effect.tryPromise({
      try: async () => {
        const cacheManager = new CacheManager();
        try {
          const workspaces = await cacheManager.getActiveWorkspaces();
          return { cacheManager, workspaces };
        } catch (error) {
          cacheManager.close();
          throw error;
        }
      },
      catch: (error) => new Error(`Failed to get active workspaces: ${error}`),
    }),
    Effect.flatMap(({ cacheManager, workspaces }) => {
      const jiraProjects = workspaces.filter((w) => w.type === 'jira_project');
      const confluenceSpaces = workspaces.filter((w) => w.type === 'confluence_space');

      if (workspaces.length === 0) {
        return pipe(
          Console.log(chalk.yellow('No active workspaces found.')),
          Effect.flatMap(() => Console.log(chalk.dim('Sync projects with: ji issue sync <project-key>'))),
          Effect.tap(() => Effect.sync(() => cacheManager.close())),
        );
      }

      return pipe(
        Console.log(chalk.bold('Active Workspaces:')),
        Effect.flatMap(() => {
          const effects: Effect.Effect<void, Error>[] = [];

          if (jiraProjects.length > 0) {
            effects.push(
              pipe(
                Console.log(chalk.cyan('\nJira Projects:')),
                Effect.flatMap(() =>
                  Effect.all(
                    jiraProjects.map((project) => {
                      const lastUsed = new Date(project.lastUsed).toLocaleDateString();
                      const usageInfo = chalk.dim(` (used ${project.usageCount} times, last: ${lastUsed})`);
                      return Console.log(`  ${chalk.bold(project.keyOrId)} - ${project.name}${usageInfo}`);
                    }),
                  ),
                ),
              ),
            );
          }

          if (confluenceSpaces.length > 0) {
            effects.push(
              pipe(
                Console.log(chalk.cyan('\nConfluence Spaces:')),
                Effect.flatMap(() =>
                  Effect.all(
                    confluenceSpaces.map((space) => {
                      const lastUsed = new Date(space.lastUsed).toLocaleDateString();
                      const usageInfo = chalk.dim(` (used ${space.usageCount} times, last: ${lastUsed})`);
                      return Console.log(`  ${chalk.bold(space.keyOrId)} - ${space.name}${usageInfo}`);
                    }),
                  ),
                ),
              ),
            );
          }

          return Effect.all(effects, { concurrency: 1 });
        }),
        Effect.flatMap(() => {
          // Auto-sync without prompting
          return pipe(
            Console.log(chalk.cyan('\nSyncing all Jira projects...')),
            Effect.flatMap(() =>
              Effect.all(
                jiraProjects.map((project, index) =>
                  pipe(
                    Console.log(chalk.dim(`\n[${index + 1}/${jiraProjects.length}] Syncing ${project.keyOrId}...`)),
                    Effect.flatMap(() => {
                      // Close current cache manager before syncing each project
                      cacheManager.close();
                      return syncJiraProjectEffect(project.keyOrId, options);
                    }),
                  ),
                ),
                { concurrency: 1 }, // Sync one at a time
              ),
            ),
            Effect.tap(() => Console.log(chalk.green('\n✓ All projects synced successfully!'))),
          );
        }),
        Effect.tap(() => Effect.sync(() => cacheManager.close())),
      );
    }),
    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red('Sync failed:'), error instanceof Error ? error.message : String(error)),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function syncWorkspaces(options: { clean?: boolean } = {}) {
  try {
    await Effect.runPromise(syncWorkspacesEffect(options));
  } catch (_error) {
    process.exit(1);
  }
}

export async function syncConfluence(spaceKey: string, _options: { clean?: boolean } = {}) {
  console.log(chalk.yellow(`syncConfluence ${spaceKey} - Not yet implemented`));
  console.log(chalk.dim('Confluence sync functionality coming soon.'));
}
