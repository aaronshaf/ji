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
 * Executes the checkBuild command and returns results.
 * Exit code 0 = success, non-zero = failure.
 * Stdout/stderr contains build logs/errors.
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
