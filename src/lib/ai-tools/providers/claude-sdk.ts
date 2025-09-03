import { Effect, Stream, pipe } from 'effect';
import { query } from '@anthropic-ai/claude-code';
import { Schema } from 'effect';
import type { AIToolConfig, AIResponse, StreamingMessage } from '../types.ts';
import { AIProviderError, SDKError } from '../errors.ts';

// Note: Claude-specific configuration would go here if needed

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

    // Parse messages to extract result
    Effect.flatMap((messages) =>
      Effect.try({
        try: () => {
          const result = messages.find((m) => (m as any).type === 'result');
          if (!result) {
            throw new Error('No result message found in Claude response');
          }

          return {
            provider: 'claude' as const,
            content: (result as any).result || '',
            usage: (result as any).usage
              ? {
                  inputTokens: (result as any).usage.input_tokens || 0,
                  outputTokens: (result as any).usage.output_tokens || 0,
                  totalCost: (result as any).total_cost_usd,
                }
              : undefined,
            sessionId: (result as any).session_id,
            metadata: {
              duration_ms: (result as any).duration_ms,
              num_turns: (result as any).num_turns,
            },
          } satisfies AIResponse;
        },
        catch: (error) => new AIProviderError('claude', 'Failed to parse Claude response', error),
      }),
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
