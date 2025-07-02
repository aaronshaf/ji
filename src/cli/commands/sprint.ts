import { Effect } from 'effect';
import chalk from 'chalk';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { CacheManager } from '../../lib/cache.js';
import { getJiraStatusIcon } from '../formatters/issue.js';
import { createProgressBar } from '../formatters/progress.js';
import Bun from 'bun';

export async function showSprint(projectFilter?: string, options: { unassigned?: boolean } = {}) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const cacheManager = new CacheManager();
  const jiraClient = new JiraClient(config);
  
  const program = Effect.tryPromise({
    try: async () => {
      // First, detect user's active sprints
      let activeSprints: Array<{
        sprintId: string;
        sprintName: string;
        boardId: number;
        projectKey: string;
      }> = [];

      // Check cached sprints first
      const cachedSprints = await cacheManager.getUserActiveSprints(config.email);

      if (cachedSprints.length === 0) {
        // No cached sprints, try to detect from user's current issues
        console.log(chalk.dim('Detecting your active sprints...'));

        // Get user's assigned issues
        const myIssues = await cacheManager.listMyOpenIssues(config.email);
        const projectKeys = [...new Set(myIssues.map((i) => i.project_key))];

        // For each project, check boards and sprints
        for (const projectKey of projectKeys) {
          try {
            const boards = await jiraClient.getBoardsForProject(projectKey);

            for (const board of boards) {
              const sprints = await jiraClient.getActiveSprints(board.id);

              for (const sprint of sprints) {
                await cacheManager.trackUserSprint(config.email, {
                  id: sprint.id.toString(),
                  name: sprint.name,
                  boardId: board.id,
                  projectKey: projectKey,
                });

                activeSprints.push({
                  sprintId: sprint.id.toString(),
                  sprintName: sprint.name,
                  boardId: board.id,
                  projectKey: projectKey,
                });
              }
            }
          } catch (error) {
            // Skip projects without boards
            continue;
          }
        }
      } else {
        activeSprints = cachedSprints;
      }

      // Filter by project if specified
      if (projectFilter) {
        activeSprints = activeSprints.filter(
          (s) => s.projectKey.toLowerCase() === projectFilter.toLowerCase()
        );
      }

      if (activeSprints.length === 0) {
        console.log(chalk.yellow('No active sprints found.'));
        console.log(chalk.dim('💡 Make sure you have issues assigned in active sprints.'));
        return;
      }

      // Display sprints with their issues
      for (const sprint of activeSprints) {
        // Define a simplified issue type for display purposes
        interface SimplifiedIssue {
          key: string;
          fields: {
            summary: string;
            status: { name: string };
            priority?: { name: string } | null;
            assignee?: { displayName: string; emailAddress?: string } | null;
          };
        }

        let allIssues: SimplifiedIssue[] = [];
        let fromCache = false;

        // Try cache first (unless it's stale)
        const cacheAge = await cacheManager.getSprintCacheAge(sprint.sprintId);
        const isStale = !cacheAge || Date.now() - cacheAge > 5 * 60 * 1000; // 5 minutes

        if (!isStale) {
          const cachedIssues = await cacheManager.getCachedSprintIssues(sprint.sprintId);
          if (cachedIssues.length > 0) {
            allIssues = cachedIssues.map((issue) => ({
              key: issue.key,
              fields: {
                summary: issue.summary,
                status: { name: issue.status },
                priority: issue.priority ? { name: issue.priority } : null,
                assignee: issue.assignee_name
                  ? {
                      displayName: issue.assignee_name,
                      emailAddress: issue.assignee_email || undefined,
                    }
                  : null,
              },
            }));
            fromCache = true;
          }
        }

        // If no cached data or stale, fetch from API
        if (allIssues.length === 0) {
          const sprintResult = await jiraClient.getSprintIssues(parseInt(sprint.sprintId));
          allIssues = sprintResult.issues;

          // Cache the fresh data in the format expected by setCachedSprintIssues
          const issuesToCache = sprintResult.issues.map((issue) => ({
            key: issue.key,
            project_key: sprint.projectKey,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
            priority: issue.fields.priority?.name || 'None',
            assignee_name: issue.fields.assignee?.displayName || null,
            assignee_email: issue.fields.assignee?.emailAddress || null,
            updated: issue.fields.updated,
          }));
          await cacheManager.setCachedSprintIssues(sprint.sprintId, issuesToCache);
          fromCache = false;
        }

        // Background refresh if we showed cached data
        if (fromCache) {
          const proc = Bun.spawn(['bun', 'run', process.argv[1], 'internal-sprint-refresh', sprint.sprintId], {
            stdio: ['ignore', 'ignore', 'ignore'],
            env: {
              ...process.env,
              JI_CONFIG: JSON.stringify(config),
            },
          });
          proc.unref();
        }

        const unassignedIssues = allIssues.filter((i) => !i.fields.assignee);

        // Skip if showing only unassigned and there are none
        if (options.unassigned && unassignedIssues.length === 0) {
          continue;
        }

        // Sprint header with subtle coloring
        console.log(`\n${chalk.bold(sprint.sprintName)} ${chalk.dim(`(${sprint.projectKey})`)}`);

        if (options.unassigned) {
          // Show only unassigned issues
          if (unassignedIssues.length === 0) {
            console.log(chalk.dim('  No unassigned issues'));
          } else {
            console.log(chalk.dim(`  ${unassignedIssues.length} unassigned issue${unassignedIssues.length !== 1 ? 's' : ''}:`));

            unassignedIssues.forEach((issue) => {
              const priorityName = issue.fields.priority?.name || 'None';
              const priorityColor =
                priorityName === 'High' || priorityName === 'Highest'
                  ? chalk.red
                  : priorityName === 'Medium'
                  ? chalk.yellow
                  : chalk.dim;

              console.log(`  ${chalk.cyan(issue.key)}: ${issue.fields.summary}`);
              console.log(`    ${priorityColor(`Priority: ${priorityName}`)} ${chalk.dim('|')} ${chalk.dim(`Type: ${issue.fields.status.name}`)}`);
            });
          }
        } else {
          // Show full sprint stats and my issues
          const todoIssues = allIssues.filter((i) => ['To Do', 'Open', 'New'].includes(i.fields.status.name));
          const inProgressIssues = allIssues.filter((i) => ['In Progress', 'In Development'].includes(i.fields.status.name));
          const doneIssues = allIssues.filter((i) => ['Done', 'Closed', 'Resolved'].includes(i.fields.status.name));

          // Progress bar
          const progressBar = createProgressBar(doneIssues.length, allIssues.length);

          console.log(`  ${progressBar} ${doneIssues.length}/${allIssues.length} completed`);

          // Sprint stats
          console.log(chalk.dim(`  Todo: ${todoIssues.length} | In Progress: ${inProgressIssues.length} | Done: ${doneIssues.length}`));

          // Show my issues in the sprint
          const myEmail = config.email;
          const myIssues = allIssues.filter((i) => i.fields.assignee?.emailAddress === myEmail || i.fields.assignee?.displayName === myEmail);

          if (myIssues.length > 0) {
            console.log(`\n  ${chalk.bold(`My issues (${myIssues.length}):`)}`)
            myIssues.forEach((issue) => {
              const statusIcon = getJiraStatusIcon(issue.fields.status.name);
              console.log(`    ${statusIcon} ${chalk.cyan(issue.key)}: ${issue.fields.summary}`);
            });
          }

          // Show unassigned count if any
          if (unassignedIssues.length > 0) {
            console.log(chalk.yellow(`\n  ${unassignedIssues.length} unassigned issue${unassignedIssues.length !== 1 ? 's' : ''}`));
          }
        }
      }
    },
    catch: (error) => {
      console.error(`Failed to retrieve sprint: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    },
  });

  await Effect.runPromise(program).finally(() => {
    configManager.close();
    cacheManager.close();
  });
}