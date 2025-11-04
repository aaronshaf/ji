import { Effect, pipe } from 'effect';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { loadProjectConfig, validateWorktreeSetup } from './project-config.js';

export class GitWorktreeError extends Error {
  readonly _tag = 'GitWorktreeError';
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
  }
}

export class GitRepositoryError extends Error {
  readonly _tag = 'GitRepositoryError';
}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly issueKey: string;
  readonly timestamp: string;
}

const execGitCommand = (command: string, cwd: string = process.cwd()) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execSync(command, { cwd, encoding: 'utf8' }).toString().trim()),
    catch: (error) => new GitWorktreeError(`Git command failed: ${command}`, error as Error),
  });

const findGitRoot = () =>
  pipe(
    execGitCommand('git rev-parse --show-toplevel'),
    Effect.mapError(() => new GitRepositoryError('Not in a git repository')),
  );

const getCurrentBranch = () => execGitCommand('git branch --show-current');

const checkBranchExists = (branchName: string) =>
  pipe(
    execGitCommand(`git show-ref --verify --quiet refs/heads/${branchName}`),
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const promptUser = (question: string): Effect.Effect<string, GitWorktreeError> =>
  Effect.async((resume) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resume(Effect.succeed(answer.trim().toLowerCase()));
    });
  });

const findWorktreeForBranch = (branchName: string) =>
  pipe(
    listWorktrees(),
    Effect.map((worktrees) => worktrees.find((wt) => wt.branch === `refs/heads/${branchName}`)),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

const deleteBranchAndWorktree = (branchName: string, worktreePath?: string) =>
  pipe(
    findGitRoot(),
    Effect.flatMap((gitRoot) =>
      pipe(
        // First, remove worktree if it exists
        worktreePath
          ? removeWorktree(worktreePath).pipe(
              Effect.tap(() => Effect.sync(() => console.log(chalk.green(`✅ Removed worktree: ${worktreePath}`)))),
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.log(chalk.yellow(`⚠️  Warning: Failed to remove worktree: ${error.message}`));
                  console.log(chalk.gray('Continuing with branch deletion...'));
                }),
              ),
            )
          : Effect.succeed(undefined),
        // Then delete the branch
        Effect.flatMap(() =>
          execGitCommand(`git branch -D ${branchName}`, gitRoot).pipe(
            Effect.tap(() => Effect.sync(() => console.log(chalk.green(`✅ Deleted branch: ${branchName}`)))),
          ),
        ),
      ),
    ),
  );

const createWorktreeDirectory = (issueKey: string) =>
  Effect.sync(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const datePrefix = `${year}-${month}-${day}`;

    const worktreeName = `${datePrefix}-${issueKey}`;
    const worktreesDir = join(homedir(), '.ji', 'worktrees');
    const worktreePath = join(worktreesDir, worktreeName);

    // Ensure the worktrees directory exists
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    return {
      path: worktreePath,
      name: worktreeName,
      timestamp: datePrefix,
    };
  });

const createGitWorktree = (gitRoot: string, worktreePath: string, branchName: string, baseBranch?: string) =>
  pipe(
    execGitCommand(
      baseBranch
        ? `git worktree add "${worktreePath}" -b "${branchName}" "origin/${baseBranch}"`
        : `git worktree add "${worktreePath}" -b "${branchName}"`,
      gitRoot,
    ),
    Effect.map(() => worktreePath),
  );

