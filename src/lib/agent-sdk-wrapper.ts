import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  PermissionMode,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKHookResponseMessage,
  SDKToolProgressMessage,
  SDKAuthStatusMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Effect, pipe } from 'effect';
import { Schema } from '@effect/schema';
import chalk from 'chalk';

// ============= Error Types =============

export class AgentSDKError extends Error {
  readonly _tag = 'AgentSDKError';
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class AgentExecutionError extends Error {
  readonly _tag = 'AgentExecutionError';
  constructor(
    message: string,
    public readonly details?: {
      subtype?: string;
      usage?: unknown;
    },
  ) {
    super(message);
  }
}

export class AgentConfigError extends Error {
  readonly _tag = 'AgentConfigError';
}

// ============= Schemas =============

const IterationResultSchema = Schema.Struct({
  success: Schema.Boolean,
  summary: Schema.String,
  filesModified: Schema.Array(Schema.String),
  commitHash: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
  issueResolved: Schema.optional(Schema.Boolean),
  reviewNotes: Schema.optional(Schema.String),
});

export type IterationResult = typeof IterationResultSchema.Type;

const AgentSDKOptionsSchema = Schema.Struct({
  cwd: Schema.String,
  maxTurns: Schema.Number.pipe(Schema.positive()),
  prompt: Schema.String.pipe(Schema.minLength(1)),
  model: Schema.optional(Schema.Union(Schema.Literal('sonnet'), Schema.Literal('opus'), Schema.Literal('haiku'))),
  permissionMode: Schema.optional(
    Schema.Union(
      Schema.Literal('default'),
      Schema.Literal('acceptEdits'),
      Schema.Literal('bypassPermissions'),
      Schema.Literal('plan'),
    ),
  ),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  disallowedTools: Schema.optional(Schema.Array(Schema.String)),
});

// Use mutable type for our API, we'll convert to readonly when passing to SDK
export type AgentSDKOptions = Omit<typeof AgentSDKOptionsSchema.Type, 'allowedTools' | 'disallowedTools'> & {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
};

// ============= SDK Execution =============

/**
 * Executes the Claude Agent SDK with the given options.
 *
 * This function wraps the Claude Agent SDK's query() function with Effect-based
 * error handling and streaming output. It processes SDK messages and returns
 * an iteration result.
 *
 * @param options - Configuration for the agent execution
 * @returns Effect that succeeds with IterationResult or fails with AgentSDKError | AgentConfigError
 *
 * @example
 * const result = await Effect.runPromise(
 *   executeAgent({
 *     cwd: process.cwd(),
 *     maxTurns: 1,
 *     prompt: "Fix the bug in src/main.ts",
 *     model: 'sonnet',
 *     permissionMode: 'acceptEdits',
 *   })
 * );
 */
export const executeAgent = (
  options: AgentSDKOptions,
): Effect.Effect<IterationResult, AgentSDKError | AgentConfigError> =>
  // Execute SDK directly (SDK will validate options)
  Effect.async<IterationResult, AgentSDKError | AgentConfigError>((resume) => {
    let commitHash: string | undefined;
    const filesModified: string[] = [];
    const errors: string[] = [];
    let issueResolved = false;
    let reviewNotes: string | undefined;

    // ANTHROPIC_API_KEY is optional - SDK will use local Claude Code auth if not set
    if (process.env.DEBUG && !process.env.ANTHROPIC_API_KEY) {
      console.log(chalk.dim('[DEBUG] No ANTHROPIC_API_KEY found - using local Claude Code authentication'));
    }

    const sdkQuery: Query = query({
      prompt: options.prompt,
      options: {
        cwd: options.cwd,
        maxTurns: options.maxTurns,
        model: options.model || 'sonnet',
        permissionMode: (options.permissionMode as PermissionMode) || 'acceptEdits',
        allowedTools: options.allowedTools
          ? ([...options.allowedTools] as string[])
          : (['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task'] as string[]),
        disallowedTools: options.disallowedTools ? ([...options.disallowedTools] as string[]) : undefined,
        settingSources: ['project'] as const, // Load .claude/ settings
      },
    });

    (async () => {
      try {
        for await (const message of sdkQuery) {
          handleSDKMessage(message, {
            filesModified,
            errors,
            onIssueResolved: () => {
              issueResolved = true;
            },
            onReviewNotes: (notes) => {
              reviewNotes = notes;
            },
            onCommitDetected: (hash) => {
              commitHash = hash;
            },
          });
        }

        // If we get here, the iteration completed
        resume(
          Effect.succeed({
            success: true,
            summary: 'Iteration completed successfully',
            filesModified: [...filesModified], // Convert to mutable array
            commitHash,
            errors: errors.length > 0 ? [...errors] : undefined, // Convert to mutable array
            issueResolved,
            reviewNotes,
          }),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during agent execution';
        resume(Effect.fail(new AgentSDKError(`SDK execution failed: ${errorMessage}`, error)));
      }
    })();
  });

// ============= Message Handling =============

interface MessageHandlerContext {
  filesModified: string[];
  errors: string[];
  onIssueResolved: () => void;
  onReviewNotes: (notes: string) => void;
  onCommitDetected: (hash: string) => void;
}

/**
 * Handles individual SDK messages and updates context accordingly.
 *
 * @param message - The SDK message to handle
 * @param context - Mutable context for tracking state
 */
function handleSDKMessage(message: SDKMessage, context: MessageHandlerContext): void {
  switch (message.type) {
    case 'assistant': {
      // Stream assistant messages to console
      const assistantMsg = message as SDKAssistantMessage;
      // The message is an API message object, we need to extract text content
      if (assistantMsg.message.content) {
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            process.stdout.write(block.text);
          }
        }
      }
      break;
    }

    case 'stream_event': {
      // Stream partial messages (stream_event is the actual type)
      const partialMsg = message as SDKPartialAssistantMessage;
      const event = partialMsg.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        process.stdout.write(event.delta.text);
      }
      break;
    }

