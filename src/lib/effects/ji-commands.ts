import { Effect, pipe } from 'effect';
import type { Config } from '../config.js';
import type { Issue } from '../jira-client.js';
import { BaseCommand, type CommandError } from './cli-commands.js';
import { DatabaseError, NetworkError, ValidationError } from './errors.js';

/**
 * Ask command - AI-powered Q&A with context
 */
export class AskCommand extends BaseCommand<string> {
  readonly name = 'ask';
  readonly description = 'Ask a question and get AI-powered answers with context';

  validate(args: string[]): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateRequiredArgs(args, 1, 'ask'),
      Effect.flatMap(() =>
        Effect.sync(() => {
          const question = args.join(' ').trim();
          if (question.length < 3) {
            throw new ValidationError('Question must be at least 3 characters long', 'question', question);
          }
          if (question.length > 2000) {
            throw new ValidationError('Question too long (max 2000 characters)', 'question', question);
          }
        }),
      ),
    );
  }

  execute(args: string[], _config: Config): Effect.Effect<string, CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ args: cleanArgs, options }) => {
        const question = cleanArgs.join(' ');
        const model = typeof options.model === 'string' ? options.model : undefined;
        const noMemory = Boolean(options['no-memory']);

        return Effect.tryPromise({
          try: async () => {
            const { OllamaClient } = await import('../ollama.js');
            const { ContentManager } = await import('../content-manager.js');
            const { MemoryManager } = await import('../memory.js');

            const ollama = new OllamaClient();
            const contentManager = new ContentManager();
            const memoryManager = new MemoryManager();

            // Check if Ollama is available
            const available = await ollama.isAvailable();
            if (!available) {
              throw new Error('Ollama is not available. Please ensure Ollama is running.');
            }

            // Search for relevant context
            const searchResults = await contentManager.searchContent(question, {
              limit: 10,
            });

            // Get relevant memories if not disabled
            let memories: unknown[] = [];
            if (!noMemory) {
              memories = await memoryManager.getRelevantMemories(question, 5);
            }

            // Build context for AI
            const context = searchResults.map((result) => ({
              title: result.title,
              content: result.content.slice(0, 1000), // Limit context size
              source: result.source,
              url: result.url,
            }));

            const memoryContext = memories
              .map((memory) => {
                const memoryWithFacts = memory as { facts?: string };
                return memoryWithFacts.facts || '';
              })
              .join('\\n');

            // Generate AI response
            const prompt = `Based on the following context from Jira issues and Confluence pages, answer the question: "${question}"
            
Context from search results:
${context.map((c) => `Title: ${c.title}\\nContent: ${c.content}\\nSource: ${c.source}\\n`).join('\\n')}

${memoryContext ? `Previous knowledge:\\n${memoryContext}\\n` : ''}

Please provide a helpful and accurate answer based on the available context. If the context doesn't contain enough information, say so and suggest what additional information might be needed.`;

            const response = await ollama.generate(prompt, { model });

            // Save interaction to memory if response is good
            if (!noMemory && response.length > 50) {
              // Note: saveMemory method needs to be implemented
              console.log('Would save to memory:', question);
            }

            // Cleanup
            contentManager.close();
            memoryManager.close();

            return response;
          },
          catch: (error) => {
            if (error instanceof Error) {
              if (error.message.includes('Ollama')) {
                return new NetworkError(`AI service unavailable: ${error.message}`);
              }
              return new DatabaseError(`Ask failed: ${error.message}`, error);
            }
            return new DatabaseError('Unknown ask error', error);
          },
        });
      }),
    );
  }
}

/**
 * Mine command - Show user's assigned issues
 */
export class MineCommand extends BaseCommand<Issue[]> {
  readonly name = 'mine';
  readonly description = 'Show your assigned Jira issues';

  validate(_args: string[]): Effect.Effect<void, ValidationError> {
    return Effect.succeed(undefined); // Mine command has no required arguments
  }

  execute(args: string[], config: Config): Effect.Effect<Issue[], CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ options }) => {
        const limit = typeof options.limit === 'string' ? parseInt(options.limit) : 50;
        const status = typeof options.status === 'string' ? options.status : undefined;

        return Effect.tryPromise({
          try: async () => {
            const { JiraClient } = await import('../jira-client.js');
            const { CacheManager } = await import('../cache.js');

            const jiraClient = new JiraClient(config);
            const cache = new CacheManager();

            // Get current user
            const currentUser = await jiraClient.getCurrentUser();

            // Search for user's issues
            let jql = `assignee = "${currentUser.emailAddress}"`;

            if (status) {
              jql += ` AND status = "${status}"`;
            } else {
              // Default to open issues
              jql += ' AND status not in (Done, Closed, Resolved, Cancelled, Rejected, "Won\'t Do")';
            }

            jql += ' ORDER BY updated DESC';

            const searchResult = await jiraClient.searchIssues(jql, { maxResults: limit });

            // Cache results
            for (const issue of searchResult.issues) {
              cache.saveIssue(issue);
            }

            cache.close();
            return searchResult.issues;
          },
          catch: (error) => {
            if (error instanceof Error) {
              if (error.message.includes('401') || error.message.includes('403')) {
                return new ValidationError('Authentication failed. Run "ji auth" to reconfigure.');
              }
              return new NetworkError(`Failed to fetch issues: ${error.message}`);
            }
            return new NetworkError('Unknown error occurred while fetching issues');
          },
        });
      }),
    );
  }
}

