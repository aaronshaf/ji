import { Effect, Stream, pipe } from 'effect';
import { query } from '@anthropic-ai/claude-code';
import { Schema } from 'effect';
import type { AIToolConfig, AIResponse, StreamingMessage } from '../types.ts';
import { type AIProviderError, SDKError } from '../errors.ts';

// Claude SDK response schemas using Effect Schema
const ClaudeUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_cost_usd: Schema.optional(Schema.Number),
});

const ClaudeResultMessage = Schema.Struct({
  type: Schema.Literal('result'),
  result: Schema.optional(Schema.String),
  usage: Schema.optional(ClaudeUsage),
  session_id: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  num_turns: Schema.optional(Schema.Number),
});

// ClaudeResultMessage schema is used for parsing Claude SDK responses

// Execute prompt with Claude SDK (simplified implementation)
export const executeClaudePrompt = (
  prompt: string,
  config: AIToolConfig,
): Effect.Effect<AIResponse, AIProviderError | SDKError> =>
  pipe(
    Effect.tryPromise({
      try: async () => {
        const messages: unknown[] = [];

        for await (const message of query({
          prompt,
          options: {
            model: config.model,
            maxTurns: config.maxTurns,
            appendSystemPrompt: config.systemPrompt,
            allowedTools: config.allowedTools as string[] | undefined,
          },
        })) {
          messages.push(message);
        }

        return messages;
      },
      catch: (error) => new SDKError('claude', `Query execution failed: ${String(error)}`, error),
    }),

    // Parse messages to extract result using Effect Schema
    Effect.flatMap((messages) =>
      pipe(
        Effect.try({
          try: () => {
            // Find result message
            const rawResult = messages.find(
              (m) => typeof m === 'object' && m !== null && 'type' in m && m.type === 'result',
            );

            if (!rawResult) {
              throw new Error('No result message found in Claude response');
            }

            return rawResult;
          },
          catch: (error) => new SDKError('claude', `Failed to find result message: ${String(error)}`, error),
        }),
        Effect.flatMap((rawResult) =>
          pipe(
            Schema.decodeUnknown(ClaudeResultMessage)(rawResult),
            Effect.mapError(
              (error) => new SDKError('claude', `Failed to parse Claude response: ${String(error)}`, error),
            ),
            Effect.map(
              (result): AIResponse => ({
                provider: 'claude' as const,
                content: result.result || '',
                usage: result.usage
                  ? {
                      inputTokens: result.usage.input_tokens || 0,
                      outputTokens: result.usage.output_tokens || 0,
                      totalCost: result.usage.total_cost_usd,
                    }
                  : undefined,
                sessionId: result.session_id,
                metadata: {
                  duration_ms: result.duration_ms,
                  num_turns: result.num_turns,
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );

// Streaming version (simplified - just convert single response to stream)
export const streamClaudePrompt = (
  prompt: string,
  config: AIToolConfig,
): Stream.Stream<StreamingMessage, AIProviderError | SDKError> =>
  Stream.fromEffect(
    pipe(
      executeClaudePrompt(prompt, config),
      Effect.map(
        (response) =>
          ({
            type: 'result' as const,
            response,
          }) satisfies StreamingMessage,
      ),
    ),
  );
