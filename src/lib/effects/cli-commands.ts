import { Effect, Schedule, pipe, Option } from 'effect';
import {
  ValidationError,
  NetworkError,
  AuthenticationError,
  NotFoundError,
  DatabaseError,
  ConfigError
} from './errors.js';
import type { Config } from '../config.js';
import type { Issue } from '../jira-client.js';
import type { SearchResult } from '../content-manager.js';

/**
 * Base command interface for Effect-based CLI operations
 */
export interface Command<T = void> {
  name: string;
  description: string;
  validate: (args: string[]) => Effect.Effect<void, ValidationError>;
  execute: (args: string[], config: Config) => Effect.Effect<T, CommandError>;
}

/**
 * Command error union type
 */
export type CommandError = 
  | ValidationError 
  | NetworkError 
  | AuthenticationError 
  | NotFoundError 
  | DatabaseError 
  | ConfigError;

/**
 * Command execution context
 */
export interface CommandContext {
  config: Config;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * Base command implementation with common patterns
 */
export abstract class BaseCommand<T = void> implements Command<T> {
  abstract readonly name: string;
  abstract readonly description: string;
  
  // Retry schedule for operations that might fail transiently
  protected retrySchedule = Schedule.exponential('100 millis').pipe(
    Schedule.intersect(Schedule.recurs(2))
  );

  abstract validate(args: string[]): Effect.Effect<void, ValidationError>;
  abstract execute(args: string[], config: Config): Effect.Effect<T, CommandError>;

  /**
   * Execute command with automatic error handling and progress tracking
   */
  run(args: string[], config: Config): Effect.Effect<T, CommandError> {
    return pipe(
      this.validate(args),
      Effect.flatMap(() => this.execute(args, config)),
      Effect.retry(this.retrySchedule),
      Effect.timeout('30 seconds'),
      Effect.mapError(error => {
        if (error && typeof error === 'object' && '_tag' in error) {
          return error as CommandError;
        }
        return new ValidationError('Command execution failed', undefined, undefined, error);
      })
    );
  }

  /**
   * Helper to validate required arguments
   */
  protected validateRequiredArgs(
    args: string[], 
    required: number, 
    commandName: string
  ): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (args.length < required) {
        throw new ValidationError(
          `${commandName} requires at least ${required} argument(s), got ${args.length}`,
          'args',
          args
        );
      }
    });
  }

  /**
   * Helper to parse command options
   */
  protected parseOptions(args: string[]): Effect.Effect<{ args: string[]; options: Record<string, unknown> }, ValidationError> {
    return Effect.sync(() => {
      const options: Record<string, unknown> = {};
      const nonOptionArgs: string[] = [];
      
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
          const key = arg.slice(2);
          if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
            options[key] = args[i + 1];
            i++; // Skip next arg as it's the value
          } else {
            options[key] = true;
          }
        } else {
          nonOptionArgs.push(arg);
        }
      }
      
      return { args: nonOptionArgs, options };
    });
  }
}

/**
 * Issue view command with Effect-based implementation
 */
export class ViewIssueCommand extends BaseCommand<Issue> {
  readonly name = 'view';
  readonly description = 'View a Jira issue';

  validate(args: string[]): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateRequiredArgs(args, 1, 'view'),
      Effect.flatMap(() => Effect.sync(() => {
        const issueKey = args[0];
        if (!issueKey.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError(
            'Invalid issue key format. Expected format: PROJECT-123',
            'issueKey',
            issueKey
          );
        }
      }))
    );
  }

  execute(args: string[], config: Config): Effect.Effect<Issue, CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ args: cleanArgs, options }) => {
        const issueKey = cleanArgs[0];
        
        // Import services inside the effect to avoid circular dependencies
        return Effect.tryPromise({
          try: async () => {
            const { JiraClient } = await import('../jira-client.js');
            const { CacheManager } = await import('../cache.js');
            
            const jiraClient = new JiraClient(config);
            const cache = new CacheManager();
            
            // Try cache first if not forcing sync
            if (!options.sync) {
              const cached = await cache.getIssue(issueKey);
              if (cached) {
                return cached;
              }
            }
            
            // Fetch from API
            const issue = await jiraClient.getIssue(issueKey);
            if (!issue) {
              throw new Error(`Issue ${issueKey} not found`);
            }
            
            cache.saveIssue(issue);
            cache.close();
            
            return issue;
          },
          catch: (error) => {
            if (error instanceof Error) {
              if (error.message.includes('401') || error.message.includes('403')) {
                return new AuthenticationError(`Failed to authenticate with Jira: ${error.message}`);
              }
              if (error.message.includes('404')) {
                return new NotFoundError(`Issue ${issueKey} not found`);
              }
              return new NetworkError(`Failed to fetch issue: ${error.message}`);
            }
            return new NetworkError('Unknown error occurred while fetching issue');
          }
        });
      })
    );
  }
}

