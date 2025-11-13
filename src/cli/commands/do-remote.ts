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
 * - 'not_found': Change doesn't exist on remote (not pushed yet)
 * - 'pending': Build is queued but not started
 * - 'running': Build is currently executing
 * - 'success': Build completed successfully
 * - 'failure': Build failed
 */
export type BuildStatus = 'not_found' | 'pending' | 'running' | 'success' | 'failure';

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
      // Use spawnSync with shell but no interpolation to prevent command injection
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
      // Use spawnSync with shell but no interpolation to prevent command injection
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
      // Note: We don't check result.status because even if the log retrieval
      // command fails, we want to return whatever partial logs we got.
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
  Effect.sync(() => {
    if (remoteType === 'gerrit' && isAmend) {
      // Gerrit: Amend the last commit to maintain single commit
      console.log(chalk.blue('📝 Amending commit for Gerrit workflow'));

      // Use spawnSync to prevent command injection, matching pattern in do-publish.ts
      const amendResult = spawnSync('sh', ['-c', 'git add -A && git commit --amend --no-edit'], {
        cwd: workingDirectory,
        stdio: 'inherit',
      });

      if (amendResult.error) {
        throw new DoCommandError(`Failed to amend commit: ${amendResult.error.message}`);
      }

      if (amendResult.status !== 0) {
        throw new DoCommandError(`Git amend failed with exit code ${amendResult.status}`);
      }
    }

    // Push to remote
    console.log(chalk.blue('⬆️  Pushing changes to remote'));

    // Use spawnSync to prevent command injection, matching pattern in do-publish.ts
    const pushResult = spawnSync('sh', ['-c', 'git push'], {
      cwd: workingDirectory,
      stdio: 'inherit',
    });

    if (pushResult.error) {
      throw new DoCommandError(`Failed to execute git push: ${pushResult.error.message}`);
    }

    if (pushResult.status !== 0) {
      throw new DoCommandError(`Git push failed with exit code ${pushResult.status}`);
    }

    return true;
  });
