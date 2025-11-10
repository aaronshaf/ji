import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { execSync } from 'node:child_process';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { validateGitRepository } from '../../lib/git-worktree.js';
import { checkSDKConfiguration } from '../../lib/agent-sdk-wrapper.js';
import { loadProjectConfig } from '../../lib/project-config.js';
import { formatDescription } from '../formatters/issue.js';
import { executeIterations } from './do-iteration.js';
import { executeFinalPublishStep } from './do-publish.js';
import {
  DoCommandError,
  type DoCommandOptions,
  type FinalResult,
  type IterationContext,
  type IssueInfo,
  type RemoteType,
} from './do-types.js';

/**
 * Validates that an issue key matches the expected Jira format (PROJECT-123).
 *
 * @param issueKey - The issue key to validate
 * @returns Effect that succeeds with the validated key or fails with DoCommandError
 *
 * @example
 * validateIssueKey('EVAL-123') // Success
 * validateIssueKey('invalid') // Fails with error
 */
const validateIssueKey = (issueKey: string) =>
  Effect.sync(() => {
    // Jira issue key format: PROJECT-123
    // Project key: 1-10 uppercase letters
    // Issue number: 1 or more digits
    if (!/^[A-Z]{1,10}-\d+$/.test(issueKey)) {
      throw new DoCommandError(
        `Invalid issue key format: "${issueKey}". Expected format: PROJECT-123 (e.g., EVAL-123, CFA-42)`,
      );
    }
    return issueKey;
  });

/**
 * Escapes XML special characters in a string for safe inclusion in XML documents.
 *
 * Replaces the following characters with their XML entity equivalents:
 * - & → &amp;
 * - < → &lt;
 * - > → &gt;
 * - " → &quot;
 * - ' → &apos;
 *
 * @param str - The string to escape
 * @returns The escaped string safe for XML inclusion
 *
 * @example
 * escapeXml('Hello & "World"') // Returns: 'Hello &amp; &quot;World&quot;'
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Detects the type of git remote (GitHub, Gerrit, or unknown)
 */
const detectRemoteType = (): Effect.Effect<{ type: RemoteType }, DoCommandError> =>
  Effect.tryPromise({
    try: () => Promise.resolve(execSync('git remote -v', { encoding: 'utf8' }).toString()),
    catch: (error) => new DoCommandError(`Failed to detect remote type: ${error}`),
  }).pipe(
    Effect.map((output) => {
      const isGithub = output.toLowerCase().includes('github.com');
      const isGerrit =
        output.toLowerCase().includes('gerrit') ||
        (!isGithub && (output.includes(':29418/') || output.includes('/r/')));

      const type: RemoteType = isGithub ? 'github' : isGerrit ? 'gerrit' : 'unknown';
      return { type };
    }),
  );

/**
 * Detects the target branch for pull requests (main or master)
 */
const detectTargetBranch = () =>
  Effect.tryPromise({
    try: () => {
      try {
        // Try to detect the default branch from remote
        const defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
          encoding: 'utf8',
          stdio: 'pipe',
        })
          .trim()
          .replace('refs/remotes/origin/', '');
        return Promise.resolve(defaultBranch);
      } catch {
        // Fall back to checking which exists: main or master
        try {
          execSync('git show-ref --verify --quiet refs/remotes/origin/main', { stdio: 'pipe' });
          return Promise.resolve('main');
        } catch {
          return Promise.resolve('master');
        }
      }
    },
    catch: (error) => new DoCommandError(`Failed to detect target branch: ${error}`),
  });

/**
 * Fetches issue details from Jira and formats them as XML
 */
const getIssueDescription = (issueKey: string, jiraClient: JiraClient) =>
  Effect.tryPromise({
    try: async () => {
      const issue = await jiraClient.getIssue(issueKey);

      // Format as XML for Claude
      const formattedDescription = formatDescription(issue);
      const escaped = escapeXml(formattedDescription);

      const xml = `<issue>
  <key>${escapeXml(issue.key)}</key>
  <summary>${escapeXml(issue.fields.summary)}</summary>
  <description>
${escaped}
  </description>
</issue>`;

      return {
        key: issue.key,
        summary: issue.fields.summary,
        description: xml,
      };
    },
    catch: (error) => new DoCommandError(`Failed to fetch issue ${issueKey}: ${error}`),
  });

/**
 * Effect-based implementation of ji do command.
 * Exported for testing purposes - use doCommand() for CLI usage.
 *
 * @internal
 */
