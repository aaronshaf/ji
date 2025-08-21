import chalk from 'chalk';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { formatTimeAgo } from '../formatters/time.js';
import { formatSinceTime, parseSinceExpression, parseStatusFilter } from '../utils/time-parser.js';

// Helper function to escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface Issue {
  key: string;
  project_key: string;
  summary: string;
  status: string;
  priority: string;
  assignee_name: string | null;
  updated: string;
}

interface GroupedIssues {
  [projectKey: string]: Issue[];
}

// Helper to get priority order
const getPriorityOrder = (priority: string): number => {
  const priorityMap: Record<string, number> = {
    Highest: 1,
    High: 2,
    P1: 1,
    P2: 2,
    Medium: 3,
    P3: 3,
    Low: 4,
    P4: 4,
    Lowest: 5,
    P5: 5,
    None: 6,
    'Unassigned!': 7,
  };
  return priorityMap[priority] || 8;
};

// Sort issues by priority and then by updated date
const sortIssues = (issues: Issue[]): Issue[] => {
  return [...issues].sort((a, b) => {
    // First sort by priority
    const priorityDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    // Then sort by updated date (most recent first)
    const aTime = typeof a.updated === 'number' ? a.updated : new Date(a.updated).getTime();
    const bTime = typeof b.updated === 'number' ? b.updated : new Date(b.updated).getTime();
    return bTime - aTime;
  });
};

// Group issues by project
const groupIssuesByProject = (issues: Issue[]): GroupedIssues => {
  const grouped = issues.reduce((acc, issue) => {
    if (!acc[issue.project_key]) {
      acc[issue.project_key] = [];
    }
    acc[issue.project_key].push(issue);
    return acc;
  }, {} as GroupedIssues);

  // Sort issues within each project
  Object.keys(grouped).forEach((key) => {
    grouped[key] = sortIssues(grouped[key]);
  });

  return grouped;
};

// Build JQL query from filters
function buildJql(projectFilter?: string, statusFilter?: string, sinceFilter?: string): string {
  const jqlParts: string[] = ['assignee = currentUser()'];

  // Handle project filter
  if (projectFilter) {
    jqlParts.push(`project = ${projectFilter.toUpperCase()}`);
  }

  // Parse and handle status filter
  const statuses = statusFilter ? parseStatusFilter(statusFilter) : undefined;
  if (statuses === undefined) {
    // Default: exclude closed issues
    jqlParts.push('status NOT IN (Closed, Done, Resolved, Cancelled)');
  } else if (statuses.length > 0) {
    if (statuses.includes('open')) {
      jqlParts.push('status NOT IN (Closed, Done, Resolved, Cancelled)');
    } else {
      // Use specific statuses with proper JQL case-insensitive matching
      const statusList = statuses.map((s) => `"${s}"`).join(', ');
      jqlParts.push(`status IN (${statusList})`);
    }
  }
  // If statuses is empty array, no status filter (show all)

  // Handle time filter
  if (sinceFilter) {
    try {
      const since = parseSinceExpression(sinceFilter);
      const jiraDate = new Date(since).toISOString().split('T')[0];
      jqlParts.push(`updated >= "${jiraDate}"`);
    } catch (_error) {
      throw new Error(`Invalid time expression: ${sinceFilter}`);
    }
  }

  return jqlParts.join(' AND ');
}

