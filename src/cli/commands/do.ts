import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, type Config } from '../../lib/config.js';
import { JiraClient, type Issue } from '../../lib/jira-client.js';
import { createWorktree, removeWorktree, validateGitRepository, type WorktreeInfo } from '../../lib/git-worktree.js';
import {
  createClaudeCodeClient,
  type AgenticClientConfig,
  type DevelopmentContext,
  type IterationResult,
} from '../../lib/agentic-client.js';
import { loadProjectConfig, type ProjectConfig } from '../../lib/project-config.js';
import {
  validateFiles,
  checkTestRequirements,
  createSafetyReport,
  defaultSafetyConfig,
  type SafetyConfig,
} from '../../lib/safety-controls.js';
import { formatDescription } from '../formatters/issue.js';

export class DoCommandError extends Error {
  readonly _tag = 'DoCommandError';
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
  }
}

/**
 * Validates that an issue key matches the expected Jira format (PROJECT-123).
 *
 * @param issueKey - The issue key to validate
 * @returns Effect that succeeds with the validated key or fails with DoCommandError
 *
 * @example
 * validateIssueKey('EVAL-123') // Success
 * validateIssueKey('invalid') // Fails with error
 */
const validateIssueKey = (issueKey: string) =>
  Effect.sync(() => {
    // Jira issue key format: PROJECT-123
    // Project key: 1-10 uppercase letters
    // Issue number: 1 or more digits
    if (!/^[A-Z]{1,10}-\d+$/.test(issueKey)) {
      throw new DoCommandError(
        `Invalid issue key format: "${issueKey}". Expected format: PROJECT-123 (e.g., EVAL-123, CFA-42)`,
      );
    }
    return issueKey;
  });

