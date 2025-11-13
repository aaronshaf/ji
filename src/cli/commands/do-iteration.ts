import chalk from 'chalk';
import { Effect } from 'effect';
import { execSync } from 'node:child_process';
import { executeAgent, type IterationResult } from '../../lib/agent-sdk-wrapper.js';
import { generateIterationPrompt } from './do-prompt.js';
import type { IterationContext, DoCommandOptions, DoCommandError } from './do-types.js';
import type { ProjectConfig } from '../../lib/project-config.js';
import { executeCheckBuildStatus, type BuildStatusResult } from './do-remote.js';

/**
 * Result of inferring previous iterations
 */
export interface ResumeCheckResult {
  /** Number of completed iterations to resume from (0 if starting fresh) */
  completedIterations: number;
  /** If true, work is complete and no further action needed */
  isComplete: boolean;
  /** Reason for the result (for user feedback) */
  reason: string;
}

/**
 * Infers previous iteration results from git state to support --resume.
 * Checks if work was pushed and if build passed on Gerrit.
 *
 * @param workingDirectory - Directory to check git state
 * @param issueKey - Issue key being worked on
 * @param projectConfig - Project configuration (optional, for build checking)
 * @returns ResumeCheckResult indicating where to resume or if work is complete
 */
export const inferPreviousIterations = (
  workingDirectory: string,
  issueKey: string,
  projectConfig?: ProjectConfig,
): Effect.Effect<ResumeCheckResult, DoCommandError> =>
  Effect.gen(function* () {
    console.log(chalk.dim(`\n🔍 Inferring previous iterations for ${issueKey}`));
    console.log(chalk.dim(`   Working directory: ${workingDirectory}`));

    try {
      // Check if there are unstaged changes
      const statusResult = execSync('git status --porcelain', {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      const hasUnstagedChanges = statusResult.length > 0;
      console.log(chalk.dim(`   Unstaged changes: ${hasUnstagedChanges ? 'yes' : 'no'}`));

      // Count commits ahead of origin/master (or origin/main)
      let commitCount = 0;
      try {
        // Try origin/master first (Gerrit convention)
        const countResult = execSync('git rev-list --count origin/master..HEAD', {
          cwd: workingDirectory,
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();
        commitCount = Number.parseInt(countResult, 10);
        console.log(chalk.dim(`   Commits ahead of origin/master: ${commitCount}`));
      } catch {
        // Fallback to origin/main (GitHub convention)
        try {
          const countResult = execSync('git rev-list --count origin/main..HEAD', {
            cwd: workingDirectory,
            encoding: 'utf8',
            stdio: 'pipe',
          }).trim();
          commitCount = Number.parseInt(countResult, 10);
          console.log(chalk.dim(`   Commits ahead of origin/main: ${commitCount}`));
        } catch {
          console.log(chalk.dim('   Could not determine commits ahead of origin'));
          commitCount = 0;
        }
      }

      // If we have commits ahead of origin, check if they were pushed
      if (commitCount > 0) {
        // Check if commit exists on remote
        let isPushed = false;
        try {
          // For GitHub: Check if HEAD exists on any remote branch
          const remoteCheck = execSync('git branch -r --contains HEAD', {
            cwd: workingDirectory,
            encoding: 'utf8',
            stdio: 'pipe',
          }).trim();

          if (remoteCheck.length > 0) {
            isPushed = true;
            console.log(chalk.dim('   Pushed to remote: yes (found on remote branch)'));
          } else {
            // For Gerrit: Can't reliably detect push status without remote verification
            // Gerrit commits go to refs/changes/, not regular branches
            // If checkBuildStatus is configured, we'll verify via that command
            const commitMessage = execSync('git log -1 --format=%B HEAD', {
              cwd: workingDirectory,
              encoding: 'utf8',
              stdio: 'pipe',
            }).trim();

            const hasChangeId = /Change-Id: I[0-9a-f]{40}/.test(commitMessage);
            if (hasChangeId) {
              // Has Change-Id: Might be Gerrit, but we don't know if it's pushed yet
              // Mark as potentially pushed - will verify via checkBuildStatus if configured
              isPushed = true; // Tentative - will be verified if checkBuildStatus exists
              console.log(
                chalk.dim('   Pushed to remote: unknown (Gerrit Change-Id found, will verify via checkBuildStatus)'),
              );
            } else {
              isPushed = false;
              console.log(chalk.dim('   Pushed to remote: no'));
            }
          }
        } catch (error) {
          console.log(chalk.dim(`   Could not determine if pushed to remote: ${error}`));
          isPushed = false;
        }

        // If pushed and build check is configured, check build status
        if (isPushed && projectConfig?.checkBuildStatus) {
          console.log(chalk.dim('   Checking build status...'));
          const buildResult = yield* Effect.catchAll(
            executeCheckBuildStatus(projectConfig, workingDirectory),
            (error: DoCommandError): Effect.Effect<BuildStatusResult, never> => {
              // Special handling for "not found" errors (commit not pushed to Gerrit yet)
              if (error.message.includes('Not found') || error.message.includes('No messages found')) {
                console.log(chalk.dim('   Build check failed: Change not found on remote (not pushed yet)'));
                // Mark as not pushed and return early
                isPushed = false;
                return Effect.succeed({ state: 'not_found' as const, raw: error.message });
              }
              console.log(chalk.dim(`   Build check failed: ${error.message}`));
              return Effect.succeed({ state: 'failure' as const, raw: error.message });
            },
          );

          // If change wasn't found on remote, treat as not pushed
          if (buildResult.state === 'not_found') {
            isPushed = false;
            console.log(chalk.dim('   Pushed to remote: no (verified via checkBuildStatus)'));
            // Fall through to the "not pushed" logic below
          } else if (buildResult.state === 'success') {
            console.log(chalk.green('✅ Build passed - issue appears complete'));

            // Change was pushed and build passed - work is complete!

            return {
              completedIterations: commitCount,
              isComplete: true,
              reason: 'Build passed on remote',
            };
          }

          if (buildResult.state === 'failure') {
            console.log(chalk.yellow('❌ Build failed - will need remote iterations to fix'));
            return {
              completedIterations: commitCount,
              isComplete: false,
              reason: 'Build failed - needs remote iteration fixes',
            };
          }

          // pending or running - treat as incomplete
          console.log(chalk.yellow(`⏳ Build is ${buildResult.state} - treating as incomplete`));
          return {
            completedIterations: commitCount,
            isComplete: false,
            reason: `Build is ${buildResult.state}`,
          };
        }

        // Pushed but no build check configured, or not pushed yet
        if (hasUnstagedChanges) {
          console.log(chalk.blue(`📌 Resuming: Found ${commitCount} completed iteration(s)`));
          console.log(chalk.yellow(`   Unstaged changes detected - iteration ${commitCount + 1} in progress`));
          return {
            completedIterations: commitCount,
            isComplete: false,
            reason: `Unstaged changes detected after ${commitCount} iteration(s)`,
          };
        }

        console.log(chalk.blue(`📌 Found ${commitCount} completed iteration(s)`));
        console.log(chalk.yellow('   No unstaged changes - ready to continue'));
        return {
          completedIterations: commitCount,
          isComplete: false,
          reason: `${commitCount} iteration(s) completed, ready to continue`,
        };
      }

      // No commits ahead of origin
      if (hasUnstagedChanges) {
        console.log(chalk.blue('📌 Resuming: Unstaged changes detected, no commits yet'));
        console.log(chalk.yellow('   Assuming iteration 1 in progress'));
        return {
          completedIterations: 0,
          isComplete: false,
          reason: 'Unstaged changes detected, iteration 1 in progress',
        };
      }

      console.log(chalk.dim('   No previous work found - starting fresh'));
      return {
        completedIterations: 0,
        isComplete: false,
        reason: 'No previous work found',
      };
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not infer previous iterations: ${error}`));
      console.log(chalk.yellow('   Starting from iteration 1'));
      return {
        completedIterations: 0,
        isComplete: false,
        reason: `Error checking previous work: ${error}`,
      };
    }
  });

/**
 * Executes all development iterations for an issue
 */
export const executeIterations = (context: IterationContext, options: DoCommandOptions) =>
  Effect.gen(function* () {
    const results: IterationResult[] = [];

    for (let i = 1; i <= context.totalIterations; i++) {
      const iterationContext: IterationContext = {
        ...context,
        iteration: i,
        previousResults: results,
      };

      console.log(chalk.blue(`\n📝 Starting iteration ${i}/${context.totalIterations}...`));

      // Generate prompt for this iteration
      const prompt = generateIterationPrompt(iterationContext, options);

      // Execute SDK agent
      const result = yield* executeAgent({
        cwd: context.workingDirectory,
        maxTurns: 30, // Allow agent enough turns to analyze, implement, and commit
        prompt,
        model: (options.model as 'sonnet' | 'opus' | 'haiku') || 'sonnet',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task'],
      });

      results.push(result);

      if (result.success) {
        console.log(chalk.green(`✅ Iteration ${i} completed successfully`));
        console.log(`Summary: ${result.summary}`);
        if (result.filesModified.length > 0) {
          console.log(`Files modified: ${result.filesModified.join(', ')}`);
        }
      } else {
        console.log(chalk.red(`❌ Iteration ${i} failed`));
        console.log(`Summary: ${result.summary}`);
        if (result.errors) {
          console.log(`Errors: ${result.errors.join(', ')}`);
        }
      }

      // Check for early termination conditions
      const shouldTerminate =
        // Explicit issue resolution signal
        (result.issueResolved && result.success) ||
        // No changes made in a follow-up iteration (indicates work is complete)
        (i > 1 && result.success && result.filesModified.length === 0);

      if (shouldTerminate) {
        if (result.issueResolved) {
          console.log(chalk.green(`\n🎯 Issue sufficiently resolved after ${i} iterations!`));
          if (result.reviewNotes) {
            console.log(`Review notes: ${result.reviewNotes}`);
          }
        } else {
          console.log(chalk.green(`\n✨ No further changes needed after ${i} iterations - work appears complete!`));
        }
        console.log(chalk.blue('Stopping early - no further iterations needed.'));
        break;
      }

      if (i < context.totalIterations) {
        console.log(chalk.gray('\nReady for next iteration...'));
      }
    }

    return results;
  });