export async function showMyIssues(projectFilter?: string, xml = false, statusFilter?: string, sinceFilter?: string) {
  const configManager = new ConfigManager();

  try {
    const config = await configManager.getConfig();
    if (!config) {
      console.error('No configuration found. Please run "ji auth" first.');
      process.exit(1);
    }

    // Always fetch fresh data from API
    const jiraClient = new JiraClient(config);

    // Build JQL query from filters
    const jql = buildJql(projectFilter, statusFilter, sinceFilter);

    try {
      // Fetch issues using JQL
      const searchResult = await jiraClient.searchIssues(jql);

      // Convert to our display format
      const displayIssues: Issue[] = searchResult.issues.map((jiraIssue) => ({
        key: jiraIssue.key,
        project_key: jiraIssue.key.split('-')[0],
        summary: jiraIssue.fields.summary,
        status: jiraIssue.fields.status.name,
        priority: jiraIssue.fields.priority?.name || 'None',
        assignee_name: jiraIssue.fields.assignee?.displayName || null,
        updated: jiraIssue.fields.updated.toString(),
      }));

      // Build filter description for display
      const getFilterDescription = () => {
        const parts: string[] = [];
        if (statusFilter) {
          if (statusFilter === 'all') {
            parts.push('all statuses');
          } else {
            parts.push(`status: ${statusFilter}`);
          }
        } else {
          parts.push('open issues');
        }
        if (projectFilter) {
          parts.push(`project: ${projectFilter.toUpperCase()}`);
        }
        if (sinceFilter) {
          const since = parseSinceExpression(sinceFilter);
          parts.push(`updated since: ${formatSinceTime(since)}`);
        }
        return parts.join(', ');
      };

      // Output results
      if (!xml) {
        // Pretty colored output (default)
        if (displayIssues.length === 0) {
          console.log(chalk.gray(`No issues found (${getFilterDescription()})`));
        } else {
          const groupedIssues = groupIssuesByProject(displayIssues);

          Object.entries(groupedIssues)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([projectKey, issues]) => {
              console.log(chalk.bold.cyan(`${projectKey}`));
              console.log(chalk.gray('─'.repeat(40)));

              issues.forEach((issue) => {
                const updatedTime = formatTimeAgo(new Date(issue.updated).getTime());

                // Color code priority
                let priorityColor = chalk.gray;
                const priority = issue.priority;
                if (priority === 'Highest' || priority === 'P1') priorityColor = chalk.red;
                else if (priority === 'High' || priority === 'P2') priorityColor = chalk.yellow;
                else if (priority === 'Medium' || priority === 'P3') priorityColor = chalk.blue;

                // Color code status
                let statusColor = chalk.gray;
                const status = issue.status.toLowerCase();
                if (status.includes('progress')) statusColor = chalk.yellow;
                else if (status.includes('review')) statusColor = chalk.magenta;
                else if (status.includes('todo') || status.includes('open')) statusColor = chalk.cyan;

                console.log(`  ${chalk.bold(issue.key)} ${chalk.white(issue.summary)}`);
                console.log(
                  `       ${statusColor(issue.status)} • ${priorityColor(issue.priority)} • ${chalk.gray(updatedTime)}`,
                );
                console.log();
              });
            });
        }
      } else {
        // XML output (for LLMs)
        console.log('<my_issues>');

        // Add filter information
        console.log(`  <filters>`);
        if (statusFilter) {
          console.log(`    <status>${escapeXml(statusFilter)}</status>`);
        }
        if (projectFilter) {
          console.log(`    <project>${escapeXml(projectFilter.toUpperCase())}</project>`);
        }
        if (sinceFilter) {
          const since = parseSinceExpression(sinceFilter);
          console.log(`    <since>${escapeXml(sinceFilter)} (${formatSinceTime(since)})</since>`);
        }
        console.log(`  </filters>`);

        if (displayIssues.length === 0) {
          console.log(`  <message>No issues found with the specified filters</message>`);
        } else {
          const groupedIssues = groupIssuesByProject(displayIssues);
          console.log('  <projects>');

          Object.entries(groupedIssues)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([projectKey, issues]) => {
              console.log(`    <project>`);
              console.log(`      <name>${escapeXml(projectKey)}</name>`);
              console.log(`      <issues>`);

              issues.forEach((issue) => {
                const updatedTime = formatTimeAgo(new Date(issue.updated).getTime());

                console.log(`        <issue>`);
                console.log(`          <key>${escapeXml(issue.key)}</key>`);
                console.log(`          <title>${escapeXml(issue.summary)}</title>`);
                console.log(`          <status>${escapeXml(issue.status)}</status>`);
                console.log(`          <priority>${escapeXml(issue.priority)}</priority>`);
                console.log(`          <updated>${updatedTime}</updated>`);
                console.log(`        </issue>`);
              });

              console.log(`      </issues>`);
              console.log(`    </project>`);
            });

          console.log('  </projects>');
        }

        console.log('</my_issues>');
      }
    } catch (apiError) {
      console.error(`Error fetching from Jira API: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
  }
}

// Export the takeIssue function
export { takeIssue } from './mine-take.js';
