import { Console, Effect, pipe } from 'effect';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { ContentManager } from '../../lib/content-manager.js';
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

// Effect wrapper for getting configuration and managers
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
        const contentManager = new ContentManager();
        const jiraClient = new JiraClient(config);
        return { config, configManager, cacheManager, contentManager, jiraClient };
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

// Effect wrapper for updating cache
const updateCacheEffect = (cacheManager: CacheManager, issue: Issue) =>
  Effect.tryPromise({
    try: () => cacheManager.saveIssue(issue),
    catch: (error) => new Error(`Failed to update cache: ${error}`),
  });

// Effect wrapper for updating search index
const updateSearchIndexEffect = (contentManager: ContentManager, issue: Issue) =>
  Effect.tryPromise({
    try: () => contentManager.saveJiraIssue(issue),
    catch: (error) => new Error(`Failed to update search index: ${error}`),
  });

// Effect wrapper for getting cached issue
const getCachedIssueEffect = (cacheManager: CacheManager, issueKey: string) =>
  Effect.tryPromise({
    try: () => cacheManager.getIssue(issueKey),
    catch: (error) => new Error(`Failed to get cached issue: ${error}`),
  });

// Effect wrapper for background refresh
const refreshInBackgroundEffect = (_config: { jiraUrl: string }, issue: Issue) =>
  Effect.tryPromise({
    try: async () => {
      // Background refresh logic would go here
      // For now, just a placeholder
      const args = ['internal-refresh', issue.key, issue.fields.project?.key || 'unknown'];
      // Would spawn a background process here
      return args;
    },
    catch: (error) => new Error(`Failed to trigger background refresh: ${error}`),
  });

// Effect for formatting issue output in XML format for better LLM parsing
const formatIssueOutputEffect = (issue: Issue, config: { jiraUrl: string }) =>
  Effect.sync(() => {
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
      const cleanDescription = description.replace(/\s+/g, ' ').trim();
      console.log(`  <description>${escapeXml(cleanDescription)}</description>`);
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
          const commentBody = formatDescription(comment.body).replace(/\s+/g, ' ').trim();
          console.log(`    <comment>`);
          console.log(`      <author>${escapeXml(comment.author.displayName)}</author>`);
          console.log(`      <created>${formatSmartDate(comment.created)}</created>`);
          console.log(`      <body>${escapeXml(commentBody)}</body>`);
          console.log(`    </comment>`);
        });
        console.log(`  </comments>`);
      }
    }

    // Close the issue XML tag
    console.log('</issue>');
  });

// Pure Effect-based viewIssue implementation - remote-first approach
const viewIssueEffect = (issueKey: string, options: { json?: boolean; local?: boolean } = {}) =>
  pipe(
    getManagersEffect(),
    Effect.flatMap(({ config, configManager, cacheManager, contentManager, jiraClient }) =>
      pipe(
        // Check if we should use local cache or fetch fresh data
        getCachedIssueEffect(cacheManager, issueKey),
        Effect.flatMap((cachedIssue) => {
          if (options.local && cachedIssue) {
            // User explicitly requested local cached data
            return pipe(
              formatIssueOutputEffect(cachedIssue, config),
              // Optionally refresh in background for next time
              Effect.tap(() => refreshInBackgroundEffect(config, cachedIssue)),
              Effect.tap(() =>
                Effect.sync(() => {
                  cacheManager.close();
                  contentManager.close();
                  configManager.close();
                }),
              ),
            );
          } else {
            // Default behavior: fetch fresh data from API
            return pipe(
              getIssueFromJiraEffect(jiraClient, issueKey),
              Effect.flatMap((issue) =>
                pipe(
                  updateCacheEffect(cacheManager, issue),
                  Effect.flatMap(() => updateSearchIndexEffect(contentManager, issue)),
                  Effect.flatMap(() => formatIssueOutputEffect(issue, config)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      cacheManager.close();
                      contentManager.close();
                      configManager.close();
                    }),
                  ),
                ),
              ),
              Effect.catchAll((apiError) => {
                // API failed, try to use cache if we have it
                if (cachedIssue) {
                  return pipe(
                    Console.log('⚠️  Using cached data (API unavailable)'),
                    Effect.flatMap(() => formatIssueOutputEffect(cachedIssue, config)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        cacheManager.close();
                        contentManager.close();
                        configManager.close();
                      }),
                    ),
                  );
                } else {
                  // No cache and API failed
                  return pipe(
                    Effect.sync(() => {
                      cacheManager.close();
                      contentManager.close();
                      configManager.close();
                    }),
                    Effect.flatMap(() => Effect.fail(apiError)),
                  );
                }
              }),
            );
          }
        }),
      ),
    ),
    Effect.catchAll((error) =>
      pipe(
        Console.error('Error:', error.message),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function viewIssue(issueKey: string, options: { json?: boolean; local?: boolean } = {}) {
  try {
    await Effect.runPromise(viewIssueEffect(issueKey, options));
  } catch (_error) {
    process.exit(1);
  }
}
