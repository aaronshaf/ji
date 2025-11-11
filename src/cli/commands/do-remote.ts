import chalk from 'chalk';
import { Effect } from 'effect';
import { execSync, spawnSync } from 'node:child_process';
import type { ProjectConfig } from '../../lib/project-config.js';
import { DoCommandError, type RemoteType } from './do-types.js';

/**
 * Result of a build check execution
 */
export interface BuildCheckResult {
  success: boolean;
  output: string;
}

/**
 * Build status states returned by checkBuildStatus command
 */
export type BuildStatus = 'pending' | 'running' | 'success' | 'failure';

/**
 * Result of checking build status
 */
export interface BuildStatusResult {
  state: BuildStatus;
  raw: string; // Raw output from command
}

/**
 * Checks the current build status by executing checkBuildStatus command.
 * Returns the state (pending, running, success, failure) by parsing JSON output.
 *
 * @param projectConfig - Project configuration containing checkBuildStatus command
 * @param workingDirectory - Directory to execute command in
 * @returns Effect with build status result
 */
export const executeCheckBuildStatus = (
  projectConfig: ProjectConfig,
  workingDirectory: string,
): Effect.Effect<BuildStatusResult, DoCommandError> =>
  Effect.sync(() => {
    if (!projectConfig.checkBuildStatus) {
      throw new DoCommandError('No checkBuildStatus configured in .jiconfig.json');
    }

    try {
      // Use spawnSync with array args to prevent command injection
      // The command comes from .jiconfig.json (trusted config), but we use
      // spawnSync for defense in depth, matching the pattern in do-publish.ts
      const result = spawnSync('sh', ['-c', projectConfig.checkBuildStatus], {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.error) {
        throw new DoCommandError(`checkBuildStatus command failed to execute: ${result.error.message}`);
      }

      if (result.status !== 0) {
        const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        throw new DoCommandError(
          `checkBuildStatus failed with exit code ${result.status}: ${output || 'Unknown error'}`,
        );
      }

      const raw = result.stdout.toString().trim();

      // Parse JSON output: { "state": "pending|running|success|failure" }
      const parsed = JSON.parse(raw);
      const state = parsed.state as BuildStatus;

      if (!['pending', 'running', 'success', 'failure'].includes(state)) {
        throw new DoCommandError(`Invalid build state: ${state}. Expected: pending, running, success, or failure`);
      }

      return { state, raw };
    } catch (error: unknown) {
      if (error instanceof DoCommandError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new DoCommandError(`checkBuildStatus returned invalid JSON: ${error.message}`);
      }
      throw new DoCommandError(`checkBuildStatus failed: ${error}`);
    }
  });

/**
 * Gets build failure logs by executing checkBuildFailures command.
 * Only call this when build status is "failure".
 *
 * @param projectConfig - Project configuration containing checkBuildFailures command
 * @param workingDirectory - Directory to execute command in
 * @returns Effect with failure logs
 */
export const executeCheckBuildFailures = (
  projectConfig: ProjectConfig,
  workingDirectory: string,
): Effect.Effect<string, DoCommandError> =>
  Effect.sync(() => {
    if (!projectConfig.checkBuildFailures) {
      throw new DoCommandError('No checkBuildFailures configured in .jiconfig.json');
    }

    console.log(chalk.blue(`📋 Getting build failure logs: ${projectConfig.checkBuildFailures}`));

    try {
      // Use spawnSync with array args to prevent command injection
      // The command comes from .jiconfig.json (trusted config), but we use
      // spawnSync for defense in depth, matching the pattern in do-publish.ts
      const result = spawnSync('sh', ['-c', projectConfig.checkBuildFailures], {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // For checkBuildFailures, we use lenient error handling - return whatever
      // output we got even if the command failed, because partial logs are better
      // than no logs when debugging build failures.
      if (result.error) {
        return `Failed to execute checkBuildFailures: ${result.error.message}`;
      }

      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      return output || 'No failure logs available';
    } catch (error: unknown) {
      // Even in catastrophic failure, return a message rather than throwing
      return `Failed to get build failure logs: ${error}`;
    }
  });

/**
 * Polls build status until it reaches a terminal state (success or failure).
 * Polls every 30 seconds while status is pending or running.
 *
 * @param projectConfig - Project configuration
 * @param workingDirectory - Directory to execute commands in
 * @param maxWaitMinutes - Maximum time to wait before giving up (default: 30 minutes)
 * @returns Effect with final BuildCheckResult
 */
export const pollBuildStatus = (
  projectConfig: ProjectConfig,
  workingDirectory: string,
  maxWaitMinutes = 30,
): Effect.Effect<BuildCheckResult, DoCommandError> =>
  Effect.gen(function* () {
    const maxAttempts = (maxWaitMinutes * 60) / 30; // Poll every 30 seconds
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;

      const statusResult = yield* executeCheckBuildStatus(projectConfig, workingDirectory);

      if (statusResult.state === 'pending') {
        console.log(chalk.dim(`⏳ Build pending (${attempts * 30}s elapsed)...`));
      } else if (statusResult.state === 'running') {
        console.log(chalk.dim(`⚙️  Build running (${attempts * 30}s elapsed)...`));
      } else if (statusResult.state === 'success') {
        console.log(chalk.green('✅ Build passed'));
        return { success: true, output: 'Build passed' };
      } else if (statusResult.state === 'failure') {
        console.log(chalk.red('❌ Build failed'));
        // Get detailed failure logs
        const failureLogs = yield* executeCheckBuildFailures(projectConfig, workingDirectory);
        return { success: false, output: failureLogs };
      }

      // Wait 30 seconds before next poll
      yield* Effect.sleep('30 seconds');
    }

    // Timeout
    throw new DoCommandError(`Build status polling timeout after ${maxWaitMinutes} minutes`);
  });

/**
 * Executes the checkBuild command and returns results.
 * Exit code 0 = success, non-zero = failure.
 * Stdout/stderr contains build logs/errors.
 *
 * DEPRECATED: Use pollBuildStatus with checkBuildStatus + checkBuildFailures instead.
 * This function is kept for backward compatibility with existing .jiconfig.json files.
 *
 * Note: This function returns success/failure as part of the result value rather
 * than using Effect's error channel. This is intentional - a failed build is an
 * expected outcome that we handle in the normal control flow, not an error condition.
 *
 * The checkBuild command comes from .jiconfig.json, which is a trusted project
 * configuration file (similar to package.json). We execute it directly with high trust.
 *
 * @param projectConfig - Project configuration containing checkBuild command
 * @param workingDirectory - Directory to execute command in
 * @returns Effect with build check result (never fails via Effect error channel)
 */
export const executeCheckBuild = (
  projectConfig: ProjectConfig,
  workingDirectory: string,
): Effect.Effect<BuildCheckResult, never> =>
  Effect.sync(() => {
    if (!projectConfig.checkBuild) {
      return { success: true, output: 'No checkBuild configured - skipping' };
    }

    console.log(chalk.blue(`🔍 Running build check: ${projectConfig.checkBuild}`));

    try {
      // Use spawnSync with array args to prevent command injection
      // The command comes from .jiconfig.json (trusted config), but we use
      // spawnSync for defense in depth, matching the pattern in do-publish.ts
      const result = spawnSync('sh', ['-c', projectConfig.checkBuild], {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.error) {
        console.log(chalk.red('❌ Build check failed'));
        return { success: false, output: `Command failed to execute: ${result.error.message}` };
      }

      if (result.status === 0) {
        console.log(chalk.green('✅ Build check passed'));
        return { success: true, output: result.stdout.toString() };
      }

      // Non-zero exit code = build failed (expected outcome)
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      console.log(chalk.red('❌ Build check failed'));
      return { success: false, output: output || 'Unknown build failure' };
    } catch (error: unknown) {
      console.log(chalk.red('❌ Build check failed'));
      return { success: false, output: `Unexpected error: ${error}` };
    }
  });

/**
 * Pushes commits to remote, handling Gerrit amend vs GitHub new commits.
 *
 * @param workingDirectory - Directory to execute git commands in
 * @param remoteType - Type of remote (github, gerrit, unknown)
 * @param isAmend - Whether to amend the last commit (for Gerrit)
 * @returns Effect indicating push success
 */
export const pushToRemote = (
  workingDirectory: string,
  remoteType: RemoteType,
  isAmend: boolean,
): Effect.Effect<boolean, DoCommandError> =>
  Effect.tryPromise({
    try: async () => {
      if (remoteType === 'gerrit' && isAmend) {
        // Gerrit: Amend the last commit to maintain single commit
        console.log(chalk.blue('📝 Amending commit for Gerrit workflow'));
        execSync('git add -A && git commit --amend --no-edit', {
          cwd: workingDirectory,
          stdio: 'inherit',
        });
      }

      // Push to remote
      console.log(chalk.blue('⬆️  Pushing changes to remote'));
      execSync('git push', {
        cwd: workingDirectory,
        stdio: 'inherit',
      });

      return true;
    },
    catch: (error) => new DoCommandError(`Failed to push: ${error}`),
  });