const executeWorktreeSetup = (setupCommand: string, worktreePath: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        // Use spawnSync with array args to prevent shell injection
        const result = spawnSync('zsh', ['-c', setupCommand], {
          cwd: worktreePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (result.error) {
          reject(result.error);
        } else if (result.status !== 0 && result.status !== null) {
          const error = new Error(`Command failed with exit code ${result.status}`) as Error & {
            status: number;
            stderr: string;
            stdout: string;
          };
          error.status = result.status;
          error.stderr = result.stderr;
          error.stdout = result.stdout;
          reject(error);
        } else {
          resolve(result.stdout + result.stderr);
        }
      }),
    catch: (error: unknown) => {
      const exitCode = (error as { status?: number })?.status || 1;
      const stderr = (error as { stderr?: string })?.stderr || '';
      const stdout = (error as { stdout?: string })?.stdout || '';

      return new GitWorktreeError(
        `Worktree setup failed (exit code ${exitCode}): ${setupCommand}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
      );
    },
  });

const copyProjectConfig = (gitRoot: string, worktreePath: string) =>
  Effect.sync(() => {
    // Copy .claude/ directory
    const claudeDir = join(gitRoot, '.claude');
    const worktreeClaudeDir = join(worktreePath, '.claude');

    if (existsSync(claudeDir)) {
      console.log('📁 Copying .claude/ directory to worktree...');
      try {
        cpSync(claudeDir, worktreeClaudeDir, { recursive: true });
        console.log('✅ .claude/ directory copied successfully');
      } catch (error) {
        console.log(`⚠️  Warning: Failed to copy .claude/ directory: ${error}`);
        // Continue without failing - not critical for operation
      }
    } else {
      console.log('📋 No .claude/ directory found, skipping copy');
    }

    // Copy .jiconfig.json
    const jiconfigFile = join(gitRoot, '.jiconfig.json');
    const worktreeJiconfigFile = join(worktreePath, '.jiconfig.json');

    if (existsSync(jiconfigFile)) {
      console.log('📁 Copying .jiconfig.json to worktree...');
      try {
        cpSync(jiconfigFile, worktreeJiconfigFile);
        console.log('✅ .jiconfig.json copied successfully');
      } catch (error) {
        console.log(`⚠️  Warning: Failed to copy .jiconfig.json: ${error}`);
        // Continue without failing - not critical for operation
      }
    } else {
      console.log('📋 No .jiconfig.json found, skipping copy');
    }
  });

const runProjectSetupScript = (gitRoot: string, worktreePath: string) =>
  pipe(
    loadProjectConfig(gitRoot),
    Effect.flatMap((config) => {
      if (!config.worktreeSetup) {
        console.log('📋 No worktree setup configured, skipping setup');
        return Effect.succeed('No worktree setup configured');
      }

      return pipe(
        validateWorktreeSetup(config.worktreeSetup, worktreePath),
        Effect.flatMap((setupCommand) => {
          console.log(`🔧 Running worktree setup: ${config.worktreeSetup}`);
          return pipe(
            executeWorktreeSetup(setupCommand, worktreePath),
            Effect.tap((output) =>
              Effect.sync(() => {
                if (output.trim()) {
                  console.log('Worktree setup output:');
                  console.log(output);
                }
                console.log('✅ Worktree setup completed successfully');
              }),
            ),
          );
        }),
      );
    }),
    Effect.catchAll((error) => Effect.fail(new GitWorktreeError(`Worktree setup execution failed: ${error.message}`))),
  );

export const createWorktree = (issueKey: string, baseBranch?: string) =>
  pipe(
    Effect.all([findGitRoot(), getCurrentBranch(), createWorktreeDirectory(issueKey)]),
    Effect.flatMap(([gitRoot, _currentBranch, { path, timestamp }]) => {
      const branchName = issueKey;
      return pipe(
        // Check if branch already exists first
        checkBranchExists(branchName),
        Effect.flatMap((branchExists) => {
          if (!branchExists) {
            // Branch doesn't exist, proceed normally
            return pipe(
              createGitWorktree(gitRoot, path, branchName, baseBranch),
              Effect.flatMap((worktreePath) =>
                pipe(
                  copyProjectConfig(gitRoot, worktreePath),
                  Effect.flatMap(() => runProjectSetupScript(gitRoot, worktreePath)),
                  Effect.map(
                    (): WorktreeInfo => ({
                      path: worktreePath,
                      branch: branchName,
                      issueKey,
                      timestamp,
                    }),
                  ),
                ),
              ),
            );
          }

          // Branch exists - find associated worktree and prompt user
          return pipe(
            findWorktreeForBranch(branchName),
            Effect.flatMap((existingWorktree) => {
              const worktreePath = existingWorktree?.path;

              console.log(chalk.yellow(`\n⚠️  Branch '${branchName}' already exists!`));
              if (worktreePath) {
                console.log(chalk.yellow(`   Associated worktree: ${worktreePath}`));
              }
              console.log(chalk.red('\n⚠️  WARNING: Deleting the branch will PERMANENTLY REMOVE:'));
              console.log(chalk.red('   • All commits on this branch'));
              console.log(chalk.red('   • All uncommitted changes in the worktree'));
              console.log(chalk.red('   • The worktree directory itself\n'));
              console.log(chalk.gray('To manually inspect before deleting:'));
              console.log(chalk.gray(`  git log ${branchName}`));
              if (worktreePath) {
                console.log(chalk.gray(`  cd ${worktreePath} && git status`));
              }

              return pipe(
                promptUser(chalk.bold(`\nDelete branch '${branchName}' and its worktree? (yes/no): `)),
                Effect.flatMap((answer) => {
                  if (answer !== 'yes') {
                    return Effect.fail(
                      new GitWorktreeError(
                        `Cancelled. Branch '${branchName}' still exists.\n\nTo resolve manually:\n` +
                          `  git worktree list              # See all worktrees\n` +
                          `  git worktree remove --force ${worktreePath || '<path>'}\n` +
                          `  git branch -D ${branchName}    # Delete the branch`,
                      ),
                    );
                  }

                  // User confirmed - delete branch and worktree
                  console.log(chalk.blue('\n🗑️  Deleting branch and worktree...'));
                  return pipe(
                    deleteBranchAndWorktree(branchName, worktreePath),
                    Effect.flatMap(() => {
                      console.log(chalk.green('✅ Cleanup complete. Creating new worktree...\n'));
                      // Now create the new worktree
                      return pipe(
                        createGitWorktree(gitRoot, path, branchName, baseBranch),
                        Effect.flatMap((newWorktreePath) =>
                          pipe(
                            copyProjectConfig(gitRoot, newWorktreePath),
                            Effect.flatMap(() => runProjectSetupScript(gitRoot, newWorktreePath)),
                            Effect.map(
                              (): WorktreeInfo => ({
                                path: newWorktreePath,
                                branch: branchName,
                                issueKey,
                                timestamp,
                              }),
                            ),
                          ),
                        ),
                      );
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );
    }),
    Effect.catchAll((error) =>
      Effect.fail(
        error instanceof GitWorktreeError || error instanceof GitRepositoryError
          ? error
          : new GitWorktreeError(`Failed to create worktree: ${error}`),
      ),
    ),
  );

