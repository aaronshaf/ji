import { Effect } from 'effect';
import chalk from 'chalk';
import { ConfigManager } from '../../lib/config.js';
import { CacheManager } from '../../lib/cache.js';
import { type Board } from '../../lib/jira-client.js';

export async function showMyBoards(projectFilter?: string) {
  const configManager = new ConfigManager();
  const cacheManager = new CacheManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const program = Effect.tryPromise({
    try: async () => {
      // Get boards from local cache - instant!
      let boards = await cacheManager.getMyBoards(config.email);

      // Filter by project if specified
      if (projectFilter) {
        boards = boards.filter(
          (board) => board.location?.projectKey?.toLowerCase() === projectFilter.toLowerCase()
        );

        if (boards.length === 0) {
          console.log(`No boards found for project ${projectFilter}.`);
          console.log(chalk.dim('💡 Run "ji sync" to sync your workspaces and boards.'));
          return;
        }
      }

      if (boards.length === 0) {
        console.log('No boards found in cache.');
        console.log(chalk.dim('💡 Run "ji sync" to sync your workspaces and boards.'));
        return;
      }

      // Group boards by project
      const boardsByProject: Record<string, Board[]> = {};
      boards.forEach((board) => {
        const projectKey = board.location?.projectKey || 'Other';
        if (!boardsByProject[projectKey]) {
          boardsByProject[projectKey] = [];
        }
        boardsByProject[projectKey].push(board);
      });

      // If filtering by project and single board, show columns and issues
      if (projectFilter && boards.length === 1) {
        const board = boards[0];

        console.log(`${chalk.bold.blue(board.name)} ${chalk.dim(`(${board.type})`)}
`);

        // Use cached issues instead of board API
        const issues = await cacheManager.listIssuesByProject(projectFilter);

        if (issues.length === 0) {
          console.log(chalk.yellow('No cached issues for this project. Run "ji sync" to update.'));
        } else {
          // Group by status
          const statusGroups = new Map<string, typeof issues>();
          issues.forEach((issue) => {
            const status = issue.status;
            if (!statusGroups.has(status)) {
              statusGroups.set(status, []);
            }
            statusGroups.get(status)!.push(issue);
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
          allStatuses.forEach((status) => {
            const statusIssues = statusGroups.get(status)!;
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
        }

        console.log(chalk.dim(`Board URL: ${chalk.cyan(`${config.jiraUrl}/secure/RapidBoard.jspa?rapidView=${board.id}`)}`));
      } else {
        // Display normal board list
        const projectEntries = Object.entries(boardsByProject);
        projectEntries.forEach(([projectKey, projectBoards], _index) => {
          if (projectBoards.length === 1) {
            // Single board - put it on the same line as project
            const board = projectBoards[0];
            const typeIcon = board.type === 'scrum' ? '🏃' : board.type === 'kanban' ? '📋' : '📊';
            console.log(`${chalk.bold.blue(projectKey)}: ${typeIcon} ${chalk.bold(board.name)} ${chalk.cyan(`→ ${board.id}`)}`);
          } else {
            // Multiple boards - use the original format
            console.log(`${chalk.bold.blue(projectKey)} (${projectBoards.length}):`);

            projectBoards.forEach((board) => {
              const typeIcon = board.type === 'scrum' ? '🏃' : board.type === 'kanban' ? '📋' : '📊';

              // Compact single-line format
              console.log(`  ${typeIcon} ${chalk.bold(board.name)} ${chalk.dim(`(${board.type})`)} ${chalk.cyan(`→ ${board.id}`)}`);
            });
          }
        });

        // Show actual clickable links for each board
        console.log(); // blank line before links
        boards.forEach((board) => {
          console.log(chalk.dim(`${board.name}: ${chalk.cyan(`${config.jiraUrl}/secure/RapidBoard.jspa?rapidView=${board.id}`)}`));
        });
      }
    },
    catch: (error) => {
      console.error(`Failed to retrieve boards: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    },
  });

  await Effect.runPromise(program).finally(() => {
    configManager.close();
    cacheManager.close();
  });
}