/**
 * Escapes XML special characters in a string for safe inclusion in XML documents.
 *
 * Replaces the following characters with their XML entity equivalents:
 * - & → &amp;
 * - < → &lt;
 * - > → &gt;
 * - " → &quot;
 * - ' → &apos;
 *
 * @param str - The string to escape
 * @returns The escaped string safe for XML inclusion
 *
 * @example
 * escapeXml('Hello & "World"') // Returns: 'Hello &amp; &quot;World&quot;'
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface DoCommandOptions {
  readonly iterations?: number;
  readonly model?: string;
  readonly dryRun?: boolean;
  readonly skipTests?: boolean;
  readonly safetyConfig?: Partial<SafetyConfig>;
  readonly clean?: boolean;
}

interface SafetyReport {
  overall: boolean;
  fileValidation: {
    valid: boolean;
    errors: string[];
    filesValidated: number;
  };
  testRequirements: {
    satisfied: boolean;
    reason: string;
  };
  additionalChecks: Record<string, boolean>;
  summary: string;
}

interface FinalResult {
  worktreeInfo: WorktreeInfo;
  allResults: IterationResult[];
  safetyReport?: SafetyReport;
  prResult?: string;
}

const detectRemoteType = () =>
  Effect.tryPromise({
    try: () => Promise.resolve(execSync('git remote -v', { encoding: 'utf8' }).toString()),
    catch: (error) => new DoCommandError(`Failed to detect remote type: ${error}`),
  }).pipe(
    Effect.map((output) => {
      const isGithub = output.toLowerCase().includes('github.com');
      const isGerrit =
        output.toLowerCase().includes('gerrit') ||
        (!isGithub && (output.includes(':29418/') || output.includes('/r/')));

      return {
        type: isGithub ? ('github' as const) : isGerrit ? ('gerrit' as const) : ('unknown' as const),
        output,
      };
    }),
  );

const detectTargetBranch = () =>
  Effect.tryPromise({
    try: () => Promise.resolve(execSync('git branch -r', { encoding: 'utf8' }).toString()),
    catch: (error) => new DoCommandError(`Failed to detect target branch: ${error}`),
  }).pipe(
    Effect.map((output) => {
      const hasMain = output.includes('origin/main');
      const hasMaster = output.includes('origin/master');

      if (hasMain) return 'main';
      if (hasMaster) return 'master';

      // Default to main if neither found
      return 'main';
    }),
  );

// Generate XML representation of the issue (same as --xml output)
const formatIssueAsXml = async (issue: Issue, config: Config, jiraClient: JiraClient): Promise<string> => {
  let xml = '<issue>\n';
  xml += '  <type>issue</type>\n';
  xml += `  <key>${issue.key}</key>\n`;
  xml += `  <link>${config.jiraUrl}/browse/${issue.key}</link>\n`;
  xml += `  <title>${escapeXml(issue.fields.summary)}</title>\n`;

  // Format dates
  const formatSmartDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  xml += `  <updated>${formatSmartDate(issue.fields.updated)}</updated>\n`;
  xml += `  <created>${formatSmartDate(issue.fields.created)}</created>\n`;
  xml += `  <status>${escapeXml(issue.fields.status.name)}</status>\n`;

  // Priority
  if (issue.fields.priority) {
    xml += `  <priority>${escapeXml(issue.fields.priority.name)}</priority>\n`;
  }

  // Reporter and Assignee
  xml += `  <reporter>${escapeXml(issue.fields.reporter.displayName)}</reporter>\n`;
  if (issue.fields.assignee) {
    xml += `  <assignee>${escapeXml(issue.fields.assignee.displayName)}</assignee>\n`;
  } else {
    xml += `  <assignee>Unassigned</assignee>\n`;
  }

  // Epic information (check common epic link fields)
  const epicField =
    issue.fields.customfield_10014 || // Epic Link (common)
    issue.fields.customfield_10008 || // Epic Link (alternative)
    issue.fields.customfield_10001 || // Epic Link (alternative)
    issue.fields.parent; // Parent issue (for subtasks and epics in next-gen projects)

  if (epicField) {
    let epicKey: string | undefined;
    let epicSummary: string | undefined;
    let epicDescription: string | undefined;

    // Extract epic key
    if (typeof epicField === 'string') {
      epicKey = epicField;
    } else if (epicField && typeof epicField === 'object') {
      const epic = epicField as { key?: string; id?: string; fields?: { summary?: string } };
      epicKey = epic.key || epic.id;
      epicSummary = epic.fields?.summary;
    }

    // If we have an epic key, fetch the full epic details
    if (epicKey) {
      try {
        const epicIssue = await jiraClient.getIssue(epicKey);
        if (epicIssue) {
          epicSummary = epicIssue.fields.summary || epicSummary;
          epicDescription = formatDescription(epicIssue.fields.description);
        }
      } catch (_error) {
        // If we can't fetch the epic, continue with what we have
        xml += `  <!-- Failed to fetch epic details for ${epicKey} -->\n`;
      }

      // Display epic information
      xml += `  <epic>\n`;
      xml += `    <key>${escapeXml(epicKey)}</key>\n`;

      if (epicSummary) {
        xml += `    <summary>${escapeXml(epicSummary)}</summary>\n`;
      }

      if (epicDescription?.trim()) {
        const cleanDescription = epicDescription
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter((line) => line.length > 0)
          .join('\n');

        xml += `    <description>\n`;
        cleanDescription.split('\n').forEach((line) => {
          xml += `      ${escapeXml(line)}\n`;
        });
        xml += `    </description>\n`;
      }

      xml += `  </epic>\n`;
    }
  }

  // Sprint information
  const sprintField =
    issue.fields.customfield_10020 ||
    issue.fields.customfield_10021 ||
    issue.fields.customfield_10016 ||
    issue.fields.customfield_10018 ||
    issue.fields.customfield_10019;

  if (sprintField) {
    let sprintName = 'Unknown Sprint';
    if (Array.isArray(sprintField) && sprintField.length > 0) {
      const sprintInfo = sprintField[0];
      if (typeof sprintInfo === 'string' && sprintInfo.includes('name=')) {
        const match = sprintInfo.match(/name=([^,\]]+)/);
        if (match) sprintName = match[1];
      } else if (sprintInfo && typeof sprintInfo === 'object' && 'name' in sprintInfo) {
        sprintName = (sprintInfo as { name: string }).name;
      }
    } else if (sprintField && typeof sprintField === 'object' && 'name' in sprintField) {
      sprintName = (sprintField as { name: string }).name;
    }
    xml += `  <sprint>${escapeXml(sprintName)}</sprint>\n`;
  }

  // Labels
  if (issue.fields.labels && issue.fields.labels.length > 0) {
    xml += `  <labels>\n`;
    issue.fields.labels.forEach((label: string) => {
      xml += `    <label>${escapeXml(label)}</label>\n`;
    });
    xml += `  </labels>\n`;
  }

  // Description - always show full description
  const description = formatDescription(issue.fields.description);
  if (description.trim()) {
    // Preserve newlines but normalize other whitespace
    const cleanDescription = description
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n');

    xml += `  <description>\n`;
    // Indent each line of the description for better readability
    cleanDescription.split('\n').forEach((line) => {
      xml += `    ${escapeXml(line)}\n`;
    });
    xml += `  </description>\n`;
  }

  // Comments - show all comments
  if (
    issue.fields.comment &&
    typeof issue.fields.comment === 'object' &&
    'comments' in issue.fields.comment &&
    Array.isArray((issue.fields.comment as { comments: unknown[] }).comments) &&
    (issue.fields.comment as { comments: unknown[] }).comments.length > 0
  ) {
    const comments = (
      issue.fields.comment as { comments: { author: { displayName: string }; created: string; body: unknown }[] }
    ).comments;

    if (comments.length > 0) {
      xml += `  <comments>\n`;

      // Show all comments in XML format
      comments.forEach((comment) => {
        // Preserve newlines but normalize other whitespace
        const commentBody = formatDescription(comment.body)
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter((line) => line.length > 0)
          .join('\n');

        xml += `    <comment>\n`;
        xml += `      <author>${escapeXml(comment.author.displayName)}</author>\n`;
        xml += `      <created>${formatSmartDate(comment.created)}</created>\n`;
        xml += `      <body>\n`;
        // Indent each line of the body for better readability
        commentBody.split('\n').forEach((line) => {
          xml += `        ${escapeXml(line)}\n`;
        });
        xml += `      </body>\n`;
        xml += `    </comment>\n`;
      });
      xml += `  </comments>\n`;
    }
  }

  xml += '</issue>';
  return xml;
};

const getIssueDescription = (issueKey: string, jiraClient: JiraClient) =>
  Effect.tryPromise({
    try: async () => {
      const issue = await jiraClient.getIssue(issueKey);

      // Get configuration for URL building
      const configManager = new ConfigManager();
      const config = await configManager.getConfig();
      if (!config) {
        throw new Error('No configuration found');
      }

      // Generate XML representation
      const xmlDescription = await formatIssueAsXml(issue, config, jiraClient);

      return {
        key: issue.key,
        summary: issue.fields.summary,
        description: xmlDescription, // Full XML representation
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
      };
    },
    catch: (error) => new DoCommandError(`Failed to fetch issue ${issueKey}: ${error}`),
  });

const executeIterations = (
  context: DevelopmentContext,
  agenticClient: ReturnType<typeof createClaudeCodeClient>,
  _options: DoCommandOptions,
) =>
  Effect.gen(function* () {
    const results: IterationResult[] = [];

    for (let i = 1; i <= context.totalIterations; i++) {
      const iterationContext = {
        ...context,
        iteration: i,
        previousResults: results,
      };

      console.log(chalk.blue(`\n📝 Starting iteration ${i}/${context.totalIterations}...`));

      const result = yield* agenticClient.executeIteration(iterationContext);
      results.push(result);

      if (result.success) {
        console.log(chalk.green(`✅ Iteration ${i} completed successfully`));
        console.log(`Summary: ${result.summary}`);
        if (result.filesModified.length > 0) {
          console.log(`Files modified: ${result.filesModified.join(', ')}`);

          // Commit handled by Claude Code during development
        }
      } else {
        console.log(chalk.red(`❌ Iteration ${i} failed`));
        console.log(`Summary: ${result.summary}`);
        if (result.errors) {
          console.log(`Errors: ${result.errors.join(', ')}`);
        }

        // Continue with remaining iterations even if one fails
      }

      // Note: Quality checks (tests, lint, typecheck) are handled by Claude Code during development
      console.log(chalk.gray('💡 Quality checks are handled by Claude Code as part of the development process'));

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

const executePublishCommand = (projectConfig: ProjectConfig, worktreePath: string, options: DoCommandOptions) =>
  Effect.sync(() => {
    if (!projectConfig.publish) {
      return null; // No publish command configured
    }

    if (options.dryRun) {
      console.log(chalk.yellow(`[DRY RUN] Would execute publish command: ${projectConfig.publish}`));
      return 'DRY RUN';
    }

    console.log(chalk.blue(`🚀 Executing publish command: ${projectConfig.publish}`));

    try {
      // Use spawnSync with shell: true but no interpolation to prevent injection
      // The command comes from a trusted config file (.jiconfig.json)
      const result = spawnSync('sh', ['-c', projectConfig.publish], {
        cwd: worktreePath,
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        throw new Error(`Command exited with code ${result.status}`);
      }

      console.log(chalk.green('✅ Publish command executed successfully'));
      return 'SUCCESS';
    } catch (error) {
      throw new DoCommandError(`Publish command failed: ${error}`);
    }
  });

const executeFinalPublishStep = (
  worktreeInfo: WorktreeInfo,
  issueInfo: { key: string; summary: string; description: string },
  allResults: IterationResult[],
  agenticClient: ReturnType<typeof createClaudeCodeClient>,
  remoteType: 'github' | 'gerrit' | 'unknown',
  projectConfig: ProjectConfig,
  allFilesModified: string[],
  options: DoCommandOptions,
) => {
  const hasCommits = allResults.some((r) => r.commitHash);

  if (allFilesModified.length === 0 && !hasCommits) {
    console.log(chalk.yellow('⚠️  No changes were made - skipping publish/PR step'));
    return Effect.succeed({
      safetyReport: {
        overall: true,
        fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
        testRequirements: { satisfied: true, reason: 'No changes made' },
        additionalChecks: {} as Record<string, boolean>,
        summary: 'No changes to publish',
      },
      prResult: 'No changes to publish',
    });
  }

  if (allFilesModified.length === 0 && hasCommits) {
    console.log(chalk.blue('📝 Commits were made - executing publish step'));
    return pipe(
      createPullRequest(worktreeInfo, issueInfo, allResults, agenticClient, remoteType, projectConfig, options),
      Effect.map((prResult) => ({
        safetyReport: {
          overall: true,
          fileValidation: { valid: true, errors: [] as string[], filesValidated: 0 },
          testRequirements: { satisfied: true, reason: 'Commits made by Claude Code' },
          additionalChecks: {} as Record<string, boolean>,
          summary: 'Publish executed for existing commits',
        },
        prResult,
      })),
    );
  }

  // Files were modified - run safety validation then publish
  return pipe(
    performSafetyValidation(allFilesModified, worktreeInfo.path, options),
    Effect.flatMap((safetyReport) => {
      if (!safetyReport.overall && !options.dryRun) {
        return Effect.fail(new DoCommandError('Safety validation failed - aborting'));
      }

      return pipe(
        createPullRequest(worktreeInfo, issueInfo, allResults, agenticClient, remoteType, projectConfig, options),
        Effect.map((prResult) => ({
          safetyReport,
          prResult,
        })),
      );
    }),
  );
};

const createPullRequest = (
  worktreeInfo: WorktreeInfo,
  issueInfo: { key: string; summary: string; description: string },
  allResults: IterationResult[],
  agenticClient: ReturnType<typeof createClaudeCodeClient>,
  remoteType: 'github' | 'gerrit' | 'unknown',
  projectConfig: ProjectConfig,
  options: DoCommandOptions,
) =>
  pipe(
    // Execute publish command first if configured
    executePublishCommand(projectConfig, worktreeInfo.path, options),
    Effect.flatMap(() =>
      Effect.sync(() => {
        if (remoteType !== 'github') {
          console.log(chalk.blue('📋 Gerrit change created - no PR needed'));
          return 'N/A - Gerrit workflow';
        }

        if (options.dryRun) {
          console.log(chalk.yellow('[DRY RUN] Would create GitHub PR'));
          return 'DRY RUN';
        }

        // Check if gh CLI is available
        try {
          execSync('gh --version', { stdio: 'pipe' });
        } catch {
          console.log(chalk.yellow('⚠️  gh CLI not available, skipping PR creation'));
          console.log(`You can manually create a PR for branch: ${worktreeInfo.branch}`);
          return 'Manual PR needed';
        }

        return worktreeInfo.branch;
      }),
    ),
    Effect.flatMap((branchOrStatus) => {
      if (
        branchOrStatus === 'N/A - Gerrit workflow' ||
        branchOrStatus === 'DRY RUN' ||
        branchOrStatus === 'Manual PR needed'
      ) {
        return Effect.succeed(branchOrStatus);
      }

      // Generate PR description
      return pipe(
        agenticClient.generatePRDescription(
          {
            issueKey: issueInfo.key,
            issueDescription: `${issueInfo.summary}\n\n${issueInfo.description}`,
            worktreePath: worktreeInfo.path,
            iteration: allResults.length,
            totalIterations: allResults.length,
            previousResults: allResults.slice(0, -1),
          },
          allResults,
        ),
        Effect.flatMap((prDescription) => {
          // Use file-based approach to avoid quote escaping issues
          const prBodyFile = join(tmpdir(), `ji-pr-body-${randomUUID()}.txt`);
          const prTitle = `feat: ${issueInfo.key} - ${issueInfo.summary}`;

          return pipe(
            Effect.tryPromise({
              try: async () => {
                await writeFile(prBodyFile, prDescription, 'utf8');
                return prBodyFile;
              },
              catch: (error) => new DoCommandError(`Failed to write PR body file: ${error}`),
            }),
            Effect.flatMap((bodyFile) =>
              Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    // Use spawnSync with array args to prevent command injection
                    // Even though gh CLI doesn't support --title-file, array args are safe
                    spawnSync('gh', ['pr', 'create', '--title', prTitle, '--body-file', bodyFile], {
                      cwd: worktreeInfo.path,
                      encoding: 'utf8',
                      stdio: ['pipe', 'pipe', 'pipe'],
                    }),
                  ),
                catch: (error) => new DoCommandError(`Failed to create PR: ${error}`),
              }).pipe(
                Effect.flatMap((result) => {
                  if (result.status !== 0) {
                    return Effect.fail(
                      new DoCommandError(
                        `gh pr create failed with exit code ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
                      ),
                    );
                  }
                  return Effect.succeed(result.stdout.toString().trim());
                }),
                Effect.tap(() =>
                  // Clean up the temporary file
                  Effect.tryPromise({
                    try: () => unlink(bodyFile),
                    catch: (error) =>
                      // Ignore cleanup errors, just log them
                      Effect.logWarning(`Failed to cleanup PR body file ${bodyFile}: ${error}`),
                  }).pipe(Effect.ignore),
                ),
              ),
            ),
          );
        }),
        Effect.map((prUrl) => {
          console.log(chalk.green('✅ Pull request created'));
          console.log(`URL: ${prUrl}`);
          return prUrl;
        }),
      );
    }),
  );

const performSafetyValidation = (modifiedFiles: string[], worktreePath: string, options: DoCommandOptions) =>
  pipe(
    Effect.all([
      validateFiles(modifiedFiles, worktreePath, { ...defaultSafetyConfig, ...options.safetyConfig }),
      checkTestRequirements(modifiedFiles, worktreePath, { ...defaultSafetyConfig, ...options.safetyConfig }),
    ]),
    Effect.flatMap(([validation, testReqs]) => createSafetyReport(validation, testReqs)),
    Effect.tap((report) =>
      Effect.sync(() => {
        console.log('\n🛡️  Safety Validation:');
        console.log(report.summary);

        if (!report.overall) {
          console.log(chalk.red('\n❌ Safety validation failed:'));
          if (report.fileValidation.errors.length > 0) {
            report.fileValidation.errors.forEach((error) => {
              console.log(chalk.red(`  • ${error}`));
            });
          }
          if (!report.testRequirements.satisfied) {
            console.log(chalk.red(`  • ${report.testRequirements.reason}`));
          }
        }
      }),
    ),
  );

/**
 * Effect-based implementation of ji do command.
 * Exported for testing purposes - use doCommand() for CLI usage.
 *
 * @internal
 */