/**
 * Take command - Assign issue to current user
 */
export class TakeCommand extends BaseCommand<void> {
  readonly name = 'take';
  readonly description = 'Assign a Jira issue to yourself';

  validate(args: string[]): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateRequiredArgs(args, 1, 'take'),
      Effect.flatMap(() =>
        Effect.sync(() => {
          const issueKey = args[0];
          if (!issueKey.match(/^[A-Z]+-\\d+$/)) {
            throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123', 'issueKey', issueKey);
          }
        }),
      ),
    );
  }

  execute(args: string[], config: Config): Effect.Effect<void, CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ args: cleanArgs }) => {
        const issueKey = cleanArgs[0];

        return Effect.tryPromise({
          try: async () => {
            const { JiraClient } = await import('../jira-client.js');
            const { CacheManager } = await import('../cache.js');

            const jiraClient = new JiraClient(config);
            const cache = new CacheManager();

            // Get current user
            const currentUser = await jiraClient.getCurrentUser();

            // Assign issue
            await jiraClient.assignIssue(issueKey, currentUser.accountId);

            // Update cache
            const issue = await jiraClient.getIssue(issueKey);
            cache.saveIssue(issue);
            cache.close();

            console.log(`Successfully assigned ${issueKey} to ${currentUser.displayName}`);
          },
          catch: (error) => {
            if (error instanceof Error) {
              if (error.message.includes('401') || error.message.includes('403')) {
                return new ValidationError('Authentication failed or insufficient permissions.');
              }
              if (error.message.includes('404')) {
                return new ValidationError(`Issue ${issueKey} not found.`);
              }
              return new NetworkError(`Failed to assign issue: ${error.message}`);
            }
            return new NetworkError('Unknown error occurred while assigning issue');
          },
        });
      }),
    );
  }
}

/**
 * Memory commands for managing AI memory
 */
export class MemoryCommand extends BaseCommand<unknown> {
  readonly name = 'memory';
  readonly description = 'Manage AI memory (add, list, delete)';

  validate(args: string[]): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateRequiredArgs(args, 1, 'memory'),
      Effect.flatMap(() =>
        Effect.sync(() => {
          const subcommand = args[0];
          const validSubcommands = ['add', 'list', 'delete', 'clear', 'stats'];

          if (!validSubcommands.includes(subcommand)) {
            throw new ValidationError(
              `Invalid memory subcommand. Use one of: ${validSubcommands.join(', ')}`,
              'subcommand',
              subcommand,
            );
          }

          if (subcommand === 'add' && args.length < 2) {
            throw new ValidationError('Memory add requires a fact to store', 'fact', undefined);
          }

          if (subcommand === 'delete' && args.length < 2) {
            throw new ValidationError('Memory delete requires a memory ID', 'memoryId', undefined);
          }
        }),
      ),
    );
  }

  execute(args: string[], _config: Config): Effect.Effect<unknown, CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ args: cleanArgs, options }) => {
        const subcommand = cleanArgs[0];

        return Effect.tryPromise({
          try: async () => {
            const { MemoryManager } = await import('../memory.js');
            const memoryManager = new MemoryManager();

            try {
              switch (subcommand) {
                case 'add': {
                  const fact = cleanArgs.slice(1).join(' ');
                  // Note: saveMemory method needs to be implemented
                  console.log(`Would add memory: ${fact}`);
                  return { id: 'memory-placeholder' };
                }

                case 'list': {
                  const limit = typeof options.limit === 'string' ? parseInt(options.limit) : 10;
                  const search = typeof options.search === 'string' ? options.search : undefined;

                  const memories = await memoryManager.getRelevantMemories(search || '', limit);

                  if (memories.length === 0) {
                    console.log('No memories found.');
                    return [];
                  }

                  for (const memory of memories) {
                    console.log(`ID: ${memory.id}`);
                    const memoryWithFacts = memory as { facts?: string };
                    const facts = memoryWithFacts.facts?.slice(0, 200) || 'No facts';
                    const isTruncated = memoryWithFacts.facts && memoryWithFacts.facts.length > 200;
                    console.log(`Facts: ${facts}${isTruncated ? '...' : ''}`);
                    console.log(`Created: ${new Date(memory.createdAt).toLocaleString()}`);
                    console.log('---');
                  }

                  return memories;
                }

                case 'delete': {
                  const memoryId = cleanArgs[1];
                  const deleted = await memoryManager.deleteMemory(memoryId);

                  if (deleted) {
                    console.log(`Deleted memory ${memoryId}`);
                  } else {
                    console.log(`Memory ${memoryId} not found`);
                  }

                  return { deleted };
                }

                case 'clear': {
                  const all = Boolean(options.all);

                  if (!all) {
                    throw new Error('Use --all flag to confirm clearing all memories');
                  }

                  // Note: clearAll method needs to be implemented
                  const cleared = 0; // Placeholder
                  console.log(`Would clear ${cleared} memories`);
                  return { cleared };
                }

                case 'stats': {
                  // Note: getStats method needs to be implemented
                  const stats = {
                    total: 0,
                    averageConfidence: 0,
                    mostRecent: Date.now(),
                  };
                  console.log(`Total memories: ${stats.total}`);
                  console.log(`Average confidence: ${stats.averageConfidence.toFixed(2)}`);
                  console.log(`Most recent: ${new Date(stats.mostRecent).toLocaleString()}`);
                  return stats;
                }

                default:
                  throw new Error(`Unknown subcommand: ${subcommand}`);
              }
            } finally {
              memoryManager.close();
            }
          },
          catch: (error) => {
            if (error instanceof Error) {
              return new DatabaseError(`Memory operation failed: ${error.message}`, error);
            }
            return new DatabaseError('Unknown memory error', error);
          },
        });
      }),
    );
  }
}

