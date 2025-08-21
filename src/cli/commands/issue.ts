import { Console, Effect, pipe } from 'effect';
import { ConfigManager } from '../../lib/config.js';
import { type Issue, JiraClient } from '../../lib/jira-client.js';
import { formatSmartDate } from '../../lib/utils/date-formatter.js';
import { formatDescription } from '../formatters/issue.js';

// Helper function to escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Effect wrapper for getting configuration
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

// Effect wrapper for getting issue from Jira
const getIssueFromJiraEffect = (jiraClient: JiraClient, issueKey: string) =>
  Effect.tryPromise({
    try: () => jiraClient.getIssue(issueKey),
    catch: (error) => {
      if (error instanceof Error) {
        if (error.message.includes('404')) {
          return new Error(`Issue ${issueKey} not found`);
        }
        if (error.message.includes('401')) {
          return new Error('Authentication failed. Please run "ji auth" again.');
        }
        return error;
      }
      return new Error('Unknown error occurred');
    },
  });

// Effect for formatting issue output in XML format for better LLM parsing
const formatIssueOutputEffect = (issue: Issue, config: { jiraUrl: string }, jiraClient: JiraClient) =>
  Effect.tryPromise({
    try: async () => {
      // XML output for better LLM parsing
      console.log('<issue>');
      console.log(`  <type>issue</type>`);
      console.log(`  <key>${issue.key}</key>`);
      console.log(`  <link>${config.jiraUrl}/browse/${issue.key}</link>`);
      console.log(`  <title>${escapeXml(issue.fields.summary)}</title>`);
      console.log(`  <updated>${formatSmartDate(issue.fields.updated)}</updated>`);
      console.log(`  <created>${formatSmartDate(issue.fields.created)}</created>`);
      console.log(`  <status>${escapeXml(issue.fields.status.name)}</status>`);

      // Priority
      if (issue.fields.priority) {
        const priority = issue.fields.priority.name;
        console.log(`  <priority>${escapeXml(priority)}</priority>`);
      }

      // Reporter before Assignee
      console.log(`  <reporter>${escapeXml(issue.fields.reporter.displayName)}</reporter>`);

      if (issue.fields.assignee) {
        console.log(`  <assignee>${escapeXml(issue.fields.assignee.displayName)}</assignee>`);
      } else {
        console.log(`  <assignee>Unassigned</assignee>`);
      }

      // Epic information (check common epic link fields)
      const epicField =
        issue.fields.customfield_10014 || // Epic Link (common)
        issue.fields.customfield_10008 || // Epic Link (alternative)
        issue.fields.customfield_10001 || // Epic Link (alternative)
        issue.fields.parent; // Parent issue (for subtasks and epics in next-gen projects)

      if (epicField) {
        let epicKey: string | undefined;
        let epicSummary: string | undefined;
        let epicDescription: string | undefined;

        // Extract epic key
        if (typeof epicField === 'string') {
          epicKey = epicField;
        } else if (epicField && typeof epicField === 'object') {
          const epic = epicField as { key?: string; id?: string; fields?: { summary?: string } };
          epicKey = epic.key || epic.id;
          epicSummary = epic.fields?.summary;
        }

        // If we have an epic key, fetch the full epic details
        if (epicKey) {
          try {
            // Always fetch fresh from API
            const epicIssue = await jiraClient.getIssue(epicKey);

            if (epicIssue) {
              epicSummary = epicIssue.fields.summary || epicSummary;
              epicDescription = formatDescription(epicIssue.fields.description);
            }
          } catch (_error) {
            // If we can't fetch the epic, continue with what we have
            console.error(`  <!-- Failed to fetch epic details for ${epicKey} -->`);
          }

          // Display epic information
          console.log(`  <epic>`);
          console.log(`    <key>${escapeXml(epicKey)}</key>`);

          if (epicSummary) {
            console.log(`    <summary>${escapeXml(epicSummary)}</summary>`);
          }

          if (epicDescription?.trim()) {
            const cleanDescription = epicDescription
              .split('\n')
              .map((line) => line.replace(/\s+/g, ' ').trim())
              .filter((line) => line.length > 0)
              .join('\n');

            console.log(`    <description>`);
            cleanDescription.split('\n').forEach((line) => {
              console.log(`      ${escapeXml(line)}`);
            });
            console.log(`    </description>`);
          }

          console.log(`  </epic>`);
        }
      }

      // Sprint information
      const sprintField =
        issue.fields.customfield_10020 ||
        issue.fields.customfield_10021 ||
        issue.fields.customfield_10016 ||
        issue.fields.customfield_10018 ||
        issue.fields.customfield_10019;

      if (sprintField) {
        let sprintName = 'Unknown Sprint';
        if (Array.isArray(sprintField) && sprintField.length > 0) {
          const sprintInfo = sprintField[0];
          if (typeof sprintInfo === 'string' && sprintInfo.includes('name=')) {
            const match = sprintInfo.match(/name=([^,\]]+)/);
            if (match) sprintName = match[1];
          } else if (sprintInfo && typeof sprintInfo === 'object' && 'name' in sprintInfo) {
            sprintName = (sprintInfo as { name: string }).name;
          }
        } else if (sprintField && typeof sprintField === 'object' && 'name' in sprintField) {
          sprintName = (sprintField as { name: string }).name;
        }
        console.log(`  <sprint>${escapeXml(sprintName)}</sprint>`);
      }

      // Labels
      if (issue.fields.labels && issue.fields.labels.length > 0) {
        console.log(`  <labels>`);
        issue.fields.labels.forEach((label) => {
          console.log(`    <label>${escapeXml(label)}</label>`);
        });
        console.log(`  </labels>`);
      }

      // Description - always show full description
      const description = formatDescription(issue.fields.description);
      if (description.trim()) {
        // Preserve newlines but normalize other whitespace
        const cleanDescription = description
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter((line) => line.length > 0)
          .join('\n');

        console.log(`  <description>`);
        // Indent each line of the description for better readability
        cleanDescription.split('\n').forEach((line) => {
          console.log(`    ${escapeXml(line)}`);
        });
        console.log(`  </description>`);
      }

      // Comments - show all comments
      if (
        issue.fields.comment &&
        typeof issue.fields.comment === 'object' &&
        'comments' in issue.fields.comment &&
        Array.isArray((issue.fields.comment as { comments: unknown[] }).comments) &&
        (issue.fields.comment as { comments: unknown[] }).comments.length > 0
      ) {
        const comments = (
          issue.fields.comment as { comments: { author: { displayName: string }; created: string; body: unknown }[] }
        ).comments;

        if (comments.length > 0) {
          console.log(`  <comments>`);

          // Show all comments in XML format
          comments.forEach((comment) => {
            // Preserve newlines but normalize other whitespace
            const commentBody = formatDescription(comment.body)
              .split('\n')
              .map((line) => line.replace(/\s+/g, ' ').trim())
              .filter((line) => line.length > 0)
              .join('\n');

            console.log(`    <comment>`);
            console.log(`      <author>${escapeXml(comment.author.displayName)}</author>`);
            console.log(`      <created>${formatSmartDate(comment.created)}</created>`);
            console.log(`      <body>`);
            // Indent each line of the body for better readability
            commentBody.split('\n').forEach((line) => {
              console.log(`        ${escapeXml(line)}`);
            });
            console.log(`      </body>`);
            console.log(`    </comment>`);
          });
          console.log(`  </comments>`);
        }
      }

      // Close the issue XML tag
      console.log('</issue>');
    },
    catch: (error) => new Error(`Failed to format issue output: ${error}`),
  });

// Pure Effect-based viewIssue implementation - API-only approach
const viewIssueEffect = (issueKey: string) =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager, jiraClient }) =>
      pipe(
        // Always fetch fresh data from API
        getIssueFromJiraEffect(jiraClient, issueKey),
        Effect.flatMap((issue) =>
          pipe(
            formatIssueOutputEffect(issue, config, jiraClient),
            Effect.tap(() =>
              Effect.sync(() => {
                configManager.close();
              }),
            ),
          ),
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

export async function viewIssue(issueKey: string, _options: { json?: boolean } = {}) {
  try {
    await Effect.runPromise(viewIssueEffect(issueKey));
  } catch (_error) {
    process.exit(1);
  }
}
