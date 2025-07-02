import { Effect, pipe } from 'effect';
import { CommandError } from './cli-commands.js';
import chalk from 'chalk';

/**
 * Error display configuration
 */
export interface ErrorDisplayOptions {
  showStackTrace?: boolean;
  showSuggestions?: boolean;
  colorOutput?: boolean;
}

/**
 * Error severity levels
 */
export type ErrorSeverity = 'error' | 'warning' | 'info';

/**
 * Formatted error for display
 */
export interface FormattedError {
  severity: ErrorSeverity;
  title: string;
  message: string;
  suggestions?: string[];
  details?: string;
}

/**
 * Effect-based error reporter for CLI commands
 */
export class CliErrorReporter {
  constructor(private options: ErrorDisplayOptions = {}) {
    this.options = {
      showStackTrace: false,
      showSuggestions: true,
      colorOutput: true,
      ...options
    };
  }

  /**
   * Format error for display
   */
  formatError(error: CommandError): Effect.Effect<FormattedError, never> {
    return Effect.sync(() => {
      switch (error._tag) {
        case 'ValidationError':
          return {
            severity: 'error' as const,
            title: 'Validation Error',
            message: error.message,
            suggestions: this.getValidationSuggestions(error),
            details: error.field ? `Field: ${error.field}` : undefined
          };

        case 'AuthenticationError':
          return {
            severity: 'error' as const,
            title: 'Authentication Failed',
            message: error.message,
            suggestions: [
              'Check your API token is valid',
              'Verify your email address is correct',
              'Run "ji auth" to reconfigure credentials',
              'Ensure your Jira URL is correct'
            ]
          };

        case 'NetworkError':
          return {
            severity: 'error' as const,
            title: 'Network Error',
            message: error.message,
            suggestions: [
              'Check your internet connection',
              'Verify the Jira/Confluence URL is accessible',
              'Try again in a few moments',
              'Check if the service is experiencing downtime'
            ]
          };

        case 'NotFoundError':
          return {
            severity: 'error' as const,
            title: 'Resource Not Found',
            message: error.message,
            suggestions: [
              'Check the resource identifier (issue key, page ID, etc.)',
              'Verify you have permission to access this resource',
              'Ensure the resource exists and hasn\'t been deleted'
            ]
          };

        case 'DatabaseError':
          return {
            severity: 'error' as const,
            title: 'Database Error',
            message: error.message,
            suggestions: [
              'Try running the command again',
              'Check available disk space',
              'Run "ji sync --clean" to rebuild the cache',
              'Report this issue if it persists'
            ]
          };

        case 'ConfigError':
          return {
            severity: 'error' as const,
            title: 'Configuration Error',
            message: error.message,
            suggestions: [
              'Run "ji auth" to reconfigure',
              'Check your configuration files',
              'Verify all required settings are present'
            ]
          };

        default:
          return {
            severity: 'error' as const,
            title: 'Unknown Error',
            message: (error as any).message || 'An unknown error occurred',
            suggestions: [
              'Try running the command again',
              'Report this issue with details of what you were doing'
            ]
          };
      }
    });
  }

  /**
   * Display formatted error to console
   */
  displayError(formattedError: FormattedError): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const { colorOutput } = this.options;
      
      // Choose colors based on severity
      const titleColor = colorOutput ? this.getSeverityColor(formattedError.severity) : (text: string) => text;
      const messageColor = colorOutput ? chalk.red : (text: string) => text;
      const suggestionColor = colorOutput ? chalk.yellow : (text: string) => text;
      const detailColor = colorOutput ? chalk.gray : (text: string) => text;

      // Display title and message
      console.error(titleColor(`✗ ${formattedError.title}`));
      console.error(messageColor(`  ${formattedError.message}`));

      // Display details if available
      if (formattedError.details) {
        console.error(detailColor(`  ${formattedError.details}`));
      }

      // Display suggestions if enabled and available
      if (this.options.showSuggestions && formattedError.suggestions?.length) {
        console.error('');
        console.error(suggestionColor('Suggestions:'));
        for (const suggestion of formattedError.suggestions) {
          console.error(suggestionColor(`  • ${suggestion}`));
        }
      }