export const removeWorktree = (worktreePath: string) =>
  pipe(
    findGitRoot(),
    Effect.flatMap((gitRoot) => execGitCommand(`git worktree remove "${worktreePath}" --force`, gitRoot)),
    Effect.catchAll((error) => Effect.fail(new GitWorktreeError(`Failed to remove worktree: ${error}`))),
  );

export const listWorktrees = () =>
  pipe(
    findGitRoot(),
    Effect.flatMap((gitRoot) => execGitCommand('git worktree list --porcelain', gitRoot)),
    Effect.map((output) => {
      const worktrees: Array<{ path: string; branch: string }> = [];
      const lines = output.split('\n');

      let currentWorktree: { path?: string; branch?: string } = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          if (currentWorktree.path && currentWorktree.branch) {
            worktrees.push({
              path: currentWorktree.path,
              branch: currentWorktree.branch,
            });
          }
          currentWorktree = { path: line.substring(9) };
        } else if (line.startsWith('branch ')) {
          currentWorktree.branch = line.substring(7);
        }
      }

      // Add the last worktree
      if (currentWorktree.path && currentWorktree.branch) {
        worktrees.push({
          path: currentWorktree.path,
          branch: currentWorktree.branch,
        });
      }

      return worktrees;
    }),
    Effect.catchAll((error) => Effect.fail(new GitWorktreeError(`Failed to list worktrees: ${error}`))),
  );

export const cleanupOldWorktrees = (maxAgeHours: number = 24) =>
  pipe(
    listWorktrees(),
    Effect.flatMap((worktrees) =>
      Effect.all(
        worktrees
          .filter((worktree) => {
            // Check if this is a ji worktree and if it's old enough
            if (!worktree.path.includes('.ji/worktrees/')) return false;

            const pathParts = worktree.path.split('/');
            const worktreeName = pathParts[pathParts.length - 1];
            const timestampMatch = worktreeName.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);

            if (!timestampMatch) return false;

            const timestamp = new Date(timestampMatch[1].replace(/-/g, ':'));
            const ageHours = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60);

            return ageHours > maxAgeHours;
          })
          .map((worktree) =>
            removeWorktree(worktree.path).pipe(
              Effect.catchAll((error) =>
                // Log the error but don't fail the entire cleanup operation
                Effect.logWarning(`Failed to cleanup worktree ${worktree.path}: ${error.message}`),
              ),
            ),
          ),
        { concurrency: 'unbounded' },
      ),
    ),
    Effect.catchAll((error) => Effect.fail(new GitWorktreeError(`Failed to cleanup old worktrees: ${error}`))),
  );

export const validateGitRepository = () =>
  pipe(
    findGitRoot(),
    Effect.flatMap(() => execGitCommand('git status --porcelain')),
    Effect.map((status) => ({
      isGitRepo: true,
      hasUncommittedChanges: status.length > 0,
      uncommittedFiles: status.split('\n').filter((line) => line.trim()).length,
    })),
    Effect.catchAll((error) => {
      if (error instanceof GitRepositoryError) {
        return Effect.succeed({
          isGitRepo: false,
          hasUncommittedChanges: false,
          uncommittedFiles: 0,
        });
      }
      return Effect.fail(error);
    }),
  );