/**
 * Sprint command - Show sprint information
 */
export class SprintCommand extends BaseCommand<unknown> {
  readonly name = 'sprint';
  readonly description = 'Show sprint information and issues';

  validate(_args: string[]): Effect.Effect<void, ValidationError> {
    return Effect.succeed(undefined); // Sprint command can work without arguments
  }

  execute(args: string[], _config: Config): Effect.Effect<unknown, CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ args: cleanArgs, options }) => {
        const sprintId = cleanArgs[0];
        const unassigned = Boolean(options.unassigned);

        return Effect.tryPromise({
          try: async () => {
            const { JiraClient } = await import('../jira-client.js');
            const { CacheManager } = await import('../cache.js');

            const jiraClient = new JiraClient(_config);
            const cache = new CacheManager();

            let sprints;

            if (sprintId) {
              // Get specific sprint
              // Note: getSprint method needs to be implemented with board context
              const sprint = { id: parseInt(sprintId), name: `Sprint ${sprintId}` };
              sprints = [sprint];
            } else {
              // Get active sprints for user's projects
              await jiraClient.getCurrentUser();
              // Get user's issues from cache - simplified approach
              // Note: getAllIssues method needs to be implemented
              const myIssues: unknown[] = [];
              const projectKeys = [
                ...new Set(
                  myIssues
                    .map((i) => {
                      const issue = i as { project_key?: string };
                      return issue.project_key;
                    })
                    .filter(Boolean),
                ),
              ];

              const allSprints = [];
              for (const projectKey of projectKeys) {
                try {
                  // Get boards for project - simplified approach
                  const boards = [{ id: 1, name: `${projectKey} Board` }];
                  for (const board of boards) {
                    const boardSprints = await jiraClient.getActiveSprints(board.id);
                    allSprints.push(...boardSprints);
                  }
                } catch (error) {
                  console.warn(`Failed to get sprints for project ${projectKey}:`, error);
                }
              }

              sprints = allSprints;
            }

            const results = [];

            for (const sprint of sprints) {
              const sprintResult = await jiraClient.getSprintIssues(sprint.id);
              let issues = sprintResult.issues;

              if (unassigned) {
                issues = issues.filter((issue) => !issue.fields.assignee);
              }

              // Group by status
              const statusGroups = new Map<string, unknown[]>();
              for (const issue of issues) {
                const status = issue.fields.status.name;
                if (!statusGroups.has(status)) {
                  statusGroups.set(status, []);
                }
                statusGroups.get(status)?.push(issue);
              }

              results.push({
                sprint,
                totalIssues: issues.length,
                statusGroups: Object.fromEntries(statusGroups),
              });

              // Cache issues
              for (const issue of issues) {
                cache.saveIssue(issue);
              }
            }

            cache.close();
            return results;
          },
          catch: (error) => {
            if (error instanceof Error) {
              return new NetworkError(`Failed to fetch sprint data: ${error.message}`);
            }
            return new NetworkError('Unknown error occurred while fetching sprint data');
          },
        });
      }),
    );
  }
}
