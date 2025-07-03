import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import type { Board } from '../../lib/jira-client.js';

// Effect wrapper for getting configuration and cache managers
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
        return { config, configManager, cacheManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Effect wrapper for getting boards
const getBoardsEffect = (email: string, cacheManager: CacheManager, projectFilter?: string) =>
  Effect.tryPromise({
    try: async () => {
      let boards = await cacheManager.getMyBoards(email);

      if (projectFilter) {
        boards = boards.filter((board) => board.location?.projectKey?.toLowerCase() === projectFilter.toLowerCase());
      }

      return boards;
    },
    catch: (error) => new Error(`Failed to get boards: ${error}`),
  });

// Effect wrapper for getting project issues
const getProjectIssuesEffect = (projectKey: string, cacheManager: CacheManager) =>
  Effect.tryPromise({
    try: () => cacheManager.listIssuesByProject(projectKey),
    catch: (error) => new Error(`Failed to get project issues: ${error}`),
  });

// Effect for displaying single board with issues
const displaySingleBoardEffect = (
  board: Board,
  projectFilter: string,
  cacheManager: CacheManager,
  config: { jiraUrl: string },
) =>
  pipe(
    Console.log(`${chalk.bold.blue(board.name)} ${chalk.dim(`(${board.type})`)}\n`),
    Effect.flatMap(() => getProjectIssuesEffect(projectFilter, cacheManager)),
    Effect.flatMap((issues) => {
      if (issues.length === 0) {
        return Console.log(chalk.yellow('No cached issues for this project. Run "ji sync" to update.'));
      }

      // Group by status
      const statusGroups = new Map<string, typeof issues>();
      issues.forEach((issue) => {
        const status = issue.status;
        if (!statusGroups.has(status)) {
          statusGroups.set(status, []);
        }
        statusGroups.get(status)?.push(issue);
      });

      // Common board statuses in order
      const commonStatuses = ['To Do', 'In Progress', 'In Review', 'Done'];
      const allStatuses = Array.from(statusGroups.keys()).sort((a, b) => {
        const aIndex = commonStatuses.indexOf(a);
        const bIndex = commonStatuses.indexOf(b);
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.localeCompare(b);
      });

      // Display by status
      const statusDisplayEffect = Effect.all(
        allStatuses.map((status) => {
          const statusIssues = statusGroups.get(status) || [];
          return Effect.sync(() => {
            console.log(chalk.bold(`${status} (${statusIssues.length})`));

            statusIssues.slice(0, 10).forEach((issue) => {
              const assignee = issue.assignee_name || 'unassigned';
              console.log(`  ${chalk.cyan(issue.key)} ${issue.summary} ${chalk.dim(`@${assignee}`)}`);
            });

            if (statusIssues.length > 10) {
              console.log(chalk.dim(`  ... and ${statusIssues.length - 10} more`));
            }
            console.log();
          });
        }),
      );

      return pipe(
        statusDisplayEffect,
        Effect.flatMap(() =>
          Console.log(
            chalk.dim(`Board URL: ${chalk.cyan(`${config.jiraUrl}/secure/RapidBoard.jspa?rapidView=${board.id}`)}`),
          ),
        ),
      );
    }),
  );

// Effect for displaying board list
const displayBoardListEffect = (boards: Board[], config: { jiraUrl: string }) =>
  Effect.sync(() => {
    // Group boards by project
    const boardsByProject: Record<string, Board[]> = {};
    boards.forEach((board) => {
      const projectKey = board.location?.projectKey || 'Other';
      if (!boardsByProject[projectKey]) {
        boardsByProject[projectKey] = [];
      }
      boardsByProject[projectKey].push(board);
    });

    // Display board list
    const projectEntries = Object.entries(boardsByProject);
    projectEntries.forEach(([projectKey, projectBoards]) => {
      if (projectBoards.length === 1) {
        const board = projectBoards[0];
        const typeIcon = board.type === 'scrum' ? '🏃' : board.type === 'kanban' ? '📋' : '📊';
        console.log(
          `${chalk.bold.blue(projectKey)}: ${typeIcon} ${chalk.bold(board.name)} ${chalk.cyan(`→ ${board.id}`)}`,
        );
      } else {
        console.log(`${chalk.bold.blue(projectKey)} (${projectBoards.length}):`);
        projectBoards.forEach((board) => {
          const typeIcon = board.type === 'scrum' ? '🏃' : board.type === 'kanban' ? '📋' : '📊';
          console.log(
            `  ${typeIcon} ${chalk.bold(board.name)} ${chalk.dim(`(${board.type})`)} ${chalk.cyan(`→ ${board.id}`)}`,
          );
        });
      }
    });

    // Show actual clickable links for each board
    console.log();
    boards.forEach((board) => {
      console.log(
        chalk.dim(`${board.name}: ${chalk.cyan(`${config.jiraUrl}/secure/RapidBoard.jspa?rapidView=${board.id}`)}`),
      );
    });
  });

// Pure Effect-based showMyBoards implementation
const showMyBoardsEffect = (projectFilter?: string) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, cacheManager }) =>
      pipe(
        getBoardsEffect(config.email, cacheManager, projectFilter),
        Effect.flatMap((boards) => {
          if (projectFilter && boards.length === 0) {
            return pipe(
              Console.log(`No boards found for project ${projectFilter}.`),
              Effect.flatMap(() => Console.log(chalk.dim('💡 Run "ji sync" to sync your workspaces and boards.'))),
              Effect.tap(() =>
                Effect.sync(() => {
                  cacheManager.close();
                  configManager.close();
                }),
              ),
            );
          }

          if (boards.length === 0) {
            return pipe(
              Console.log('No boards found in cache.'),
              Effect.flatMap(() => Console.log(chalk.dim('💡 Run "ji sync" to sync your workspaces and boards.'))),
              Effect.tap(() =>
                Effect.sync(() => {
                  cacheManager.close();
                  configManager.close();
                }),
              ),
            );
          }

          const displayEffect =
            projectFilter && boards.length === 1
              ? displaySingleBoardEffect(boards[0], projectFilter, cacheManager, config)
              : displayBoardListEffect(boards, config);

          return pipe(
            displayEffect,
            Effect.tap(() =>
              Effect.sync(() => {
                cacheManager.close();
                configManager.close();
              }),
            ),
          );
        }),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error(`Failed to retrieve boards: ${error.message}`),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function showMyBoards(projectFilter?: string) {
  try {
    await Effect.runPromise(showMyBoardsEffect(projectFilter));
  } catch (_error) {
    process.exit(1);
  }
}