export const doCommandEffect = (issueKey: string, options: DoCommandOptions = {}) =>
  pipe(
    // Validate issue key format
    validateIssueKey(issueKey),
    Effect.flatMap(() => validateGitRepository()),
    Effect.flatMap((gitStatus) => {
      if (!gitStatus.isGitRepo) {
        return Effect.fail(new DoCommandError('Not in a git repository'));
      }

      if (gitStatus.hasUncommittedChanges && !options.dryRun) {
        return Effect.fail(
          new DoCommandError(
            `You have ${gitStatus.uncommittedFiles} uncommitted changes. Please commit or stash them first.`,
          ),
        );
      }

      return Effect.succeed(gitStatus);
    }),

    // Get configuration and setup clients
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: async () => {
          const configManager = new ConfigManager();
          const config = await configManager.getConfig();
          if (!config) {
            throw new Error('No configuration found. Please run "ji setup" first.');
          }
          const jiraClient = new JiraClient(config);
          return { config, configManager, jiraClient };
        },
        catch: (error) => new DoCommandError(`Configuration error: ${error}`),
      }),
    ),

    // Detect remote and target branch
    Effect.flatMap(({ jiraClient }) =>
      Effect.all([detectRemoteType(), detectTargetBranch(), getIssueDescription(issueKey, jiraClient)]).pipe(
        Effect.map(([remote, targetBranch, issueInfo]) => ({
          jiraClient,
          remote,
          targetBranch,
          issueInfo,
        })),
      ),
    ),

    // Create worktree and load project config
    Effect.flatMap(({ jiraClient, remote, targetBranch, issueInfo }) =>
      createWorktree(issueKey, targetBranch).pipe(
        Effect.flatMap((worktreeInfo) =>
          loadProjectConfig(worktreeInfo.path).pipe(
            Effect.map((projectConfig) => ({
              jiraClient,
              remote,
              targetBranch,
              issueInfo,
              worktreeInfo,
              projectConfig,
            })),
          ),
        ),
      ),
    ),

    // Setup and execute iterations
    Effect.flatMap(({ remote, targetBranch, issueInfo, worktreeInfo, projectConfig }) => {
      const iterations = options.iterations || 2;
      const agenticClient = createClaudeCodeClient({
        model: options.model,
        dryRun: options.dryRun,
      });

      const context: DevelopmentContext = {
        issueKey: issueInfo.key,
        issueDescription: issueInfo.description, // This is now the full XML representation
        worktreePath: worktreeInfo.path,
        iteration: 1,
        totalIterations: iterations,
        previousResults: [],
      };

      console.log(chalk.blue(`\n🚀 Starting ji do for ${issueKey}`));
      console.log(chalk.yellow('⚠️  EXPERIMENTAL FEATURE: This command is in early development.'));
      console.log(chalk.yellow('   Always review changes before publishing.\n'));
      console.log(`Issue: ${issueInfo.summary}`);
      console.log(`Worktree: ${worktreeInfo.path}`);
      console.log(`Iterations: ${iterations}`);
      console.log(`Remote type: ${remote.type}`);
      console.log(`Target branch: ${targetBranch}`);

      return pipe(
        executeIterations(context, agenticClient, options),
        Effect.flatMap((allResults) => {
          const successfulIterations = allResults.filter((r) => r.success).length;
          const allFilesModified = Array.from(new Set(allResults.flatMap((r) => r.filesModified)));

          console.log(chalk.blue(`\n📊 Summary: ${successfulIterations}/${iterations} iterations successful`));
          console.log(`Total files modified: ${allFilesModified.length}`);

          // Execute final publish/PR step
          return pipe(
            executeFinalPublishStep(
              worktreeInfo,
              issueInfo,
              allResults,
              agenticClient,
              remote.type,
              projectConfig,
              allFilesModified,
              options,
            ),
            Effect.map(({ safetyReport, prResult }) => ({
              worktreeInfo,
              allResults,
              safetyReport,
              prResult,
            })),
          );
        }),
      );
    }),

    // Clean up or preserve worktree based on --clean flag
    Effect.flatMap((result: FinalResult) => {
      if (options.dryRun) {
        return Effect.succeed(result); // Skip cleanup in dry run
      }

      if (options.clean) {
        return pipe(
          Effect.sync(() => console.log(chalk.blue('\n🧹 Cleaning up worktree...'))),
          Effect.flatMap(() => removeWorktree(result.worktreeInfo.path)),
          Effect.map(() => {
            console.log(chalk.green('✅ Worktree cleaned up successfully'));
            return result;
          }),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.log(chalk.yellow(`⚠️  Warning: Failed to clean up worktree: ${error.message}`));
              console.log(`Manual cleanup needed: git worktree remove --force ${result.worktreeInfo.path}`);
              return result;
            }),
          ),
        );
      } else {
        return Effect.sync(() => {
          console.log(chalk.blue('\n📂 Worktree preserved for continued development'));
          console.log(`Location: ${result.worktreeInfo.path}`);
          console.log(
            chalk.gray('💡 Use --clean flag to auto-cleanup, or clean up manually: git worktree remove --force <path>'),
          );
          return result;
        });
      }
    }),
  );

export async function doCommand(issueKey: string, options: DoCommandOptions = {}) {
  try {
    await Effect.runPromise(doCommandEffect(issueKey, options));
    console.log(chalk.green(`\n✅ ji do completed successfully for ${issueKey}`));
  } catch (error) {
    console.error(chalk.red(`\n💥 ji do failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
