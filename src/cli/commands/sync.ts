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
          if (latestUpdate && !options.fresh && !options.clean) {
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
          const syncEffects: Effect.Effect<void, Error>[] = [];

          // Sync Jira projects
          if (jiraProjects.length > 0) {
            syncEffects.push(
              pipe(
                Console.log(chalk.cyan('\nSyncing all Jira projects...')),
                Effect.flatMap(() =>
                  Effect.all(
                    jiraProjects.map((project, index) =>
                      pipe(
                        Console.log(chalk.dim(`\n[${index + 1}/${jiraProjects.length}] Syncing ${project.keyOrId}...`)),
                        Effect.flatMap(() => {
                          // Close current cache manager before syncing each project
                          cacheManager.close();
                          return pipe(
                            syncJiraProjectEffect(project.keyOrId, options),
                            Effect.mapBoth({
                              onFailure: (error) => new Error(error instanceof Error ? error.message : String(error)),
                              onSuccess: () => undefined,
                            }),
                          );
                        }),
                      ),
                    ),
                    { concurrency: 1 }, // Sync one at a time
                  ),
                ),
                Effect.tap(() => Console.log(chalk.green('\n✓ All Jira projects synced successfully!'))),
                Effect.map(() => undefined), // Convert to void
              ),
            );
          }

          // Sync Confluence spaces
          if (confluenceSpaces.length > 0) {
            syncEffects.push(
              pipe(
                Console.log(chalk.cyan('\nSyncing all Confluence spaces...')),
                Effect.flatMap(() =>
                  Effect.all(
                    confluenceSpaces.map((space, index) =>
                      pipe(
                        Console.log(
                          chalk.dim(`\n[${index + 1}/${confluenceSpaces.length}] Syncing ${space.keyOrId}...`),
                        ),
                        Effect.flatMap(() =>
                          pipe(
                            syncConfluenceSpaceEffect(space.keyOrId, options),
                            Effect.mapBoth({
                              onFailure: (error) => new Error(error instanceof Error ? error.message : String(error)),
                              onSuccess: () => undefined,
                            }),
                          ),
                        ),
                      ),
                    ),
                    { concurrency: 1 }, // Sync one at a time
                  ),
                ),
                Effect.tap(() => Console.log(chalk.green('\n✓ All Confluence spaces synced successfully!'))),
                Effect.map(() => undefined), // Convert to void
              ),
            );
          }

          return pipe(
            Effect.all(syncEffects, { concurrency: 1 }),
            Effect.tap(() => Console.log(chalk.green('\n✓ All workspaces synced successfully!'))),
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

// Smart incremental sync with gap-filling strategy
const syncConfluenceSpaceEffect = (spaceKey: string, options: { clean?: boolean } = {}) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, contentManager }) =>
      Effect.tryPromise({
        try: async () => {
          const { ConfluenceClient } = await import('../../lib/confluence-client.js');
          const confluenceClient = new ConfluenceClient(config);

          // If clean flag is set, delete existing pages first
          if (options.clean) {
            console.log(chalk.yellow('Cleaning existing Confluence pages...'));
            await contentManager.deleteSpaceContent(spaceKey);
            console.log(chalk.cyan(`Starting fresh sync of Confluence space ${spaceKey}...`));
          } else {
            console.log(chalk.cyan(`Starting smart incremental sync of Confluence space ${spaceKey}...`));
          }

          let totalSynced = 0;
          const INITIAL_BATCH = 100; // Initial batch size
          const SAVE_BATCH_SIZE = 20; // Pages to save in parallel
          const FETCH_BATCH_SIZE = 50; // Pages to fetch in parallel
          let lastSyncTime: Date | null = null;

          // Strategy 1: Smart incremental sync
          if (!options.clean) {
            // Check when we last synced
            lastSyncTime = await contentManager.getLastSyncTime(spaceKey);

            if (lastSyncTime) {
              console.log(chalk.dim(`Last sync: ${lastSyncTime.toLocaleString()}`));
              console.log(chalk.dim('Checking for updates since last sync...'));

              // Get pages that have been updated since last sync
              const pageIds = await confluenceClient.getPagesSince(spaceKey, lastSyncTime, (count) => {
                process.stdout.write(`\r${chalk.cyan('Updated pages found:')} ${count}`);
              });
              console.log();

              if (pageIds.length > 0) {
                console.log(chalk.dim(`Fetching ${pageIds.length} updated pages...`));

                // Fetch pages in batches
                const pages = [];
                for (let i = 0; i < pageIds.length; i += 50) {
                  const batchIds = pageIds.slice(i, i + 50);
                  const batchPromises = batchIds.map((id) => confluenceClient.getPage(id));
                  const batchPages = await Promise.all(batchPromises);
                  pages.push(...batchPages);
                  process.stdout.write(`\r${chalk.cyan('Fetched:')} ${pages.length}/${pageIds.length} pages...`);
                }
                console.log();

                // Save pages
                console.log(chalk.dim('Saving updated pages...'));
                for (let i = 0; i < pages.length; i += SAVE_BATCH_SIZE) {
                  const batch = pages.slice(i, i + SAVE_BATCH_SIZE);

                  await Promise.all(
                    batch.map(async (page) => {
                      try {
                        await contentManager.saveContent({
                          id: `confluence:${page.id}`,
                          source: 'confluence',
                          type: 'page',
                          title: page.title,
                          content: page.body?.storage?.value || '',
                          url: page._links.webui,
                          spaceKey: page.space.key,
                          createdAt: new Date(page.version.when).getTime(),
                          updatedAt: new Date(page.version.when).getTime(),
                          syncedAt: Date.now(),
                        });
                      } catch (error) {
                        console.error(chalk.red(`Failed to save page ${page.id}: ${error}`));
                      }
                    }),
                  );
                  totalSynced += batch.length;
                  process.stdout.write(`\r${chalk.green('Saved:')} ${totalSynced} pages...`);
                }
                console.log();
              } else {
                console.log(chalk.dim('No updates found since last sync.'));
              }
            }
          }

          // Strategy 2: Metadata-first full sync for clean
          if (options.clean) {
            console.log(chalk.dim('Performing metadata-first full sync...'));

            // Step 1: Get ALL page metadata (fast!)
            console.log(chalk.dim('Fetching page metadata...'));
            const allMetadata = await confluenceClient.getAllPagesMetadata(spaceKey, (current, total) => {
              process.stdout.write(`\r${chalk.cyan('Metadata:')} ${current}/${total} pages...`);
            });
            console.log();
            console.log(chalk.green(`✓ Found ${allMetadata.length} pages`));

            if (allMetadata.length > 0) {
              // Step 2: Check what we already have locally
              console.log(chalk.dim('Comparing with local data...'));
              const localVersions = new Map<string, number>();

              // Get local page versions
              const stmt = contentManager.db.prepare(`
                SELECT id, metadata
                FROM searchable_content
                WHERE space_key = ? AND source = 'confluence'
              `);
              const localPages = stmt.all(spaceKey) as Array<{ id: string; metadata: string }>;

              for (const page of localPages) {
                try {
                  const metadata = JSON.parse(page.metadata || '{}');
                  if (metadata.version) {
                    localVersions.set(page.id.replace('confluence:', ''), metadata.version);
                  }
                } catch {}
              }

              // Step 3: Determine which pages need updating
              const pagesToFetch: string[] = [];
              for (const page of allMetadata) {
                const localVersion = localVersions.get(page.id);
                if (!localVersion || localVersion < page.version.number) {
                  pagesToFetch.push(page.id);
                }
              }

              console.log(chalk.dim(`${pagesToFetch.length} pages need updating`));

              if (pagesToFetch.length > 0) {
                // Step 4: Fetch and save only changed pages in parallel batches
                console.log(chalk.dim('Fetching updated pages...'));

                for (let i = 0; i < pagesToFetch.length; i += FETCH_BATCH_SIZE) {
                  const batchIds = pagesToFetch.slice(i, i + FETCH_BATCH_SIZE);

                  // Fetch pages in parallel
                  const batchPromises = batchIds.map((id) => confluenceClient.getPage(id));
                  const pages = await Promise.all(batchPromises);

                  process.stdout.write(
                    `\r${chalk.cyan('Fetched:')} ${Math.min(i + FETCH_BATCH_SIZE, pagesToFetch.length)}/${pagesToFetch.length} pages...`,
                  );

                  // Save pages in parallel
                  await Promise.all(
                    pages.map(async (page) => {
                      try {
                        await contentManager.saveContent({
                          id: `confluence:${page.id}`,
                          source: 'confluence',
                          type: 'page',
                          title: page.title,
                          content: page.body?.storage?.value || '',
                          url: page._links.webui,
                          spaceKey: page.space.key,
                          createdAt: new Date(page.version.when).getTime(),
                          updatedAt: new Date(page.version.when).getTime(),
                          syncedAt: Date.now(),
                          metadata: { version: page.version.number },
                        });
                      } catch (error) {
                        console.error(chalk.red(`Failed to save page ${page.id}: ${error}`));
                      }
                    }),
                  );
                  totalSynced += pages.length;
                }
                console.log();
              } else {
                console.log(chalk.dim('All pages are up to date!'));
              }
            }
          } else if (!lastSyncTime && totalSynced === 0) {
            // First-time sync without clean flag - get recent pages to start
            console.log(chalk.dim(`First-time sync - fetching ${INITIAL_BATCH} most recent pages...`));

            const recentSummaries = await confluenceClient.getRecentlyUpdatedPages(spaceKey, INITIAL_BATCH);

            if (recentSummaries.length > 0) {
              console.log(chalk.dim(`Fetching full content for ${recentSummaries.length} pages...`));

              // Fetch full page content in batches
              const pages = [];
              for (let i = 0; i < recentSummaries.length; i += FETCH_BATCH_SIZE) {
                const batch = recentSummaries.slice(i, i + FETCH_BATCH_SIZE);
                const batchPromises = batch.map((summary) => confluenceClient.getPage(summary.id));
                const batchPages = await Promise.all(batchPromises);
                pages.push(...batchPages);
                process.stdout.write(`\r${chalk.cyan('Fetched:')} ${pages.length}/${recentSummaries.length} pages...`);
              }
              console.log();

              // Save pages
              console.log(chalk.dim('Saving pages...'));
              for (let i = 0; i < pages.length; i += SAVE_BATCH_SIZE) {
                const batch = pages.slice(i, i + SAVE_BATCH_SIZE);

                await Promise.all(
                  batch.map(async (page) => {
                    try {
                      await contentManager.saveContent({
                        id: `confluence:${page.id}`,
                        source: 'confluence',
                        type: 'page',
                        title: page.title,
                        content: page.body?.storage?.value || '',
                        url: page._links.webui,
                        spaceKey: page.space.key,
                        createdAt: new Date(page.version.when).getTime(),
                        updatedAt: new Date(page.version.when).getTime(),
                        syncedAt: Date.now(),
                      });
                    } catch (error) {
                      console.error(chalk.red(`Failed to save page ${page.id}: ${error}`));
                    }
                  }),
                );
                totalSynced += batch.length;
                process.stdout.write(`\r${chalk.green('Saved:')} ${totalSynced} pages...`);
              }
              console.log();
            }
          }

          console.log(chalk.green(`✓ Successfully synced ${totalSynced} pages from ${spaceKey}`));

          // Track this space as a workspace
          const cacheManager = new CacheManager();
          try {
            await cacheManager.trackWorkspace('confluence_space', spaceKey, spaceKey);
          } finally {
            cacheManager.close();
          }

          return totalSynced;
        },
        catch: (error) => new Error(`Failed to sync Confluence space: ${error}`),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            contentManager.close();
            configManager.close();
          }),
        ),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red('Confluence sync failed:'), error instanceof Error ? error.message : String(error)),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function syncConfluence(spaceKey: string, options: { clean?: boolean } = {}) {
  try {
    await Effect.runPromise(syncConfluenceSpaceEffect(spaceKey, options));
  } catch (_error) {
    process.exit(1);
  }
}
