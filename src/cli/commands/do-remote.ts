import chalk from 'chalk';
import { Effect } from 'effect';
import { execSync } from 'node:child_process';
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
 * Type guard for exec errors with output properties
 */
interface ExecError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

function isExecError(error: unknown): error is ExecError {
  return typeof error === 'object' && error !== null && ('stdout' in error || 'stderr' in error || 'message' in error);
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
      const output = execSync(projectConfig.checkBuildStatus, {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const raw = output.toString().trim();

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
      if (isExecError(error)) {
        const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
        throw new DoCommandError(`checkBuildStatus failed: ${output || error.message || 'Unknown error'}`);
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
      const output = execSync(projectConfig.checkBuildFailures, {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      return output.toString();
    } catch (error: unknown) {
      if (isExecError(error)) {
        const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
        // For checkBuildFailures, we still want to return whatever output we got
        return output || error.message || 'Failed to get build failure logs';
      }
      return 'Failed to get build failure logs';
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
      const output = execSync(projectConfig.checkBuild, {
        cwd: workingDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      console.log(chalk.green('✅ Build check passed'));
      return { success: true, output: output.toString() };
    } catch (error: unknown) {
      // Non-zero exit code = build failed (expected outcome)
      // Extract stdout and stderr containing the failure details
      if (isExecError(error)) {
        const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
        console.log(chalk.red('❌ Build check failed'));
        return { success: false, output: output || error.message || 'Unknown build failure' };
      }

      console.log(chalk.red('❌ Build check failed'));
      return { success: false, output: 'Unknown build failure' };
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
