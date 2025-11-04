import { Effect, pipe } from 'effect';
import { Schema } from '@effect/schema';
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import chalk from 'chalk';

export class AgenticClientError extends Error {
  readonly _tag = 'AgenticClientError';
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
  }
}

export class CommandExecutionError extends Error {
  readonly _tag = 'CommandExecutionError';
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr?: string,
  ) {
    super(message);
  }
}

const IterationResultSchema = Schema.Struct({
  success: Schema.Boolean,
  summary: Schema.String,
  filesModified: Schema.Array(Schema.String),
  commitHash: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
  issueResolved: Schema.optional(Schema.Boolean), // Indicates if the issue is deemed sufficiently resolved
  reviewNotes: Schema.optional(Schema.String), // Notes from code review
});

export type IterationResult = typeof IterationResultSchema.Type;

const DevelopmentContextSchema = Schema.Struct({
  issueKey: Schema.String,
  issueDescription: Schema.String,
  worktreePath: Schema.String,
  iteration: Schema.Number,
  totalIterations: Schema.Number,
  previousResults: Schema.Array(IterationResultSchema),
});

export type DevelopmentContext = typeof DevelopmentContextSchema.Type;

export interface AgenticClientConfig {
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly dryRun?: boolean;
}

export interface AgenticClient {
  readonly executeIteration: (context: DevelopmentContext) => Effect.Effect<IterationResult, AgenticClientError>;
  readonly generateCommitMessage: (
    changes: string[],
    context: DevelopmentContext,
  ) => Effect.Effect<string, AgenticClientError>;
  readonly generatePRDescription: (
    context: DevelopmentContext,
    allResults: IterationResult[],
  ) => Effect.Effect<string, AgenticClientError>;
}

/**
 * Executes a shell command synchronously in the specified directory.
 *
 * @param command - The command to execute
 * @param cwd - The working directory in which to execute the command
 * @returns Effect that succeeds with command output or fails with CommandExecutionError
 *
 * @throws {CommandExecutionError} When the command exits with non-zero status
 *
 * @example
 * executeCommand('git status', '/path/to/repo')
 */
const executeCommand = (command: string, cwd: string) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(
        execSync(command, {
          cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
          .toString()
          .trim(),
      ),
    catch: (error: unknown) => {
      const exitCode = (error as { status?: number })?.status || 1;
      const stderr = (error as { stderr?: { toString: () => string } })?.stderr?.toString() || '';
      const stdout = (error as { stdout?: { toString: () => string } })?.stdout?.toString() || '';
      return new CommandExecutionError(
        `Command failed: ${command} (cwd: ${cwd})\nstdout: ${stdout}\nstderr: ${stderr}`,
        exitCode,
        stderr,
      );
    },
  });

const executeClaudeCode = (toolCommand: string, input: string, cwd: string) =>
  Effect.async<string, AgenticClientError>((resume) => {
    const [command, ...args] = toolCommand.split(' ');
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let error = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
      // Stream output to console so user can see progress
      process.stdout.write(data);
    });

    child.stderr.on('data', (data) => {
      error += data.toString();
      // Stream errors to console
      process.stderr.write(data);
    });

    child.on('error', (err) => {
      resume(Effect.fail(new AgenticClientError(`Failed to execute Claude Code: ${err.message}`)));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resume(Effect.succeed(output));
      } else {
        resume(Effect.fail(new AgenticClientError(`Claude Code exited with code ${code}: ${error}`)));
      }
    });

    // Send the prompt to Claude Code via stdin
    child.stdin.write(input);
    child.stdin.end();
  });

/**
 * Detects the path to the Claude Code CLI binary.
 *
 * Tries the following locations in order:
 * 1. CLAUDE_CODE_PATH environment variable
 * 2. ~/.claude/local/claude (default installation)
 * 3. ~/.local/bin/claude (alternative location)
 * 4. /usr/local/bin/claude (system-wide installation)
 *
 * @returns Effect that succeeds with the Claude Code path or fails with AgenticClientError
 *
 * @throws {AgenticClientError} When Claude Code binary cannot be found
 *
 * @example
 * detectClaudePath() // Returns: '/Users/username/.claude/local/claude'
 */