export const doCommandEffect = (issueKey: string, options: DoCommandOptions = {}) =>
  pipe(
    // Validate issue key format
    validateIssueKey(issueKey),
    Effect.flatMap(() => validateGitRepository()),
    Effect.flatMap((gitStatus) => {
      if (!gitStatus.isGitRepo) {
        return Effect.fail(new DoCommandError('Not in a git repository'));
      }

      if (gitStatus.hasUncommittedChanges && !options.dryRun) {
        return Effect.fail(
          new DoCommandError(
            `You have ${gitStatus.uncommittedFiles} uncommitted changes. Please commit or stash them first.`,
          ),
        );
      }

      return Effect.succeed(gitStatus);
    }),

    // Get configuration and setup clients
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: async () => {
          const configManager = new ConfigManager();
          const config = await configManager.getConfig();
          if (!config) {
            throw new Error('No configuration found. Please run "ji setup" first.');
          }
          const jiraClient = new JiraClient(config);
          return { config, configManager, jiraClient };
        },
        catch: (error) => new DoCommandError(`Configuration error: ${error}`),
      }),
    ),

    // Detect remote and target branch
    Effect.flatMap(({ jiraClient }) =>
      Effect.all([detectRemoteType(), detectTargetBranch(), getIssueDescription(issueKey, jiraClient)]).pipe(
        Effect.map(([remote, targetBranch, issueInfo]) => ({
          jiraClient,
          remote,
          targetBranch,
          issueInfo,
        })),
      ),
    ),

    // Check SDK configuration and load project config
    Effect.flatMap(({ jiraClient, remote, targetBranch, issueInfo }) =>
      pipe(
        checkSDKConfiguration(),
        Effect.flatMap(() => loadProjectConfig(process.cwd())),
        Effect.map((projectConfig) => ({
          jiraClient,
          remote,
          targetBranch,
          issueInfo,
          projectConfig,
          workingDirectory: process.cwd(),
        })),
      ),
    ),

    // Setup and execute iterations
    Effect.flatMap(({ remote, targetBranch, issueInfo, projectConfig, workingDirectory }) => {
      const iterations = options.iterations || 2;

      // CRITICAL: Gerrit requires single commit workflow (amend pattern)
      // GitHub uses multiple commits (PR pattern)
      const singleCommit = options.singleCommit !== undefined ? options.singleCommit : remote.type === 'gerrit';

      const context: IterationContext = {
        issueKey: issueInfo.key,
        issueDescription: issueInfo.description, // Full XML representation
        workingDirectory,
        iteration: 1,
        totalIterations: iterations,
        previousResults: [],
        singleCommit,
      };

      console.log(chalk.blue(`\n🚀 Starting ji do for ${issueKey}`));
      console.log(chalk.yellow('⚠️  EXPERIMENTAL FEATURE: Powered by Claude Agent SDK'));
      console.log(chalk.yellow('   Always review changes before publishing.\n'));
      console.log(`Issue: ${issueInfo.summary}`);
      console.log(`Working Directory: ${workingDirectory}`);
      console.log(`Iterations: ${iterations}`);
      console.log(`Commit Strategy: ${context.singleCommit ? 'Single commit at end' : 'Multiple commits as needed'}`);
      console.log(`Remote type: ${remote.type}`);
      console.log(`Target branch: ${targetBranch}`);

      return pipe(
        executeIterations(context, options),
        Effect.flatMap((allResults) => {
          const successfulIterations = allResults.filter((r) => r.success).length;
          const allFilesModified = Array.from(new Set(allResults.flatMap((r) => r.filesModified)));

          console.log(chalk.blue(`\n📊 Summary: ${successfulIterations}/${iterations} iterations successful`));
          console.log(`Total files modified: ${allFilesModified.length}`);

          // Execute final publish/PR step
          return pipe(
            executeFinalPublishStep(
              workingDirectory,
              issueInfo,
              allResults,
              remote.type,
              projectConfig,
              allFilesModified,
              options,
            ),
            Effect.map(({ safetyReport, prResult }) => ({
              workingDirectory,
              allResults,
              safetyReport,
              prResult,
            })),
          );
        }),
      );
    }),

    // Return final result (no cleanup needed - working in current directory)
    Effect.map((result: FinalResult) => {
      console.log(chalk.blue('\n📁 Development completed in current directory'));
      console.log(`Location: ${result.workingDirectory}`);
      return result;
    }),
  );

/**
 * Main CLI entry point for the do command
 */
export async function doCommand(issueKey: string, options: DoCommandOptions = {}) {
  try {
    await Effect.runPromise(doCommandEffect(issueKey, options));
    console.log(chalk.green(`\n✅ ji do completed successfully for ${issueKey}`));
  } catch (error) {
    console.error(chalk.red(`\n💥 ji do failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// Re-export types and error class for external use
export { DoCommandError, type DoCommandOptions } from './do-types.js';
