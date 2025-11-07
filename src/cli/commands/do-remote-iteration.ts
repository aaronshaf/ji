import chalk from 'chalk';
import { Effect } from 'effect';
import { executeAgent, type AgentSDKError, type AgentConfigError } from '../../lib/agent-sdk-wrapper.js';
import { generateRemoteIterationPrompt } from './do-prompt.js';
import { executeCheckBuild, pushToRemote } from './do-remote.js';
import type {
  DoCommandError,
  DoCommandOptions,
  RemoteIterationContext,
  RemoteIterationResult,
  RemoteType,
} from './do-types.js';
import type { ProjectConfig } from '../../lib/project-config.js';

/**
 * Executes remote iterations to fix CI build failures.
 * Runs until build passes or max iterations reached.
 *
 * @param workingDirectory - Directory where the code is located
 * @param issueKey - Jira issue key being resolved
 * @param remoteType - Type of remote (github, gerrit, unknown)
 * @param projectConfig - Project configuration with checkBuild command
 * @param options - Command options including remoteIterations count
 * @returns Effect with array of remote iteration results
 */
export const executeRemoteIterations = (
  workingDirectory: string,
  issueKey: string,
  remoteType: RemoteType,
  projectConfig: ProjectConfig,
  options: DoCommandOptions,
): Effect.Effect<RemoteIterationResult[], DoCommandError | AgentSDKError | AgentConfigError> =>
  Effect.gen(function* () {
    const maxIterations = options.remoteIterations ?? 2;

    if (!projectConfig.checkBuild) {
      console.log(chalk.yellow('⚠️  No checkBuild configured - skipping remote iterations'));
      return [];
    }

    console.log(chalk.blue(`\n🌐 Starting remote iterations (max: ${maxIterations})`));

    // Initial build check
    const initialCheck = yield* executeCheckBuild(projectConfig, workingDirectory);

    if (initialCheck.success) {
      console.log(chalk.green('✅ Build already passing - no remote iterations needed'));
      return [];
    }

    console.log(chalk.yellow('❌ Build failed - starting remote iterations'));

    const results: RemoteIterationResult[] = [];
    let buildOutput = initialCheck.output;

    for (let i = 1; i <= maxIterations; i++) {
      console.log(chalk.blue(`\n🔄 Remote iteration ${i}/${maxIterations}`));

      const context: RemoteIterationContext = {
        issueKey,
        workingDirectory,
        iteration: i,
        totalIterations: maxIterations,
        buildFailureOutput: buildOutput,
        remoteType,
        previousAttempts: results,
      };

      // Generate prompt for fixing the build
      const prompt = generateRemoteIterationPrompt(context);

      // Execute SDK agent to fix the build
      const agentResult = yield* executeAgent({
        cwd: workingDirectory,
        maxTurns: 1,
        prompt,
        model: (options.model as 'sonnet' | 'opus' | 'haiku') || 'sonnet',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      });

      console.log(chalk.dim(`Summary: ${agentResult.summary}`));

      // Push changes (amend for Gerrit, new commit for GitHub)
      const isAmend = remoteType === 'gerrit' && i > 1;
      yield* pushToRemote(workingDirectory, remoteType, isAmend);

      // Wait for CI to start (1 minute polling interval)
      console.log(chalk.dim('⏳ Waiting 1 minute for CI to process...'));
      yield* Effect.sleep('60 seconds');

      // Check build again
      const buildCheck = yield* executeCheckBuild(projectConfig, workingDirectory);

      const result: RemoteIterationResult = {
        iteration: i,
        fixes: [...agentResult.filesModified], // Convert readonly array to mutable
        commitHash: agentResult.commitHash,
        pushed: true,
        buildCheckPassed: buildCheck.success,
        buildOutput: buildCheck.output,
      };

      results.push(result);

      if (buildCheck.success) {
        console.log(chalk.green(`✅ Build passed after ${i} remote iteration(s)!`));
        break;
      }

      console.log(chalk.yellow(`❌ Build still failing after iteration ${i}`));
      buildOutput = buildCheck.output; // Update for next iteration

      if (i === maxIterations) {
        console.log(chalk.red(`\n⚠️  Reached max remote iterations (${maxIterations})`));
        console.log(chalk.yellow('Build is still failing. Manual intervention required.'));
      }
    }

    return results;
  });
