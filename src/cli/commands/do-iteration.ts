import chalk from 'chalk';
import { Effect } from 'effect';
import { execSync } from 'node:child_process';
import { executeAgent, type IterationResult } from '../../lib/agent-sdk-wrapper.js';
import { generateIterationPrompt } from './do-prompt.js';
import type { IterationContext, DoCommandOptions, DoCommandError } from './do-types.js';

/**
 * Infers previous iteration results from git log to support --resume.
 * Looks at unstaged changes and the most recent commit to determine
 * how many iterations have been completed.
 *
 * @param workingDirectory - Directory to check git log
 * @param issueKey - Issue key to match in commit messages
 * @returns Number of completed iterations (0 if none found)
 */
export const inferPreviousIterations = (
  workingDirectory: string,
  issueKey: string,
): Effect.Effect<number, DoCommandError> =>
  Effect.sync(() => {
    try {
      // Check if there are unstaged changes
      const statusResult = execSync('git status --porcelain', {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      const hasUnstagedChanges = statusResult.length > 0;

      if (!hasUnstagedChanges) {
        // No work in progress - check if there's a commit for this issue
        try {
          // Look for the most recent commit that mentions this issue key
          const logResult = execSync(`git log -1 --grep="${issueKey}" --format="%s"`, {
            cwd: workingDirectory,
            encoding: 'utf8',
            stdio: 'pipe',
          }).trim();

          if (logResult) {
            // Found a commit - try to extract iteration count from commit message
            // Format: "Resolved ISSUE-123 through N iteration(s)"
            const match = logResult.match(/through (\d+) iteration/);
            if (match) {
              const completedIterations = Number.parseInt(match[1], 10);
              console.log(chalk.blue(`📌 Found commit with ${completedIterations} completed iteration(s)`));
              console.log(chalk.yellow('   No unstaged changes - issue appears to be complete'));
              console.log(chalk.yellow('   Use --resume to continue from this point'));
              return completedIterations;
            }
          }
        } catch {
          // No commit found, start from scratch
          return 0;
        }
      }

      // Has unstaged changes - assume we're in the middle of an iteration
      // Try to count from commit message if it exists
      try {
        const logResult = execSync(`git log -1 --grep="${issueKey}" --format="%s"`, {
          cwd: workingDirectory,
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();

        if (logResult) {
          const match = logResult.match(/through (\d+) iteration/);
          if (match) {
            const previousIterations = Number.parseInt(match[1], 10);
            console.log(chalk.blue(`📌 Resuming: Found ${previousIterations} completed iteration(s) in commit`));
            console.log(
              chalk.yellow(`   Unstaged changes detected - assuming iteration ${previousIterations + 1} in progress`),
            );
            return previousIterations;
          }
        }
      } catch {
        // No previous commit
      }

      // Has changes but no commit - assume first iteration in progress
      if (hasUnstagedChanges) {
        console.log(chalk.blue('📌 Resuming: Unstaged changes detected, no previous commit found'));
        console.log(chalk.yellow('   Assuming iteration 1 in progress'));
        return 0;
      }

      return 0;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not infer previous iterations: ${error}`));
      console.log(chalk.yellow('   Starting from iteration 1'));
      return 0;
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