/**
 * Search command with Effect-based implementation
 */
export class SearchCommand extends BaseCommand<SearchResult[]> {
  readonly name = 'search';
  readonly description = 'Search issues and pages';

  validate(args: string[]): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateRequiredArgs(args, 1, 'search'),
      Effect.flatMap(() => Effect.sync(() => {
        const query = args.join(' ').trim();
        if (query.length < 2) {
          throw new ValidationError(
            'Search query must be at least 2 characters long',
            'query',
            query
          );
        }
        if (query.length > 1000) {
          throw new ValidationError(
            'Search query too long (max 1000 characters)',
            'query',
            query
          );
        }
      }))
    );
  }

  execute(args: string[], config: Config): Effect.Effect<SearchResult[], CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ args: cleanArgs, options }) => {
        const query = cleanArgs.join(' ');
        const limit = typeof options.limit === 'string' ? parseInt(options.limit) : 20;
        const source = options.source as 'jira' | 'confluence' | undefined;
        
        return Effect.tryPromise({
          try: async () => {
            const { ContentManager } = await import('../content-manager.js');
            const contentManager = new ContentManager();
            
            const results = await contentManager.searchContent(query, {
              source,
              limit
            });
            
            // Convert SearchableContent to SearchResult format
            const searchResults = results.map(content => ({
              content,
              score: 1.0, // Default score since searchContent doesn't return scores
              snippet: content.content.slice(0, 200) + '...'
            }));
            
            contentManager.close();
            return searchResults;
          },
          catch: (error) => {
            if (error instanceof Error) {
              return new DatabaseError(`Search failed: ${error.message}`, error);
            }
            return new DatabaseError('Unknown search error', error);
          }
        });
      })
    );
  }
}

/**
 * Sync command with Effect-based implementation and progress tracking
 */
export class SyncCommand extends BaseCommand<{ synced: number; errors: number }> {
  readonly name = 'sync';
  readonly description = 'Sync data from Jira and Confluence';

