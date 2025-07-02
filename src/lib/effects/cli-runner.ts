import { Effect, pipe, Console } from 'effect';
import { 
  CommandRegistry, 
  createDefaultRegistry, 
  parseCliArgs,
  type CommandError 
} from './cli-commands.js';
import {
  CliErrorReporter,
  GracefulShutdown,
  createDefaultErrorReporter
} from './cli-error-handling.js';
import { ValidationError, ConfigError } from './errors.js';
import type { Config } from '../config.js';
import chalk from 'chalk';

/**
 * CLI Application configuration
 */
export interface CliConfig {
  name: string;
  version: string;
  description: string;
  registry?: CommandRegistry;
  errorReporter?: CliErrorReporter;
  enableGracefulShutdown?: boolean;
}

/**
 * Main CLI application runner with Effect-based architecture
 */
export class CliRunner {
  private registry: CommandRegistry;
  private errorReporter: CliErrorReporter;
  private gracefulShutdown?: GracefulShutdown;

  constructor(private config: CliConfig) {
    this.registry = config.registry || createDefaultRegistry();
    this.errorReporter = config.errorReporter || createDefaultErrorReporter();
    
    if (config.enableGracefulShutdown !== false) {
      this.gracefulShutdown = new GracefulShutdown();
    }
  }

  /**
   * Main entry point for CLI application
   */
  run(argv: string[]): Effect.Effect<void, never> {
    return pipe(
      this.parseAndValidateArgs(argv),
      Effect.flatMap(({ command, args, options }) => 
        this.executeCommand(command, args, options)
      ),
      Effect.catchAll(error => 
        pipe(
          this.errorReporter.handleError(error),
          Effect.flatMap(() => Effect.succeed(undefined))
        )
      )
    );
  }

