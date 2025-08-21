import chalk from 'chalk';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

// Helper function to escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface SprintIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
  };
  sprintName: string;
  boardName: string;
  projectKey: string;
}

export async function showSprint(projectFilter?: string, options: { unassigned?: boolean; xml?: boolean } = {}) {
  const configManager = new ConfigManager();

  try {
    const config = await configManager.getConfig();

    if (!config) {
      console.error('No configuration found. Please run "ji auth" first.');
      process.exit(1);
    }

    // Always fetch fresh data from API
    const jiraClient = new JiraClient(config);

    // Get active sprints
    const boards = await jiraClient.getBoards();
    const activeSprintIssues: SprintIssue[] = [];

    // Filter boards by project if specified
    const filteredBoards = projectFilter
      ? boards.filter((board) => board.location?.projectKey?.toUpperCase() === projectFilter.toUpperCase())
      : boards;

    if (filteredBoards.length === 0) {
      const message = projectFilter ? `No boards found for project ${projectFilter.toUpperCase()}` : 'No boards found';
      console.log(message);
      return;
    }

    // Get issues from active sprints
    for (const board of filteredBoards) {
      try {
        const activeSprints = await jiraClient.getActiveSprints(board.id);

        for (const sprint of activeSprints) {
          const sprintResult = await jiraClient.getSprintIssues(sprint.id);
          const sprintIssues = sprintResult.issues;

          // Filter by assignment if requested
          const filteredIssues = options.unassigned
            ? sprintIssues.filter((issue) => !issue.fields.assignee)
            : sprintIssues;

          activeSprintIssues.push(
            ...filteredIssues.map((issue) => ({
              key: issue.key,
              fields: issue.fields,
              sprintName: sprint.name,
              boardName: board.name,
              projectKey: board.location?.projectKey || issue.key.split('-')[0],
            })),
          );
        }
      } catch (error) {
        // Continue with other boards if one fails
        console.error(`Failed to get sprint data for board ${board.name}: ${error}`);
      }
    }

    if (activeSprintIssues.length === 0) {
      const message = options.unassigned ? 'No unassigned issues in active sprints' : 'No issues in active sprints';
      console.log(message);
      return;
    }

    // Display results
    if (!options.xml) {
      displayPrettySprintResults(activeSprintIssues, options.unassigned);
    } else {
      displayXMLSprintResults(activeSprintIssues, options.unassigned);
    }
  } catch (error) {
    console.error(`Error fetching sprint data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
  }
}

function displayPrettySprintResults(issues: SprintIssue[], unassigned?: boolean) {
  console.log(
    chalk.gray(
      `Found ${issues.length} ${unassigned ? 'unassigned ' : ''}issue${issues.length !== 1 ? 's' : ''} in active sprints\n`,
    ),
  );

  // Group by sprint
  const bySprintAndBoard = issues.reduce(
    (acc, issue) => {
      const key = `${issue.boardName} - ${issue.sprintName}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(issue);
      return acc;
    },
    {} as Record<string, SprintIssue[]>,
  );

  Object.entries(bySprintAndBoard).forEach(([sprintBoardKey, sprintIssues]) => {
    console.log(chalk.bold.cyan(sprintBoardKey));
    console.log(chalk.gray('─'.repeat(50)));

    sprintIssues.forEach((issue) => {
      const assignee = issue.fields.assignee?.displayName || 'Unassigned';
      const priority = issue.fields.priority?.name || 'None';

      console.log(`  ${chalk.bold(issue.key)} ${issue.fields.summary}`);
      console.log(`    ${chalk.gray(issue.fields.status.name)} • ${priority} • ${assignee}`);
    });
    console.log();
  });
}

function displayXMLSprintResults(issues: SprintIssue[], unassigned?: boolean) {
  console.log('<sprint_issues>');
  console.log(`  <filter_type>${unassigned ? 'unassigned' : 'all'}</filter_type>`);
  console.log(`  <count>${issues.length}</count>`);

  if (issues.length > 0) {
    // Group by sprint
    const bySprintAndBoard = issues.reduce(
      (acc, issue) => {
        const key = `${issue.boardName}|||${issue.sprintName}`;
        if (!acc[key]) acc[key] = [];
        acc[key].push(issue);
        return acc;
      },
      {} as Record<string, SprintIssue[]>,
    );

    console.log('  <sprints>');
    Object.entries(bySprintAndBoard).forEach(([sprintBoardKey, sprintIssues]) => {
      const [boardName, sprintName] = sprintBoardKey.split('|||');
      console.log('    <sprint>');
      console.log(`      <board>${escapeXml(boardName)}</board>`);
      console.log(`      <name>${escapeXml(sprintName)}</name>`);
      console.log('      <issues>');

      sprintIssues.forEach((issue) => {
        console.log('        <issue>');
        console.log(`          <key>${escapeXml(issue.key)}</key>`);
        console.log(`          <title>${escapeXml(issue.fields.summary)}</title>`);
        console.log(`          <status>${escapeXml(issue.fields.status.name)}</status>`);
        console.log(`          <priority>${escapeXml(issue.fields.priority?.name || 'None')}</priority>`);
        console.log(`          <assignee>${escapeXml(issue.fields.assignee?.displayName || 'Unassigned')}</assignee>`);
        console.log(`          <project>${escapeXml(issue.projectKey)}</project>`);
        console.log('        </issue>');
      });

      console.log('      </issues>');
      console.log('    </sprint>');
    });
    console.log('  </sprints>');
  }

  console.log('</sprint_issues>');
}
