import chalk from 'chalk';
import { Effect } from 'effect';
import { executeAgent, type IterationResult } from '../../lib/agent-sdk-wrapper.js';
import { generateIterationPrompt } from './do-prompt.js';
import type { IterationContext, DoCommandOptions } from './do-types.js';

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
      const prompt = generateIterationPrompt(iterationContext);

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
        (i > 1 && result.success && result.filesModified.length === 0 && !result.commitHash);

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
