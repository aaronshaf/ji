import Database from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { ConfigManager } from '../../lib/config';
import { formatSmartDate } from '../../lib/utils/date-formatter';

interface UncommentedOptions {
  days?: number;
  limit?: number;
  json?: boolean;
}

interface IssueComment {
  author?: {
    displayName?: string;
    emailAddress?: string;
    accountId?: string;
  };
  created?: string;
  body?: string;
}

interface IssueWithComments {
  key: string;
  summary: string;
  created: number;
  updated: number;
  status: string;
  assignee_name: string | null;
  assignee_email: string | null;
  reporter_name: string;
  reporter_email: string | null;
  raw_data: string;
  project_key: string;
}

// Effect for getting user email from config
const getUserEmailEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      const config = await configManager.getConfig();
      if (!config) {
        throw new Error('No configuration found. Please run "ji auth" first.');
      }
      return config.email;
    },
    catch: (error) => new Error(`Failed to get user email from config: ${error}`),
  });

// Effect for getting issues from cache
const getIssuesFromCacheEffect = (projectKey: string | undefined, options: UncommentedOptions) =>
  Effect.tryPromise({
    try: async () => {
      const dbPath = join(homedir(), '.ji', 'data.db');
      const db = new Database(dbPath);
      const cutoffDate = Date.now() - (options.days || 7) * 24 * 60 * 60 * 1000;

      let query: string;
      let params: (string | number)[];

      if (projectKey) {
        query = `
          SELECT key, summary, created, updated, status, 
                 assignee_name, assignee_email, reporter_name, 
                 reporter_email, raw_data, project_key
          FROM issues 
          WHERE project_key = ? 
          AND created > ?
          AND LOWER(status) NOT IN ('closed', 'done', 'resolved', 'complete', 'completed')
          ORDER BY created DESC
          LIMIT ?
        `;
        params = [projectKey, cutoffDate, options.limit || 50];
      } else {
        query = `
          SELECT key, summary, created, updated, status, 
                 assignee_name, assignee_email, reporter_name, 
                 reporter_email, raw_data, project_key
          FROM issues 
          WHERE created > ?
          AND LOWER(status) NOT IN ('closed', 'done', 'resolved', 'complete', 'completed')
          ORDER BY created DESC
          LIMIT ?
        `;
        params = [cutoffDate, options.limit || 50];
      }

      const issues = db.prepare(query).all(...params) as IssueWithComments[];
      db.close();
      return issues;
    },
    catch: (error) => new Error(`Failed to fetch issues from cache: ${error}`),
  });

// Effect for filtering uncommented issues
const filterUncommentedIssuesEffect = (issues: IssueWithComments[], userEmail: string) =>
  Effect.sync(() => {
    // Normalize email for comparison
    const normalizedEmail = userEmail.toLowerCase();
    const emailUsername = normalizedEmail.split('@')[0];

    return issues.filter((issue) => {
      try {
        const data = JSON.parse(issue.raw_data);
        const comments = (data.fields?.comment?.comments as IssueComment[]) || [];

        // Check if user has commented
        const hasUserCommented = comments.some((comment) => {
          const authorEmail = comment.author?.emailAddress?.toLowerCase();
          const authorName = comment.author?.displayName?.toLowerCase();

          return (
            authorEmail === normalizedEmail ||
            authorName === emailUsername ||
            // Sometimes display name includes full name, check if it contains username
            authorName?.includes(emailUsername) === true
          );
        });

        return !hasUserCommented;
      } catch (_error) {
        // If we can't parse the data, include the issue (safer to show than hide)
        console.error(`Warning: Could not parse issue data for ${issue.key}`);
        return true;
      }
    });
  });

// Format and display issues
const displayIssuesEffect = (
  issues: IssueWithComments[],
  projectKey: string | undefined,
  options: UncommentedOptions,
) =>
  Effect.sync(() => {
    if (options.json) {
      // JSON output
      const output = {
        uncommented_issues: {
          project: projectKey || 'all',
          since: new Date(Date.now() - (options.days || 7) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          total: issues.length,
        },
        issues: issues.map((issue) => ({
          key: issue.key,
          project: issue.project_key,
          created: formatSmartDate(issue.created),
          updated: formatSmartDate(issue.updated),
          summary: issue.summary,
          status: issue.status,
          assignee: issue.assignee_name || 'unassigned',
          reporter: issue.reporter_name,
        })),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      // YAML output
      console.log('uncommented_issues:');
      console.log(`  project: ${projectKey || 'all'}`);
      console.log(
        `  since: ${new Date(Date.now() - (options.days || 7) * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`,
      );
      console.log(`  total: ${issues.length}`);

      if (issues.length === 0) {
        console.log(`\n${chalk.gray('No uncommented issues found')}`);
        return;
      }

      console.log('\nissues:');

      // Group by project if showing all projects
      if (!projectKey) {
        const grouped = issues.reduce(
          (acc, issue) => {
            if (!acc[issue.project_key]) {
              acc[issue.project_key] = [];
            }
            acc[issue.project_key].push(issue);
            return acc;
          },
          {} as Record<string, IssueWithComments[]>,
        );

        Object.entries(grouped).forEach(([project, projectIssues]) => {
          console.log(`  ${chalk.cyan(project)}:`);
          projectIssues.forEach((issue) => {
            displayIssue(issue, '    ');
          });
        });
      } else {
        issues.forEach((issue) => {
          displayIssue(issue, '  ');
        });
      }
    }
  });

function displayIssue(issue: IssueWithComments, indent: string) {
  console.log(`${indent}- key: ${chalk.bold(issue.key)}`);
  console.log(`${indent}  created: ${formatSmartDate(issue.created)}`);
  console.log(`${indent}  summary: ${issue.summary}`);
  console.log(`${indent}  status: ${getStatusColor(issue.status)(issue.status)}`);
  console.log(`${indent}  assignee: ${issue.assignee_name || chalk.gray('unassigned')}`);

  // Count total comments for context
  try {
    const data = JSON.parse(issue.raw_data);
    const comments = data.fields?.comment?.comments || [];
    if (comments.length > 0) {
      console.log(`${indent}  comments: ${comments.length} (none by you)`);
    } else {
      console.log(`${indent}  comments: ${chalk.gray('none')}`);
    }
  } catch {
    // Ignore parsing errors for comment count
  }
}

function getStatusColor(status: string) {
  const normalizedStatus = status.toLowerCase();
  if (normalizedStatus.includes('done') || normalizedStatus.includes('closed')) {
    return chalk.green;
  }
  if (normalizedStatus.includes('progress')) {
    return chalk.yellow;
  }
  if (normalizedStatus === 'open' || normalizedStatus.includes('new')) {
    return chalk.cyan;
  }
  return chalk.white;
}

// Main command effect
const uncommentedCommandEffect = (projectKey: string | undefined, options: UncommentedOptions) =>
  pipe(
    Effect.all([getUserEmailEffect(), getIssuesFromCacheEffect(projectKey, options)]),
    Effect.flatMap(([userEmail, issues]) =>
      pipe(
        filterUncommentedIssuesEffect(issues, userEmail),
        Effect.flatMap((filteredIssues) => displayIssuesEffect(filteredIssues, projectKey, options)),
      ),
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }),
    ),
  );

// Export the async wrapper for CLI
export async function uncommentedCommand(args: string[]): Promise<void> {
  // Parse arguments
  const projectKey = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const options: UncommentedOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      options.days = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--json') {
      options.json = true;
    }
  }

  await Effect.runPromise(uncommentedCommandEffect(projectKey, options));
}
