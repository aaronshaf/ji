import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '../../lib/project-config.js';
import type { IterationResult } from '../../lib/agent-sdk-wrapper.js';
import {
  validateFiles,
  checkTestRequirements,
  createSafetyReport,
  defaultSafetyConfig,
} from '../../lib/safety-controls.js';
import { generatePRDescription } from './do-prompt.js';
import {
  DoCommandError,
  type DoCommandOptions,
  type SafetyReport,
  type IssueInfo,
  type RemoteType,
} from './do-types.js';
import { executeRemoteIterations } from './do-remote-iteration.js';

/**
 * Creates a single commit with all changes after iterations complete.
 * Generates a comprehensive commit message from all iteration results.
 */
const createFinalCommit = (
  workingDirectory: string,
  issueInfo: IssueInfo,
  allResults: IterationResult[],
): Effect.Effect<string, DoCommandError> =>
  Effect.sync(() => {
    console.log(chalk.blue('\n📝 Creating commit with all changes...'));

    try {
      // Check if there are any changes to commit
      const statusResult = execSync('git status --porcelain', {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      if (!statusResult) {
        console.log(chalk.yellow('⚠️  No changes to commit'));
        return 'NO_CHANGES';
      }

      // Stage all changes
      execSync('git add -A', {
        cwd: workingDirectory,
        stdio: 'pipe',
      });

      // Generate concise commit message
      const successfulIterations = allResults.filter((r) => r.success);

      // Create commit message with conventional format
      const commitSubject = `feat: ${issueInfo.summary}`;
      const commitBody = ['', `Resolved ${issueInfo.key} through ${successfulIterations.length} iteration(s).`].join(
        '\n',
      );

      const fullMessage = `${commitSubject}\n${commitBody}`;

      // Note: Not including Resolves: footer to avoid conflicts with Gerrit's Change-Id footer
      // The issue key is already in the commit message body

      // Create commit (let hooks run to add Change-Id for Gerrit)
      const result = spawnSync('git', ['commit', '-m', fullMessage], {
        cwd: workingDirectory,
        stdio: 'pipe',
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        throw new Error(`Failed to create commit: ${result.stderr}`);
      }

      // Get the commit hash
      const commitHash = execSync('git rev-parse HEAD', {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      console.log(chalk.green(`✅ Created commit: ${commitHash.substring(0, 8)}`));
      console.log(chalk.dim(`   ${commitSubject}`));

      return commitHash;
    } catch (error) {
      throw new DoCommandError(`Failed to create final commit: ${error}`);
    }
  });

/**
 * Executes the configured publish command from .jiconfig.json
 */
export const executePublishCommand = (
  projectConfig: ProjectConfig,
  workingDirectory: string,
  options: DoCommandOptions,
) =>
  Effect.sync(() => {
    if (!projectConfig.publish) {
      return null; // No publish command configured
    }

    if (options.dryRun) {
      console.log(chalk.yellow(`[DRY RUN] Would execute publish command: ${projectConfig.publish}`));
      return 'DRY RUN';
    }

    console.log(chalk.blue(`🚀 Executing publish command: ${projectConfig.publish}`));

    try {
      // Use spawnSync with shell: true but no interpolation to prevent injection
      // The command comes from a trusted config file (.jiconfig.json)
      const result = spawnSync('sh', ['-c', projectConfig.publish], {
        cwd: workingDirectory,
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        throw new Error(`Command exited with code ${result.status}`);
      }

      console.log(chalk.green('✅ Publish command executed successfully'));
      return 'SUCCESS';
    } catch (error) {
      throw new DoCommandError(`Publish command failed: ${error}`);
    }
  });

/**
 * Creates a GitHub pull request or publishes to Gerrit
 */
export const createPullRequest = (
  workingDirectory: string,
  issueInfo: IssueInfo,
  allResults: IterationResult[],
  remoteType: RemoteType,
  projectConfig: ProjectConfig,
  options: DoCommandOptions,
) =>
  pipe(
    // Execute publish command first if configured
    executePublishCommand(projectConfig, workingDirectory, options),
    Effect.flatMap(() =>
      Effect.sync(() => {
        if (remoteType !== 'github') {
          console.log(chalk.blue('📋 Gerrit change created - no PR needed'));
          return 'N/A - Gerrit workflow';
        }

        if (options.dryRun) {
          console.log(chalk.yellow('[DRY RUN] Would create GitHub PR'));
          return 'DRY RUN';
        }

        // Check if gh CLI is available and get current branch
        try {
          execSync('gh --version', { stdio: 'pipe' });
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: workingDirectory,
            encoding: 'utf8',
          }).trim();
          return currentBranch;
        } catch {
          console.log(chalk.yellow('⚠️  gh CLI not available, skipping PR creation'));
          console.log('You can manually create a PR for the current branch');
          return 'Manual PR needed';
        }
      }),
    ),
    Effect.flatMap((branchOrStatus) => {
      if (
        branchOrStatus === 'N/A - Gerrit workflow' ||
        branchOrStatus === 'DRY RUN' ||
        branchOrStatus === 'Manual PR needed'
      ) {
        return Effect.succeed(branchOrStatus);
      }

      // Generate PR description
      const prDescription = generatePRDescription(issueInfo, allResults);
      const prBodyFile = join(tmpdir(), `ji-pr-body-${randomUUID()}.txt`);
      const prTitle = `feat: ${issueInfo.key} - ${issueInfo.summary}`;

      return pipe(
        Effect.tryPromise({
          try: async () => {
            await writeFile(prBodyFile, prDescription, 'utf8');
            return prBodyFile;
          },
          catch: (error) => new DoCommandError(`Failed to write PR body file: ${error}`),
        }),
        Effect.flatMap((bodyFile) =>
          Effect.tryPromise({
            try: () =>
              Promise.resolve(
                // Use spawnSync with array args to prevent command injection
                spawnSync('gh', ['pr', 'create', '--title', prTitle, '--body-file', bodyFile], {
                  cwd: workingDirectory,
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                }),
              ),
            catch: (error) => new DoCommandError(`Failed to create PR: ${error}`),
          }).pipe(
            Effect.flatMap((result) => {
              if (result.status !== 0) {
                return Effect.fail(
                  new DoCommandError(
                    `gh pr create failed with exit code ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
                  ),
                );
              }
              return Effect.succeed(result.stdout.toString().trim());
            }),
            Effect.tap(() =>
              // Clean up the temporary file
              Effect.tryPromise({
                try: () => unlink(bodyFile),
                catch: (error) =>
                  // Ignore cleanup errors, just log them
                  Effect.logWarning(`Failed to cleanup PR body file ${bodyFile}: ${error}`),
              }).pipe(Effect.ignore),
            ),
          ),
        ),
        Effect.map((prUrl) => {
          console.log(chalk.green('✅ Pull request created'));
          console.log(`URL: ${prUrl}`);
          return prUrl;
        }),
      );
    }),
  );

/**
 * Performs safety validation on modified files
 */
export const performSafetyValidation = (
  modifiedFiles: string[],
  workingDirectory: string,
  options: DoCommandOptions,
  allResults: IterationResult[], // NEW: check if iterations completed successfully
) =>
  pipe(
    Effect.all([
      validateFiles(modifiedFiles, workingDirectory, { ...defaultSafetyConfig, ...options.safetyConfig }),
      checkTestRequirements(
        modifiedFiles,
        workingDirectory,
        {
          ...defaultSafetyConfig,
          ...options.safetyConfig,
          // If skipTests flag is set, disable test requirements
          requireTests: options.skipTests
            ? false
            : (options.safetyConfig?.requireTests ?? defaultSafetyConfig.requireTests),
        },
        allResults.length > 0 && allResults.every((r) => r.success), // Agent completed successfully
      ),
    ]),
    Effect.flatMap(([validation, testReqs]) => createSafetyReport(validation, testReqs)),
    Effect.tap((report) =>
      Effect.sync(() => {
        console.log(chalk.blue('\n🔒 Safety Validation Report'));
        console.log(`Overall: ${report.overall ? chalk.green('✅ PASS') : chalk.red('❌ FAIL')}`);
        console.log(`Files validated: ${report.fileValidation.filesValidated}`);
        console.log(`Test requirements: ${report.testRequirements.satisfied ? '✅ Satisfied' : '❌ Not satisfied'}`);

        if (options.skipTests) {
          console.log(chalk.yellow('⚠️  Test requirements skipped via --skip-tests flag'));
        }

        if (!report.overall) {
          console.log(chalk.red('\n⚠️  Safety validation failed:'));
          if (report.fileValidation.errors.length > 0) {
            console.log(chalk.red('File validation errors:'));
            for (const error of report.fileValidation.errors) {
              console.log(chalk.red(`  - ${error}`));
            }
          }
          console.log(chalk.yellow(`Test requirements: ${report.testRequirements.reason}`));
        }
      }),
    ),
  );

/**
 * Executes the final publish/PR creation step
 */
export const executeFinalPublishStep = (
  workingDirectory: string,
  issueInfo: IssueInfo,
  allResults: IterationResult[],
  remoteType: RemoteType,
  projectConfig: ProjectConfig,
  allFilesModified: string[],
  options: DoCommandOptions,
) => {
  // Check if there are any changes to commit OR existing unpushed commits
  if (allFilesModified.length === 0) {
    // Check if there are any unpushed commits from previous iterations
    try {
      const commitsAhead = execSync('git rev-list --count @{u}..HEAD 2>/dev/null || echo "0"', {
        cwd: workingDirectory,
        encoding: 'utf8',
      }).trim();

      const hasUnpushedCommits = Number.parseInt(commitsAhead, 10) > 0;

      if (!hasUnpushedCommits) {
        console.log(chalk.yellow('⚠️  No changes were made - skipping publish/PR step'));
        return Effect.succeed({
          safetyReport: {
            overall: true,
            fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
            testRequirements: { satisfied: true, reason: 'No changes made' },
            additionalChecks: {} as Record<string, boolean>,
            summary: 'No changes to publish',
          },
          prResult: 'No changes to publish',
          remoteResults: [],
        });
      }

      // Has unpushed commits - proceed to publish them
      console.log(chalk.blue(`\n📝 Found ${commitsAhead} unpushed commit(s) from previous iterations`));
      console.log(chalk.dim('   Proceeding to publish existing commits...'));
    } catch (error) {
      // If we can't determine unpushed commits, play it safe and skip
      console.log(chalk.yellow('⚠️  No changes were made - skipping publish/PR step'));
      return Effect.succeed({
        safetyReport: {
          overall: true,
          fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
          testRequirements: { satisfied: true, reason: 'No changes made' },
          additionalChecks: {} as Record<string, boolean>,
          summary: 'No changes to publish',
        },
        prResult: 'No changes to publish',
        remoteResults: [],
      });
    }
  }

  // Files were modified - create commit, run safety validation, then publish
  return pipe(
    // Step 1: Create single commit with all changes
    createFinalCommit(workingDirectory, issueInfo, allResults),
    Effect.flatMap((commitHash) => {
      if (commitHash === 'NO_CHANGES') {
        return Effect.succeed({
          safetyReport: {
            overall: true,
            fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
            testRequirements: { satisfied: true, reason: 'No changes to commit' },
            additionalChecks: {} as Record<string, boolean>,
            summary: 'No changes to publish',
          },
          prResult: 'No changes to publish',
          remoteResults: [],
        });
      }

      // Step 2: Run safety validation
      return pipe(
        performSafetyValidation(allFilesModified, workingDirectory, options, allResults),
        Effect.flatMap((safetyReport) => {
          if (!safetyReport.overall && !options.dryRun) {
            return Effect.fail(new DoCommandError('Safety validation failed - aborting'));
          }

          // Step 3: Publish (create PR or push to Gerrit)
          return pipe(
            createPullRequest(workingDirectory, issueInfo, allResults, remoteType, projectConfig, options),
            Effect.flatMap((prResult) => {
              // Execute remote iterations if configured
              if (options.remoteIterations && options.remoteIterations > 0) {
                return pipe(
                  executeRemoteIterations(workingDirectory, issueInfo.key, remoteType, projectConfig, options),
                  Effect.map((remoteResults) => ({
                    safetyReport,
                    prResult,
                    remoteResults,
                  })),
                );
              }

              return Effect.succeed({
                safetyReport,
                prResult,
                remoteResults: [],
              });
            }),
          );
        }),
      );
    }),
  );
};
