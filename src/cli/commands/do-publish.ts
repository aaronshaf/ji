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
 * Counts the number of commits that will be published.
 * For Gerrit, this checks commits since the base branch.
 */
const countCommitsSinceBase = (workingDirectory: string): number => {
  try {
    // Get the merge base (common ancestor with origin/master or origin/main)
    let baseBranch: string;
    try {
      execSync('git rev-parse --verify origin/master', { cwd: workingDirectory, stdio: 'pipe' });
      baseBranch = 'origin/master';
    } catch {
      baseBranch = 'origin/main';
    }

    const commitCount = execSync(`git rev-list --count HEAD ^${baseBranch}`, {
      cwd: workingDirectory,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    return Number.parseInt(commitCount, 10);
  } catch (error) {
    console.warn(chalk.yellow(`⚠️  Could not count commits: ${error}`));
    return 0;
  }
};

/**
 * Squashes multiple commits into a single commit for Gerrit.
 * Preserves the first commit message and adds details from subsequent commits.
 */
const squashCommitsForGerrit = (workingDirectory: string, commitCount: number): Effect.Effect<void, DoCommandError> =>
  Effect.sync(() => {
    console.log(chalk.yellow(`⚠️  Found ${commitCount} commits - Gerrit requires exactly 1`));
    console.log(chalk.blue('🔄 Squashing commits into a single commit...'));

    try {
      // Get all commit messages
      const messages = execSync(`git log --format=%B -n ${commitCount}`, {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      // Soft reset to base branch (keeps all changes staged)
      execSync(`git reset --soft HEAD~${commitCount}`, {
        cwd: workingDirectory,
        stdio: 'pipe',
      });

      // Create a single commit with combined message
      const firstMessage = messages.split('\n\n')[0]; // Get first commit's subject
      const commitMessage = `${firstMessage}\n\nSquashed ${commitCount} commits from ji do iterations.\n\n${messages}`;

      // Create commit (let hooks run to add Change-Id)
      const result = spawnSync('git', ['commit', '-m', commitMessage], {
        cwd: workingDirectory,
        stdio: 'pipe',
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        throw new Error(`Failed to create squashed commit: ${result.stderr}`);
      }

      console.log(chalk.green('✅ Commits squashed into a single commit'));

      // Verify we now have exactly 1 commit
      const newCount = countCommitsSinceBase(workingDirectory);
      if (newCount !== 1) {
        throw new Error(`Expected 1 commit after squash, but found ${newCount}`);
      }
    } catch (error) {
      throw new DoCommandError(`Failed to squash commits: ${error}`);
    }
  });

/**
 * Ensures exactly one commit exists before publishing to Gerrit.
 * If multiple commits are found, squashes them into one.
 */
const ensureSingleCommitForGerrit = (
  workingDirectory: string,
  remoteType: RemoteType,
): Effect.Effect<void, DoCommandError> =>
  Effect.sync(() => {
    if (remoteType !== 'gerrit') {
      return; // Only enforce for Gerrit
    }

    const commitCount = countCommitsSinceBase(workingDirectory);

    if (commitCount === 0) {
      console.log(chalk.yellow('⚠️  No commits found - nothing to publish'));
      return;
    }

    if (commitCount === 1) {
      console.log(chalk.green('✅ Exactly 1 commit found - ready for Gerrit'));
      return;
    }

    // Multiple commits found - need to squash
    return Effect.runSync(squashCommitsForGerrit(workingDirectory, commitCount));
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
    // Ensure single commit for Gerrit before publishing
    ensureSingleCommitForGerrit(workingDirectory, remoteType),
    Effect.flatMap(() =>
      // Execute publish command first if configured
      executePublishCommand(projectConfig, workingDirectory, options),
    ),
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
  allResults: IterationResult[], // NEW: check if tests were run
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
        },
        allResults.some((r) => r.testsRun), // NEW: pass if any iteration ran tests
      ),
    ]),
    Effect.flatMap(([validation, testReqs]) => createSafetyReport(validation, testReqs)),
    Effect.tap((report) =>
      Effect.sync(() => {
        console.log(chalk.blue('\n🔒 Safety Validation Report'));
        console.log(`Overall: ${report.overall ? chalk.green('✅ PASS') : chalk.red('❌ FAIL')}`);
        console.log(`Files validated: ${report.fileValidation.filesValidated}`);
        console.log(`Test requirements: ${report.testRequirements.satisfied ? '✅ Satisfied' : '❌ Not satisfied'}`);

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
  const hasCommits = allResults.some((r) => r.commitHash);

  if (allFilesModified.length === 0 && !hasCommits) {
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

  if (allFilesModified.length === 0 && hasCommits) {
    console.log(chalk.blue('📝 Commits were made - executing publish step'));
    return pipe(
      createPullRequest(workingDirectory, issueInfo, allResults, remoteType, projectConfig, options),
      Effect.flatMap((prResult) => {
        // Execute remote iterations if configured
        if (options.remoteIterations && options.remoteIterations > 0) {
          return pipe(
            executeRemoteIterations(workingDirectory, issueInfo.key, remoteType, projectConfig, options),
            Effect.map((remoteResults) => ({
              safetyReport: {
                overall: true,
                fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
                testRequirements: { satisfied: true, reason: 'Commits made by agent' },
                additionalChecks: {} as Record<string, boolean>,
                summary: 'Publish executed for existing commits',
              },
              prResult,
              remoteResults,
            })),
          );
        }

        return Effect.succeed({
          safetyReport: {
            overall: true,
            fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
            testRequirements: { satisfied: true, reason: 'Commits made by agent' },
            additionalChecks: {} as Record<string, boolean>,
            summary: 'Publish executed for existing commits',
          },
          prResult,
          remoteResults: [],
        });
      }),
    );
  }

  // Files were modified - run safety validation then publish
  return pipe(
    performSafetyValidation(allFilesModified, workingDirectory, options, allResults),
    Effect.flatMap((safetyReport) => {
      if (!safetyReport.overall && !options.dryRun) {
        return Effect.fail(new DoCommandError('Safety validation failed - aborting'));
      }

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
};
