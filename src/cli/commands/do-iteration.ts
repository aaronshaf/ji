import chalk from 'chalk';
import { Effect } from 'effect';
import { execSync } from 'node:child_process';
import { executeAgent, type IterationResult } from '../../lib/agent-sdk-wrapper.js';
import { generateIterationPrompt } from './do-prompt.js';
import type { IterationContext, DoCommandOptions, DoCommandError } from './do-types.js';

/**
 * Infers previous iteration results from git state to support --resume.
 * Counts commits ahead of origin/master to determine how many iterations
 * have been completed. Each commit represents one iteration.
 *
 * @param workingDirectory - Directory to check git state
 * @param issueKey - Issue key (unused but kept for API compatibility)
 * @returns Number of completed iterations (0 if none found)
 */
export const inferPreviousIterations = (
  workingDirectory: string,
  issueKey: string,
): Effect.Effect<number, DoCommandError> =>
  Effect.sync(() => {
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
      // This works for both GitHub (multiple commits) and Gerrit (single amended commit)
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

      // If we have commits ahead of origin, those represent completed iterations
      if (commitCount > 0) {
        if (hasUnstagedChanges) {
          console.log(chalk.blue(`📌 Resuming: Found ${commitCount} completed iteration(s)`));
          console.log(chalk.yellow(`   Unstaged changes detected - iteration ${commitCount + 1} in progress`));
        } else {
          console.log(chalk.blue(`📌 Found ${commitCount} completed iteration(s)`));
          console.log(chalk.yellow('   No unstaged changes - ready to continue'));
        }
        return commitCount;
      }

      // No commits ahead of origin
      if (hasUnstagedChanges) {
        console.log(chalk.blue('📌 Resuming: Unstaged changes detected, no commits yet'));
        console.log(chalk.yellow('   Assuming iteration 1 in progress'));
        return 0;
      }

      console.log(chalk.dim('   No previous work found - starting fresh'));
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