const detectClaudePath = () =>
  Effect.sync(() => {
    const candidates = [
      process.env.CLAUDE_CODE_PATH,
      `${process.env.HOME}/.claude/local/claude`,
      `${process.env.HOME}/.local/bin/claude`,
      '/usr/local/bin/claude',
    ].filter((path): path is string => Boolean(path));

    for (const path of candidates) {
      if (existsSync(path)) {
        return path;
      }
    }

    throw new AgenticClientError(
      'Claude Code CLI not found. Please install Claude Code or set the CLAUDE_CODE_PATH environment variable.\n\n' +
        'Installation instructions: https://docs.claude.com/en/docs/claude-code\n' +
        'Or set: export CLAUDE_CODE_PATH=/path/to/claude',
    );
  });

const getModifiedFiles = (worktreePath: string) =>
  pipe(
    executeCommand('git status --porcelain', worktreePath),
    Effect.map(
      (output) =>
        output
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => line.substring(3)), // Remove status indicators
    ),
    Effect.catchAll(() => Effect.succeed([])),
  );

const stageChanges = (worktreePath: string) =>
  Effect.flatMap(
    Effect.sync(() => {
      console.log(`🔍 Staging changes in: ${worktreePath}`);
      console.log(`📁 Directory exists: ${require('node:fs').existsSync(worktreePath)}`);
    }),
    () => executeCommand('git add -A', worktreePath),
  );

const createFinalCommit = (message: string, worktreePath: string) =>
  pipe(
    stageChanges(worktreePath),
    Effect.flatMap(() => executeCommand(`git commit -m "${message.replace(/"/g, '\\"')}"`, worktreePath)),
    Effect.flatMap(() => executeCommand('git rev-parse HEAD', worktreePath)),
    Effect.map((hash) => hash.substring(0, 7)),
  );

const getStagedDiff = (worktreePath: string) =>
  executeCommand('git diff --staged --stat', worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed('No staged changes')),
  );

const getStagedDiffDetailed = (worktreePath: string) =>
  executeCommand('git diff --staged', worktreePath).pipe(Effect.catchAll(() => Effect.succeed('No staged changes')));

const getWorkInProgressDiff = (worktreePath: string) =>
  pipe(
    Effect.all([
      executeCommand('git log --oneline -n 5 --all --graph --decorate', worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed('No commit history available')),
      ),
      executeCommand('git diff --staged', worktreePath).pipe(Effect.catchAll(() => Effect.succeed(''))),
      executeCommand('git diff', worktreePath).pipe(Effect.catchAll(() => Effect.succeed(''))),
    ]),
    Effect.map(([recentCommits, stagedDiff, unstagedDiff]) => {
      const hasStagedChanges = stagedDiff.trim().length > 0;
      const hasUnstagedChanges = unstagedDiff.trim().length > 0;

      let workDiff = '';
      if (hasStagedChanges) {
        workDiff += `=== STAGED CHANGES ===\n${stagedDiff}`;
      }
      if (hasUnstagedChanges) {
        if (workDiff) workDiff += '\n\n';
        workDiff += `=== UNSTAGED CHANGES ===\n${unstagedDiff}`;
      }

      return {
        recentCommits: recentCommits.trim(),
        workDiff: workDiff || 'No staged or unstaged changes',
        hasStagedChanges,
        hasUnstagedChanges,
      };
    }),
  );

