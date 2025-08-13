import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { formatTimeAgo } from '../formatters/time.js';

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

export async function showMyIssues(projectFilter?: string, pretty = false, useLocal = false) {
  const configManager = new ConfigManager();
  let cacheManager: CacheManager | null = null;

  try {
    const config = await configManager.getConfig();
    if (!config) {
      console.error('No configuration found. Please run "ji auth" first.');
      process.exit(1);
    }

    cacheManager = new CacheManager();
    let displayIssues: Issue[] = [];

    if (useLocal) {
      // Use cached data when --local flag is used
      const cachedIssues = await cacheManager.listMyOpenIssues(config.email);
      displayIssues = projectFilter
        ? cachedIssues.filter((issue) => issue.project_key === projectFilter.toUpperCase())
        : cachedIssues;
    } else {
      // Default: Fetch fresh data from API (remote-first)
      const jiraClient = new JiraClient(config);

      // Get all projects from cache or do a basic sync
      const allProjects = await cacheManager.getAllProjects();
      const projectKeys = projectFilter
        ? [projectFilter.toUpperCase()]
        : allProjects.length > 0
          ? allProjects.map((p) => p.key)
          : [''];

      // Fetch issues for each project
      const allIssues: Issue[] = [];
      for (const projectKey of projectKeys) {
        if (!projectKey) continue;

        try {
          const jql = `project = ${projectKey} AND assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)`;
          const searchResult = await jiraClient.searchIssues(jql);

          for (const jiraIssue of searchResult.issues) {
            // Save to cache
            await cacheManager.saveIssue(jiraIssue);

            // Add to display list
            allIssues.push({
              key: jiraIssue.key,
              project_key: projectKey,
              summary: jiraIssue.fields.summary,
              status: jiraIssue.fields.status.name,
              priority: jiraIssue.fields.priority?.name || 'None',
              assignee_name: jiraIssue.fields.assignee?.displayName || null,
              updated: jiraIssue.fields.updated.toString(),
            });
          }
        } catch (_err) {
          // Continue with other projects
        }
      }

      displayIssues = allIssues;
    }

    // Get last sync time for user's issues
    const lastSyncTime = await cacheManager.getMyIssuesLastSync(config.email);

    // Output YAML with data sync indicator
    if (pretty) {
      // Pretty colored output
      if (lastSyncTime) {
        console.log(chalk.gray(`Last synced: ${formatTimeAgo(lastSyncTime.getTime())}\n`));
      }

      if (displayIssues.length === 0) {
        console.log(
          chalk.gray(
            `No open issues assigned to you${projectFilter ? ` in project ${projectFilter.toUpperCase()}` : ''}`,
          ),
        );
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
      // XML output (default)
      console.log('<my_issues>');

      if (lastSyncTime) {
        console.log(`  <last_synced>${formatTimeAgo(lastSyncTime.getTime())}</last_synced>`);
      }

      if (displayIssues.length === 0) {
        console.log(
          `  <message>No open issues assigned to you${projectFilter ? ` in project ${projectFilter.toUpperCase()}` : ''}</message>`,
        );
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

    // Spawn background sync process (non-blocking)
    if (displayIssues.length > 0 && useLocal) {
      const args = ['internal-sync-mine', config.email];
      if (projectFilter) {
        args.push(projectFilter);
      }

      const child = spawn(process.argv[0], [process.argv[1], ...args], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    if (cacheManager) {
      cacheManager.close();
    }
    configManager.close();
  }
}

// Export the takeIssue function
export { takeIssue } from './mine-take.js';
