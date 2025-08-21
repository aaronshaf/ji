import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';
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

// Effect wrapper for getting configuration and jira client
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        const jiraClient = new JiraClient(config);
        return { config, configManager, jiraClient };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Effect wrapper for getting boards from API
const getBoardsEffect = (jiraClient: JiraClient, projectFilter?: string) =>
  Effect.tryPromise({
    try: async () => {
      // Always fetch fresh data from API
      const boards = await jiraClient.getBoards();

      // Apply project filter if specified
      if (projectFilter) {
        return boards.filter((board) => board.location?.projectKey?.toUpperCase() === projectFilter.toUpperCase());
      }

      return boards;
    },
    catch: (error) => new Error(`Failed to fetch boards from API: ${error}`),
  });

// Effect for formatting board output
const formatBoardOutputEffect = (boards: Board[], projectFilter?: string) =>
  Effect.tryPromise({
    try: async () => {
      if (boards.length === 0) {
        const message = projectFilter
          ? `No boards found for project ${projectFilter.toUpperCase()}`
          : 'No boards found';
        console.log(`<message>${message}</message>`);
        return;
      }

      // Group boards by project
      const boardsByProject = boards.reduce(
        (acc, board) => {
          const projectKey = board.location?.projectKey || 'Unknown';
          if (!acc[projectKey]) {
            acc[projectKey] = [];
          }
          acc[projectKey].push(board);
          return acc;
        },
        {} as Record<string, Board[]>,
      );

      console.log('<boards>');
      Object.entries(boardsByProject)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([projectKey, projectBoards]) => {
          console.log(`  <project>`);
          console.log(`    <name>${escapeXml(projectKey)}</name>`);
          console.log(`    <boards>`);

          projectBoards.forEach((board) => {
            console.log(`      <board>`);
            console.log(`        <id>${board.id}</id>`);
            console.log(`        <name>${escapeXml(board.name)}</name>`);
            console.log(`        <type>${escapeXml(board.type)}</type>`);
            if (board.location?.projectName) {
              console.log(`        <project_name>${escapeXml(board.location.projectName)}</project_name>`);
            }
            console.log(`      </board>`);
          });

          console.log(`    </boards>`);
          console.log(`  </project>`);
        });
      console.log('</boards>');
    },
    catch: (error) => new Error(`Failed to format board output: ${error}`),
  });

// Effect for pretty board output
const formatPrettyBoardOutputEffect = (boards: Board[], projectFilter?: string) =>
  Effect.tryPromise({
    try: async () => {
      if (boards.length === 0) {
        const message = projectFilter
          ? `No boards found for project ${projectFilter.toUpperCase()}`
          : 'No boards found';
        console.log(chalk.gray(message));
        return;
      }

      // Group boards by project
      const boardsByProject = boards.reduce(
        (acc, board) => {
          const projectKey = board.location?.projectKey || 'Unknown';
          if (!acc[projectKey]) {
            acc[projectKey] = [];
          }
          acc[projectKey].push(board);
          return acc;
        },
        {} as Record<string, Board[]>,
      );

      console.log(chalk.gray(`Found ${boards.length} board${boards.length !== 1 ? 's' : ''}\n`));

      Object.entries(boardsByProject)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([projectKey, projectBoards]) => {
          console.log(chalk.bold.cyan(projectKey));
          console.log(chalk.gray('─'.repeat(40)));

          projectBoards.forEach((board) => {
            console.log(`  ${chalk.bold(board.name)} (${chalk.gray(board.type)})`);
            if (board.location?.projectName && board.location.projectName !== projectKey) {
              console.log(`    ${chalk.gray(board.location.projectName)}`);
            }
          });
          console.log();
        });
    },
    catch: (error) => new Error(`Failed to format pretty board output: ${error}`),
  });

// Main Effect for showing boards - API-only approach
const showMyBoardsEffect = (projectFilter?: string, pretty = false) =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ configManager, jiraClient }) =>
      pipe(
        getBoardsEffect(jiraClient, projectFilter),
        Effect.flatMap((boards) => {
          if (pretty) {
            return formatPrettyBoardOutputEffect(boards, projectFilter);
          } else {
            return formatBoardOutputEffect(boards, projectFilter);
          }
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            configManager.close();
          }),
        ),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error('Error:', error.message),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function showMyBoards(projectFilter?: string, xml = false) {
  try {
    await Effect.runPromise(showMyBoardsEffect(projectFilter, !xml));
  } catch (_error) {
    process.exit(1);
  }
}