export const createClaudeCodeClient = (config: AgenticClientConfig = {}): AgenticClient => ({
  executeIteration: (context: DevelopmentContext) =>
    pipe(
      Effect.sync(() => {
        if (config.dryRun) {
          console.log(
            `[DRY RUN] Would execute iteration ${context.iteration}/${context.totalIterations} for ${context.issueKey}`,
          );
          return;
        }

        // Generate the Claude Code prompt
        const prompt = generateIterationPrompt(context);
        console.log(`\n=== Iteration ${context.iteration}/${context.totalIterations} ===`);
        console.log(`Issue: ${context.issueKey}`);
        console.log(`Working directory: ${context.worktreePath}`);
        console.log('\nExecuting development iteration with Claude Code...\n');
        console.log('Prompt for Claude Code:');
        console.log('---');
        console.log(prompt);
        console.log('---\n');
      }),
      Effect.flatMap(() => {
        if (config.dryRun) {
          return Effect.succeed({
            success: true,
            summary: '[DRY RUN] Simulated development iteration',
            filesModified: [],
          } as IterationResult);
        }

        // Execute Claude Code in the worktree directory
        return executeClaudeCodeIteration(context);
      }),
    ),

  generateCommitMessage: (changes: string[], context: DevelopmentContext) =>
    Effect.sync(() => {
      const changesSummary = changes.slice(0, 3).join(', ');
      const moreFiles = changes.length > 3 ? ` and ${changes.length - 3} more files` : '';

      return `feat(${context.issueKey.split('-')[0].toLowerCase()}): address ${context.issueKey}

Modified: ${changesSummary}${moreFiles}

Resolves ${context.issueKey}

🤖 Generated with ji do - iteration ${context.iteration}/${context.totalIterations}

Co-Authored-By: Claude <noreply@anthropic.com>`;
    }),

  generatePRDescription: (context: DevelopmentContext, allResults: IterationResult[]) =>
    Effect.sync(() => {
      const successfulIterations = allResults.filter((r) => r.success);
      const totalFilesModified = new Set(allResults.flatMap((r) => r.filesModified)).size;

      return `## Summary

Automated resolution of ${context.issueKey} using agentic development.

**Issue:** ${context.issueKey}
**Iterations completed:** ${successfulIterations.length}/${context.totalIterations}
**Files modified:** ${totalFilesModified}

## Changes Made

${allResults
  .map(
    (result, index) =>
      `### Iteration ${index + 1}
- **Status:** ${result.success ? '✅ Success' : '❌ Failed'}
- **Summary:** ${result.summary}
- **Files:** ${result.filesModified.join(', ') || 'None'}`,
  )
  .join('\n\n')}

## Test Plan

- [ ] Manual verification of issue resolution
- [ ] Quality checks handled by Claude Code during development

🤖 Generated with [ji do](https://github.com/aaronshaf/ji)

Co-Authored-By: Claude <noreply@anthropic.com>`;
    }),
});

