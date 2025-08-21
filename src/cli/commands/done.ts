import chalk from 'chalk';
import { Effect, pipe, Schema } from 'effect';
import ora from 'ora';

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
                console.log('DEBUG: About to start transition process...');
                spinner.start(`Moving ${issueKey} to Done...`);
              }),
            ),
            Effect.flatMap(() =>
              // First, get available transitions to debug
              pipe(
                Effect.sync(() => {
                  spinner.text = 'Getting available transitions...';
                }),
                Effect.flatMap(() => jiraClient.getIssueTransitionsEffect(issueKey)),
                Effect.tap((transitions) =>
                  Effect.sync(() => {
                    spinner.text = `Available transitions: ${transitions.map((t) => t.name).join(', ')}`;
                    console.log(
                      `\nDEBUG: Found ${transitions.length} transitions:`,
                      transitions.map((t) => `${t.name} (${t.id})`),
                    );
                  }),
                ),
                Effect.flatMap(() =>
                  // Move the issue to Done
                  pipe(
                    Effect.sync(() => {
                      spinner.text = 'Applying Done transition...';
                    }),
                    Effect.flatMap(() => jiraClient.closeIssueEffect(issueKey)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        spinner.succeed(`Successfully moved ${issueKey} to Done`);
                      }),
                    ),
                  ),
                ),
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.log(`\nDEBUG: Error during transition: ${message}`);
                    spinner.fail(`Failed to get transitions or apply Done: ${message}`);
                    throw error;
                  }),
                ),
              ),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                spinner.succeed('Issue marked as Done successfully');
                console.log('');
                console.log(chalk.green('✓ Issue status updated'));
              }),
            ),
            Effect.catchAll((error) =>
              pipe(
                Effect.sync(() => {
                  const message = error instanceof Error ? error.message : String(error);
                  console.log(`\nDEBUG: Main error handler caught: ${message}`);
                  console.log(`DEBUG: Error type: ${error?.constructor?.name || typeof error}`);
                  if (error instanceof Error && error.stack) {
                    console.log(`DEBUG: Stack trace: ${error.stack}`);
                  }
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