    case 'system': {
      // Handle system messages
      const systemMsg = message as SDKSystemMessage | SDKCompactBoundaryMessage;
      if ('subtype' in systemMsg && systemMsg.subtype === 'compact_boundary') {
        if (process.env.DEBUG) {
          console.log(chalk.dim('\n[COMPACTION]'));
        }
      } else if (process.env.DEBUG) {
        console.log(chalk.dim(`\n[SYSTEM INIT]`));
      }
      break;
    }

    case 'result': {
      // Handle final result
      const resultMsg = message as SDKResultMessage;
      if (resultMsg.subtype === 'success') {
        // Success - check for additional metadata
        if (process.env.DEBUG) {
          console.log(chalk.dim(`\n[Usage] ${JSON.stringify(resultMsg.usage)}`));
          console.log(chalk.dim(`[Cost] $${resultMsg.total_cost_usd.toFixed(4)}`));
        }
      } else {
        // Error subtypes
        if (resultMsg.subtype === 'error_max_turns') {
          context.errors.push('Maximum turns exceeded');
        } else if (resultMsg.subtype === 'error_during_execution') {
          context.errors.push('Error during execution');
          // SDK provides errors array in error results
          if ('errors' in resultMsg && resultMsg.errors) {
            context.errors.push(...resultMsg.errors);
          }
        }
      }
      break;
    }

    case 'user':
      // User messages (shouldn't happen often, but handle gracefully)
      if (process.env.DEBUG) {
        console.log(chalk.dim('\n[USER MESSAGE]'));
      }
      break;

    case 'tool_progress': {
      // Tool progress updates
      const toolMsg = message as SDKToolProgressMessage;
      if (process.env.DEBUG) {
        console.log(chalk.dim(`\n[TOOL PROGRESS] ${toolMsg.tool_name}`));
      }
      break;
    }

    case 'auth_status': {
      // Authentication status updates
      const authMsg = message as SDKAuthStatusMessage;
      if (authMsg.error) {
        console.error(chalk.red(`\nAuth Error: ${authMsg.error}`));
        context.errors.push(`Authentication failed: ${authMsg.error}`);
      }
      break;
    }

    default: {
      // Unknown message type - this should never happen but TypeScript requires exhaustiveness
      const _exhaustive: never = message;
      if (process.env.DEBUG) {
        console.log(chalk.dim(`\n[UNKNOWN MESSAGE]`));
      }
      break;
    }
  }
}

// ============= Utility Functions =============

/**
 * Checks if the Claude Agent SDK is properly configured.
 * API key is optional - SDK will use local Claude Code authentication if not provided.
 *
 * @returns Effect that always succeeds (SDK handles auth internally)
 */
export const checkSDKConfiguration = (): Effect.Effect<void, AgentConfigError> =>
  Effect.sync(() => {
    // API key is optional - SDK uses local Claude Code auth if not set
    if (process.env.DEBUG) {
      console.log(
        chalk.dim(
          process.env.ANTHROPIC_API_KEY
            ? '[DEBUG] Using ANTHROPIC_API_KEY authentication'
            : '[DEBUG] Using local Claude Code authentication',
        ),
      );
    }
  });

/**
 * Creates a default set of agent options.
 *
 * @param cwd - Working directory
 * @param prompt - The prompt to send to the agent
 * @returns AgentSDKOptions with sensible defaults
 */
export const createDefaultOptions = (cwd: string, prompt: string): AgentSDKOptions => ({
  cwd,
  maxTurns: 1, // One turn per iteration
  prompt,
  model: 'sonnet',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task'],
});