const generateIterationPrompt = (context: DevelopmentContext): string => {
  const previousContext =
    context.previousResults.length > 0
      ? `\n## Previous Iterations:\n${context.previousResults
          .map((r, i) => `Iteration ${i + 1}: ${r.summary} (Success: ${r.success})`)
          .join('\n')}\n`
      : '';

  // First iteration vs subsequent iterations have different focus
  const isFirstIteration = context.iteration === 1;
  const hasChanges = context.previousResults.some((r) => r.filesModified.length > 0);

  if (isFirstIteration) {
    return `You are helping resolve a Jira issue through iterative development.

## Issue Details
${context.issueDescription}

## Current Context
**Iteration:** ${context.iteration}/${context.totalIterations} (Initial Implementation)
**Working Directory:** ${context.worktreePath}

## Instructions for Initial Implementation
**IMPORTANT**: You are already working in a dedicated feature branch for this issue. Do NOT create any new branches - stay on the current branch throughout this entire development session.

1. Analyze the issue requirements thoroughly
2. Examine the current codebase in ${context.worktreePath}
3. Plan your approach and identify the files that need changes
4. Implement the core functionality to address the issue
5. Add basic tests if applicable
6. Ensure quality checks pass (you handle this automatically)
7. **Commit your changes** when complete:
   \`git add -A\`
   \`git commit -m "[short summary under 45 chars]

   More detailed description of changes made.
   
   Part of resolving ${context.issueKey}"\`

Focus on getting the core functionality working. Subsequent iterations will review and refine your work.`;
  }

  return `You are helping resolve a Jira issue through iterative development.

## Issue Details
${context.issueDescription}

## Current Context
**Iteration:** ${context.iteration}/${context.totalIterations} (Code Review & Refinement)
**Working Directory:** ${context.worktreePath}${previousContext}

## Instructions for Code Review Iteration
**IMPORTANT**: You are already working in a dedicated feature branch for this issue. Do NOT create any new branches - stay on the current branch throughout this entire development session.

${
  hasChanges
    ? `
### IMPORTANT: Review Previous Work First
1. **Examine the changes from iteration 1** - Check both:
   - Recent commits: \`git log --oneline -n 3\`
   - Latest commit changes: \`git diff HEAD~1 HEAD\` (or \`git show HEAD\`)
   - Any staged/unstaged changes: \`git diff --staged\` and \`git diff\`
2. **Conduct a thorough code review** of the changes made so far:
   - Check for code quality issues, bugs, or edge cases
   - Verify the implementation actually addresses the issue requirements
   - Look for missing error handling, validation, or tests
   - Check adherence to project coding standards and patterns
   - Identify potential performance or security concerns

### Decision Point: Is Further Work Needed?
3. **Assess if the issue is sufficiently resolved**:
   - Does the current implementation fully address all issue requirements?
   - Are there any critical bugs or missing functionality?
   - Do all quality checks pass (tests, lint, typecheck)?
   - Is the code production-ready with proper error handling and tests?

### If Issue is Sufficiently Resolved:
**STOP HERE** - Do not make any further changes. The implementation is complete and ready.
Simply run the quality checks to verify everything passes, then proceed without modifications.

### If Critical Issues Exist:
4. **Fix any critical issues found** in your code review:
   - Bugs or logical errors
   - Missing error handling
   - Security vulnerabilities  
   - Poor performance patterns
   - Incomplete functionality

### Enhancement and Testing (Only if Needed):
5. **Enhance the implementation only if there are gaps**:
   - Add comprehensive tests if missing or insufficient
   - Improve code documentation and comments where needed
   - Add edge case handling
   - Optimize for better performance or readability

6. **Validate the complete solution**:
   - Ensure all issue requirements are met
   - Run quality checks as needed (you handle this automatically)
   - Test edge cases and error scenarios

7. **Commit any changes made** during this iteration (if you made fixes or enhancements):
   \`git add -A\`
   \`git commit -m "[short summary under 45 chars]

   More detailed description of changes made.

   Part of resolving ${context.issueKey}"\`

   **Note**: If no changes were needed, no commit is required.

**Focus**: This iteration should primarily review and assess completeness. Only make changes if critical issues are found or requirements are not met.`
    : `
### Previous Iteration Analysis
Previous iterations did not produce file changes. Focus on:
1. Understanding why no changes were made
2. Implementing the core functionality needed
3. Ensuring the issue requirements are properly addressed`
}

