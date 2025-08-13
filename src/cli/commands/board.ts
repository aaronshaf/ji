import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { type Board, JiraClient } from '../../lib/jira-client.js';

// Helper function to escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Effect wrapper for getting configuration, cache managers, and jira client
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
        const jiraClient = new JiraClient(config);
        return { config, configManager, cacheManager, jiraClient };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Effect wrapper for getting boards (remote-first)
const getBoardsEffect = (
  email: string,
  cacheManager: CacheManager,
  jiraClient: JiraClient,
  projectFilter?: string,
  useLocal = false,
) =>
  Effect.tryPromise({
    try: async () => {
      let boards: Board[];

      if (useLocal) {
        // Use cached data when --local flag is specified
        boards = await cacheManager.getMyBoards(email);
      } else {
        // Default: Fetch fresh data from API (remote-first)
        try {
          const projects = await cacheManager.getAllProjects();
          const allBoards: Board[] = [];

          // Fetch boards for each project
          for (const project of projects) {
            try {
              const projectBoards = await jiraClient.getBoardsForProject(project.key);
              allBoards.push(...projectBoards);
            } catch (error) {
              // Continue with other projects if one fails
              console.error(`Failed to fetch boards for ${project.key}:`, error);
            }
          }

          boards = allBoards;

          // Cache the fresh data (skip for now since saveUserBoards might not exist)
          // await cacheManager.saveUserBoards(email, boards);
        } catch (error) {
          // Fallback to cached data if API fails
          console.error('Failed to fetch fresh board data, using cache:', error);
          boards = await cacheManager.getMyBoards(email);
        }
      }

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

// Effect for displaying single board with issues (unused for now, keeping for future use)
const _displaySingleBoardEffect = (
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

// Effect for displaying board list in XML format
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

    // XML output
    console.log('<boards>');

    if (boards.length === 0) {
      console.log('  <message>No boards found</message>');
    } else {
      console.log('  <projects>');

      const projectEntries = Object.entries(boardsByProject);
      projectEntries.forEach(([projectKey, projectBoards]) => {
        console.log('    <project>');
        console.log(`      <key>${escapeXml(projectKey)}</key>`);
        console.log('      <boards>');

        projectBoards.forEach((board) => {
          console.log('        <board>');
          console.log(`          <id>${board.id}</id>`);
          console.log(`          <name>${escapeXml(board.name)}</name>`);
          console.log(`          <type>${escapeXml(board.type)}</type>`);
          console.log(
            `          <url>${escapeXml(`${config.jiraUrl}/secure/RapidBoard.jspa?rapidView=${board.id}`)}</url>`,
          );
          if (board.location?.projectKey) {
            console.log(`          <project_key>${escapeXml(board.location.projectKey)}</project_key>`);
          }
          console.log('        </board>');
        });

        console.log('      </boards>');
        console.log('    </project>');
      });

      console.log('  </projects>');
    }

    console.log('</boards>');
  });

// Pure Effect-based showMyBoards implementation - remote-first
const showMyBoardsEffect = (projectFilter?: string, useLocal = false) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, cacheManager, jiraClient }) =>
      pipe(
        getBoardsEffect(config.email, cacheManager, jiraClient, projectFilter, useLocal),
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

          // Always use XML list format (simplified from the complex single board view)
          const displayEffect = displayBoardListEffect(boards, config);

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

export async function showMyBoards(projectFilter?: string, useLocal = false) {
  try {
    await Effect.runPromise(showMyBoardsEffect(projectFilter, useLocal));
  } catch (_error) {
    process.exit(1);
  }
}
