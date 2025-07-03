import chalk from 'chalk';
import { Effect, pipe, Schema } from 'effect';
import ora from 'ora';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

// Schema for validating issue key format
const IssueKeySchema = Schema.String.pipe(
  Schema.pattern(/^[A-Z]+-\d+$/),
  Schema.annotations({
    message: () => 'Invalid issue key format. Expected format: PROJECT-123',
  }),
);

// Get configuration
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        return { config, configManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Mark issue as done with Effect
const markIssueDoneEffect = (issueKey: string) =>
  pipe(
    // Validate issue key
    Schema.decodeUnknown(IssueKeySchema)(issueKey),
    Effect.mapError((error) => new Error(`Invalid issue key: ${error}`)),
    Effect.flatMap((_validIssueKey) =>
      pipe(
        getConfigEffect(),
        Effect.flatMap(({ config, configManager }) => {
          const jiraClient = new JiraClient(config);
          const spinner = ora(`Getting issue details for ${issueKey}...`).start();

          return pipe(
            // First get the issue to show current status
            jiraClient.getIssueEffect(issueKey),
            Effect.tap((issue) =>
              Effect.sync(() => {
                spinner.succeed(`Found issue: ${issue.key}`);
                console.log(`${chalk.bold(issue.key)}: ${issue.fields.summary}`);
                console.log(`${chalk.dim('Current Status:')} ${issue.fields.status.name}`);
                console.log('');
                spinner.start(`Moving ${issueKey} to Done...`);
              }),
            ),
            Effect.flatMap(() =>
              // First, get available transitions to debug
              pipe(
                jiraClient.getIssueTransitionsEffect(issueKey),
                Effect.tap((transitions) =>
                  Effect.sync(() => {
                    spinner.text = `Available transitions: ${transitions.map((t) => t.name).join(', ')}`;
                  }),
                ),
                Effect.flatMap(() =>
                  // Move the issue to Done
                  pipe(
                    jiraClient.closeIssueEffect(issueKey),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        spinner.succeed(`Successfully moved ${issueKey} to Done`);
                      }),
                    ),
                  ),
                ),
              ),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                spinner.start('Updating local cache...');
              }),
            ),
            Effect.flatMap(() =>
              // Update local cache with the new issue state
              Effect.tryPromise({
                try: async () => {
                  const cacheManager = new CacheManager();
                  try {
                    const updatedIssue = await jiraClient.getIssue(issueKey);
                    await cacheManager.saveIssue(updatedIssue);
                    return { cacheManager, updatedIssue };
                  } catch (error) {
                    cacheManager.close();
                    throw error;
                  }
                },
                catch: () => new Error('Failed to update local cache'),
              }),
            ),
            Effect.tap(({ cacheManager, updatedIssue }) =>
              Effect.sync(() => {
                cacheManager.close();
                spinner.succeed('Local cache updated');

                // Show final status
                console.log('');
                console.log(chalk.green('✓ Issue marked as Done successfully'));
                console.log(`${chalk.bold(updatedIssue.key)}: ${updatedIssue.fields.summary}`);
                console.log(`${chalk.dim('New Status:')} ${chalk.green(updatedIssue.fields.status.name)}`);
              }),
            ),
            Effect.catchAll((error) =>
              pipe(
                Effect.sync(() => {
                  const message = error instanceof Error ? error.message : String(error);
                  spinner.fail(`Failed to mark issue as done: ${message}`);
                  configManager.close();
                }),
                Effect.flatMap(() => Effect.fail(error)),
              ),
            ),
            Effect.tap(() => Effect.sync(() => configManager.close())),
          );
        }),
      ),
    ),
  );

export async function markIssueDone(issueKey: string) {
  try {
    await Effect.runPromise(markIssueDoneEffect(issueKey));
  } catch (_error) {
    process.exit(1);
  }
}