This is a review and refinement iteration. Prioritize fixing critical issues over adding new features.`;
};

const executeClaudeCodeIteration = (context: DevelopmentContext): Effect.Effect<IterationResult, AgenticClientError> =>
  pipe(
    // Stage any current changes before starting
    stageChanges(context.worktreePath),
    Effect.flatMap(() =>
      pipe(
        // Show current staged changes for context, or recent commits if no staged changes
        Effect.all([getStagedDiff(context.worktreePath), getStagedDiffDetailed(context.worktreePath)]),
        Effect.flatMap(([statDiff, _detailedDiff]) => {
          const isFirstIteration = context.iteration === 1;
          const hasChanges = statDiff !== 'No staged changes';

          // For follow-up iterations, show work in progress (staged/unstaged changes)
          if (!isFirstIteration) {
            return getWorkInProgressDiff(context.worktreePath).pipe(
              Effect.tap(({ recentCommits, workDiff, hasStagedChanges, hasUnstagedChanges }) =>
                Effect.sync(() => {
                  console.log('🔍 Code Review Context - Changes made in previous iterations:');
                  console.log('=====================================');
                  console.log('Recent commits in this worktree:');
                  console.log(recentCommits);
                  console.log('');

                  if (hasStagedChanges || hasUnstagedChanges) {
                    console.log('Work from iteration 1:');
                    const diffLines = workDiff.split('\n');
                    const displayLines = diffLines.slice(0, 100);
                    console.log(displayLines.join('\n'));
                    if (diffLines.length > 100) {
                      console.log(
                        `\n... (${diffLines.length - 100} more lines - use 'git diff --staged' and 'git diff' to see all changes)`,
                      );
                    }
                  } else {
                    console.log('No changes found from iteration 1');
                  }
                  console.log('=====================================\n');
                }),
              ),
            );
          } else {
            // First iteration - only show staged changes if they exist
            if (hasChanges) {
              return Effect.sync(() => {
                console.log('📊 Current staged changes summary:');
                console.log(statDiff);
                console.log('');
              });
            } else {
              return Effect.sync(() => {
                // First iteration, no staged changes, no output needed
              });
            }
          }
        }),
        // Execute Claude Code with the generated prompt
        Effect.flatMap(() =>
          Effect.sync(() => {
            const isFirstIteration = context.iteration === 1;
            const iterationType = isFirstIteration ? 'Initial Implementation' : 'Code Review & Refinement';

            console.log(`🚀 ${iterationType} - Iteration ${context.iteration}/${context.totalIterations}`);
            console.log(`📁 Working directory: ${context.worktreePath}`);
            console.log('\n🤖 Executing Claude Code...\n');
          }),
        ),
        Effect.flatMap(() =>
          pipe(
            detectClaudePath(),
            Effect.flatMap((claudePath) => {
              const claudeCommand = `${claudePath} -p`;

              return executeCommand('git rev-parse HEAD', context.worktreePath).pipe(
                Effect.flatMap((beforeCommit) => {
                  const prompt = generateIterationPrompt(context);
                  return executeClaudeCode(claudeCommand, prompt, context.worktreePath).pipe(
                    Effect.flatMap(() =>
                      // Get HEAD commit hash after Claude Code execution
                      executeCommand('git rev-parse HEAD', context.worktreePath).pipe(
                        Effect.map((afterCommit) => ({
                          beforeCommit: beforeCommit.trim(),
                          afterCommit: afterCommit.trim(),
                          commitMade: beforeCommit.trim() !== afterCommit.trim(),
                        })),
                      ),
                    ),
                  );
                }),
                Effect.catchAll(() =>
                  // If git commands fail, continue without commit detection
                  executeClaudeCode(claudeCommand, generateIterationPrompt(context), context.worktreePath).pipe(
                    Effect.map(() => ({
                      beforeCommit: '',
                      afterCommit: '',
                      commitMade: false,
                    })),
                  ),
                ),
              );
            }),
          ),
        ),
        // Stage new changes
        Effect.flatMap((commitInfo) =>
          stageChanges(context.worktreePath).pipe(
            Effect.flatMap(() =>
              pipe(
                getModifiedFiles(context.worktreePath),
                Effect.flatMap((modifiedFiles) =>
                  pipe(
                    getStagedDiff(context.worktreePath),
                    Effect.map(
                      (_stagedDiff): IterationResult => ({
                        success: true, // Claude Code handles quality assurance
                        summary: `Iteration ${context.iteration}: Changes staged and development complete`,
                        filesModified: modifiedFiles,
                        commitHash: commitInfo.commitMade ? commitInfo.afterCommit : undefined,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    Effect.catchAll((error) => Effect.fail(new AgenticClientError(`Claude Code iteration failed: ${error}`))),
  );

// Export the final commit function for use by the main command
export const createFinalCommitWithMessage = createFinalCommit;