  /**
   * Parse and validate CLI arguments
   */
  private parseAndValidateArgs(argv: string[]): Effect.Effect<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }, CommandError> {
    return pipe(
      parseCliArgs(argv),
      Effect.flatMap(parsed => {
        // Handle built-in commands
        if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
          return pipe(
            this.showHelp(parsed.args[0]),
            Effect.flatMap(() => Effect.fail(new ValidationError('Help shown', 'command', 'help')))
          );
        }
        
        if (parsed.command === 'version' || parsed.command === '--version' || parsed.command === '-v') {
          return pipe(
            this.showVersion(),
            Effect.flatMap(() => Effect.fail(new ValidationError('Version shown', 'command', 'version')))
          );
        }
        
        return Effect.succeed(parsed);
      })
    );
  }

  /**
   * Execute a command with proper error handling and progress tracking
   */
  private executeCommand(
    commandName: string, 
    args: string[], 
    options: Record<string, unknown>
  ): Effect.Effect<void, CommandError> {
    return pipe(
      this.loadConfig(),
      Effect.flatMap(config => 
        pipe(
          this.registry.executeCommand(commandName, args, config),
          Effect.tap(result => this.handleCommandResult(result, commandName, options))
        )
      )
    );
  }

  /**
   * Load application configuration
   */
  private loadConfig(): Effect.Effect<Config, ConfigError> {
    return Effect.tryPromise({
      try: async () => {
        const { ConfigManager } = await import('../config.js');
        const configManager = new ConfigManager();
        const config = await configManager.getConfig();
        configManager.close();
        
        if (!config) {
          throw new Error('Configuration not found. Run "ji auth" to set up.');
        }
        
        return config;
      },
      catch: (error) => {
        if (error instanceof Error) {
          return new ConfigError(`Failed to load configuration: ${error.message}`, error);
        }
        return new ConfigError('Unknown configuration error', error);
      }
    });
  }

  /**
   * Handle command execution result
   */
  private handleCommandResult(
    result: unknown, 
    commandName: string, 
    options: Record<string, unknown>
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // Handle different result types based on command
      if (options.json && result) {
        console.log(JSON.stringify(result, null, 2));
      } else if (commandName === 'view' && result) {
        this.displayIssue(result);
      } else if (commandName === 'search' && Array.isArray(result)) {
        this.displaySearchResults(result as unknown[]);
      } else if (commandName === 'sync' && result) {
        this.displaySyncResults(result);
      }
    });
  }

  /**
   * Display issue information
   */
  private displayIssue(issue: unknown): void {
    const issueWithFields = issue as { key: string; fields: { summary: string; status: { name: string }; assignee?: { displayName: string }; reporter: { displayName: string }; description?: string } };
    console.log(chalk.blue.bold(`\\n${issueWithFields.key}: ${issueWithFields.fields.summary}`));
    console.log(chalk.gray(`Status: ${issueWithFields.fields.status.name}`));
    if (issueWithFields.fields.assignee) {
      console.log(chalk.gray(`Assignee: ${issueWithFields.fields.assignee.displayName}`));
    }
    console.log(chalk.gray(`Reporter: ${issueWithFields.fields.reporter.displayName}`));
    
    if (issueWithFields.fields.description) {
      console.log(chalk.gray('\\nDescription:'));
      console.log(this.formatDescription(issueWithFields.fields.description));
    }
    console.log('');
  }

  /**
   * Display search results
   */
  private displaySearchResults(results: unknown[]): void {
    if (results.length === 0) {
      console.log(chalk.yellow('No results found.'));
      return;
    }
    
    console.log(chalk.blue.bold(`\\nFound ${results.length} result(s):\\n`));
    
    for (const result of results) {
      const searchResult = result as { content: { title: string; source: string; url: string }; score: number; snippet?: string };
      const { content, score, snippet } = searchResult;
      const scoreColor = score > 0.8 ? chalk.green : score > 0.5 ? chalk.yellow : chalk.red;
      
      console.log(chalk.bold(content.title));
      console.log(chalk.gray(`Source: ${content.source} | Score: ${scoreColor(score.toFixed(2))}`));
      
      if (snippet) {
        console.log(chalk.gray(this.truncateText(snippet, 200)));
      }
      
      console.log(chalk.blue.underline(content.url));
      console.log('');
    }
  }

  /**
   * Display sync results
   */
  private displaySyncResults(results: unknown): void {
    const syncResults = results as { synced: number; errors: number };
    const { synced, errors } = syncResults;
    
    if (errors > 0) {
      console.log(chalk.yellow(`Sync completed with ${errors} error(s)`));
    } else {
      console.log(chalk.green('Sync completed successfully'));
    }
    
    console.log(chalk.gray(`Synced: ${synced} items`));
    
    if (errors > 0) {
      console.log(chalk.gray(`Errors: ${errors} items`));
    }
  }

  /**
   * Show help information
   */
  private showHelp(commandName?: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (commandName) {
        // Show help for specific command
        const command = this.registry.get(commandName);
        if (command._tag === 'Some') {
          console.log(chalk.blue.bold(`\\n${this.config.name} ${command.value.name}`));
          console.log(chalk.gray(command.value.description));
          console.log('\\nUsage:');
          console.log(chalk.yellow(`  ${this.config.name} ${command.value.name} [arguments] [options]`));
        } else {
          console.log(chalk.red(`Unknown command: ${commandName}`));
        }
      } else {
        // Show general help
        console.log(chalk.blue.bold(`\\n${this.config.name} v${this.config.version}`));
        console.log(chalk.gray(this.config.description));
        console.log('\\nUsage:');
        console.log(chalk.yellow(`  ${this.config.name} <command> [arguments] [options]`));
        console.log('\\nAvailable commands:');
        
        for (const command of this.registry.getAll()) {
          console.log(chalk.yellow(`  ${command.name.padEnd(12)} ${chalk.gray(command.description)}`));
        }
        
        console.log('\\nGlobal options:');
        console.log(chalk.yellow('  --help, -h      Show help'));
        console.log(chalk.yellow('  --version, -v   Show version'));
        console.log(chalk.yellow('  --json          Output in JSON format'));
      }
      console.log('');
    });
  }

  /**
   * Show version information
   */
  private showVersion(): Effect.Effect<void, never> {
    return Console.log(`${this.config.name} v${this.config.version}`);
  }

  /**
   * Format issue description for display
   */
  private formatDescription(description: unknown): string {
    if (typeof description === 'string') {
      return this.truncateText(description, 500);
    }
    
    // Handle ADF (Atlassian Document Format)
    if (typeof description === 'object' && description !== null && 'content' in description) {
      return this.truncateText('[Rich content - use --json for full details]', 500);
    }
    
    return '[No description]';
  }

  /**
   * Truncate text to specified length
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Register cleanup handler for graceful shutdown
   */
  onShutdown(handler: () => Promise<void>): void {
    this.gracefulShutdown?.onShutdown(handler);
  }
}

/**
 * Create and configure CLI runner for the ji application
 */
export function createJiCliRunner(): CliRunner {
  const registry = createDefaultRegistry();
  
  // Register additional ji-specific commands
  // These will be imported dynamically to avoid circular dependencies
  const registerJiCommands = async () => {
    const { 
      AskCommand, 
      MineCommand, 
      TakeCommand, 
      MemoryCommand, 
      SprintCommand 
    } = await import('./ji-commands.js');
    
    registry.register(new AskCommand());
    registry.register(new MineCommand());
    registry.register(new TakeCommand());
    registry.register(new MemoryCommand());
    registry.register(new SprintCommand());
  };
  
  // Register commands asynchronously
  registerJiCommands().catch(console.error);
  
  return new CliRunner({
    name: 'ji',
    version: '1.0.0',
    description: 'Jira & Confluence CLI tool with AI-powered search',
    registry,
    enableGracefulShutdown: true
  });
}

/**
 * Main CLI entry point
 */
export function runCli(argv: string[] = process.argv): Promise<void> {
  const runner = createJiCliRunner();
  
  // Register cleanup handlers
  runner.onShutdown(async () => {
    console.log('Cleaning up resources...');
    // Close database connections, etc.
  });
  
  return Effect.runPromise(runner.run(argv));
}

/**
 * Development helper to run CLI with specific arguments
 */
export function runCliWithArgs(...args: string[]): Promise<void> {
  return runCli(['node', 'cli.js', ...args]);
}