      console.error('');
    });
  }

  /**
   * Handle and display error with proper formatting
   */
  handleError(error: CommandError): Effect.Effect<void, never> {
    return pipe(
      this.formatError(error),
      Effect.flatMap(formatted => this.displayError(formatted))
    );
  }

  /**
   * Get color function based on severity
   */
  private getSeverityColor(severity: ErrorSeverity): (text: string) => string {
    switch (severity) {
      case 'error':
        return chalk.red;
      case 'warning':
        return chalk.yellow;
      case 'info':
        return chalk.blue;
      default:
        return (text: string) => text;
    }
  }

  /**
   * Get validation-specific suggestions
   */
  private getValidationSuggestions(error: any): string[] {
    const suggestions: string[] = [];
    
    if (error.field === 'issueKey' || error.message.includes('issue key')) {
      suggestions.push('Issue keys should be in format PROJECT-123 (e.g., DEV-456)');
    }
    
    if (error.field === 'query' || error.message.includes('query')) {
      suggestions.push('Search queries should be 2-1000 characters long');
      suggestions.push('Try using more specific search terms');
    }
    
    if (error.field === 'args' || error.message.includes('argument')) {
      suggestions.push('Check the command help for required arguments');
      suggestions.push('Use --help to see command usage');
    }
    
    return suggestions.length > 0 ? suggestions : [
      'Check your input and try again',
      'Use --help to see command usage'
    ];
  }
}

/**
 * Progress tracking for long-running operations
 */
export interface ProgressOptions {
  total?: number;
  message?: string;
  showPercentage?: boolean;
  showEta?: boolean;
}

export class ProgressTracker {
  private current = 0;
  private startTime = Date.now();
  
  constructor(private options: ProgressOptions = {}) {}

  /**
   * Update progress and display
   */
  update(current: number, message?: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.current = current;
      const { total, showPercentage, showEta } = this.options;
      
      let output = message || this.options.message || 'Processing...';
      
      if (total && showPercentage) {
        const percentage = Math.round((current / total) * 100);
        output += ` (${percentage}%)`;
      }
      
      if (total && showEta && current > 0) {
        const elapsed = Date.now() - this.startTime;
        const rate = current / elapsed;
        const remaining = total - current;
        const eta = remaining / rate;
        
        if (eta > 0 && eta < Infinity) {
          const etaSeconds = Math.round(eta / 1000);
          output += ` - ETA: ${etaSeconds}s`;
        }
      }
      
      // Clear previous line and show progress
      process.stdout.write(`\\r${output}                    `);
    });
  }

  /**
   * Complete progress tracking
   */
  complete(message?: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const finalMessage = message || 'Complete!';
      console.log(`\\r${finalMessage}                    `);
    });
  }
}

/**
 * Graceful shutdown handler for CLI operations
 */
export class GracefulShutdown {
  private shutdownHandlers: Array<() => Promise<void>> = [];
  private isShuttingDown = false;

  constructor() {
    // Handle common shutdown signals
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      this.shutdown('uncaughtException');
    });
  }

  /**
   * Register cleanup handler
   */
  onShutdown(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  /**
   * Perform graceful shutdown
   */
  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    
    this.isShuttingDown = true;
    console.log(`\\nReceived ${signal}, shutting down gracefully...`);
    
    try {
      // Execute all shutdown handlers
      await Promise.all(this.shutdownHandlers.map(handler => handler()));
      console.log('Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

/**
 * Create default error reporter with sensible defaults
 */
export function createDefaultErrorReporter(): CliErrorReporter {
  return new CliErrorReporter({
    showStackTrace: process.env.NODE_ENV === 'development',
    showSuggestions: true,
    colorOutput: process.stdout.isTTY
  });
}

/**
 * Effect-based wrapper for running CLI commands with proper error handling
 */
export function withErrorHandling<T>(
  effect: Effect.Effect<T, CommandError>,
  errorReporter?: CliErrorReporter
): Effect.Effect<T, never> {
  const reporter = errorReporter || createDefaultErrorReporter();
  
  return pipe(
    effect,
    Effect.catchAll(error => 
      pipe(
        reporter.handleError(error),
        Effect.flatMap(() => Effect.fail(undefined as never))
      )
    ),
    Effect.catchAll(() => Effect.succeed(undefined as never))
  );
}