  validate(args: string[]): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      // Sync command can work without arguments (sync all)
      // or with specific workspace arguments
    });
  }

  execute(args: string[], config: Config): Effect.Effect<{ synced: number; errors: number }, CommandError> {
    return pipe(
      this.parseOptions(args),
      Effect.flatMap(({ options }) => {
        const clean = Boolean(options.clean);
        const projectKey = typeof options.project === 'string' ? options.project : undefined;
        const spaceKey = typeof options.space === 'string' ? options.space : undefined;
        
        return Effect.tryPromise({
          try: async () => {
            let totalSynced = 0;
            let totalErrors = 0;
            
            if (projectKey) {
              // Sync specific Jira project
              const { JiraClient } = await import('../jira-client.js');
              const { CacheManager } = await import('../cache.js');
              
              const jiraClient = new JiraClient(config);
              const cache = new CacheManager();
              
              try {
                const searchResult = await jiraClient.searchIssues(`project = "${projectKey}"`, { maxResults: 1000 });
                const issues = searchResult.issues;
                for (const issue of issues) {
                  try {
                    cache.saveIssue(issue);
                    totalSynced++;
                  } catch (error) {
                    console.error(`Failed to save issue ${issue.key}:`, error);
                    totalErrors++;
                  }
                }
              } catch (error) {
                console.error(`Failed to sync project ${projectKey}:`, error);
                totalErrors++;
              }
              
              cache.close();
            } else if (spaceKey) {
              // Sync specific Confluence space
              const { ConfluenceClient } = await import('../confluence-client.js');
              const { ContentManager } = await import('../content-manager.js');
              
              const confluenceClient = new ConfluenceClient(config);
              const contentManager = new ContentManager();
              
              try {
                const pages = await confluenceClient.getAllSpacePages(spaceKey);
                for (const page of pages) {
                  try {
                    await contentManager.saveContent({
                      id: `confluence:${page.id}`,
                      source: 'confluence',
                      type: 'page',
                      title: page.title,
                      content: page.body?.storage?.value || '',
                      url: page._links.webui,
                      spaceKey: page.space.key,
                      createdAt: Date.now(),
                      updatedAt: new Date(page.version.when).getTime(),
                      syncedAt: Date.now()
                    });
                    totalSynced++;
                  } catch (error) {
                    console.error(`Failed to save page ${page.id}:`, error);
                    totalErrors++;
                  }
                }
              } catch (error) {
                console.error(`Failed to sync space ${spaceKey}:`, error);
                totalErrors++;
              }
              
              contentManager.close();
            } else {
              // Sync all configured workspaces
              const { ConfigManager } = await import('../config.js');
              const configManager = new ConfigManager();
              // For now, sync all configured projects and spaces
              // This would need to be implemented based on stored configuration
              const workspaces: any[] = [];
              
              for (const workspace of workspaces) {
                if (workspace.type === 'jira_project') {
                  // Sync Jira project logic here
                  totalSynced++;
                } else if (workspace.type === 'confluence_space') {
                  // Sync Confluence space logic here
                  totalSynced++;
                }
              }
              
              configManager.close();
            }
            
            return { synced: totalSynced, errors: totalErrors };
          },
          catch: (error) => {
            if (error instanceof Error) {
              return new NetworkError(`Sync failed: ${error.message}`, error);
            }
            return new NetworkError('Unknown sync error', error);
          }
        });
      })
    );
  }
}

/**
 * Command registry for managing all available commands
 */
export class CommandRegistry {
  private commands = new Map<string, Command>();

  register<T>(command: Command<T>): void {
    this.commands.set(command.name, command);
  }

  get(name: string): Option.Option<Command> {
    const command = this.commands.get(name);
    return command ? Option.some(command) : Option.none();
  }

  getAll(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * Execute a command by name with proper error handling
   */
  executeCommand<T>(
    name: string, 
    args: string[], 
    config: Config
  ): Effect.Effect<T, CommandError | ValidationError> {
    return pipe(
      Effect.sync(() => {
        const command = this.commands.get(name);
        if (!command) {
          throw new ValidationError(
            `Unknown command: ${name}`,
            'command',
            name
          );
        }
        return command;
      }),
      Effect.flatMap(command => 
        pipe(
          command.validate(args),
          Effect.flatMap(() => command.execute(args, config)),
          Effect.retry(Schedule.exponential('100 millis').pipe(Schedule.intersect(Schedule.recurs(2)))),
          Effect.timeout('30 seconds')
        ) as Effect.Effect<T, CommandError>
      )
    );
  }
}

/**
 * Create default command registry with all built-in commands
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  
  registry.register(new ViewIssueCommand());
  registry.register(new SearchCommand());
  registry.register(new SyncCommand());
  
  return registry;
}

/**
 * CLI argument parser with validation
 */
export interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

export function parseCliArgs(argv: string[]): Effect.Effect<ParsedArgs, ValidationError> {
  return Effect.sync(() => {
    if (argv.length < 3) {
      throw new ValidationError(
        'No command specified',
        'command',
        undefined
      );
    }
    
    const command = argv[2];
    const rawArgs = argv.slice(3);
    const options: Record<string, unknown> = {};
    const args: string[] = [];
    
    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg.startsWith('--')) {
        const key = arg.slice(2);
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
          options[key] = rawArgs[i + 1];
          i++; // Skip next arg as it's the value
        } else {
          options[key] = true;
        }
      } else {
        args.push(arg);
      }
    }
    
    return { command, args, options };
  });
}