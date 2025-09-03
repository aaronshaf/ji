import { Effect, Stream, pipe } from 'effect';
import { Schema } from 'effect';
import type { AIProvider, AIToolConfig, AIResponse, StreamingMessage } from './types.ts';
import { ConfigurationError, AIProviderError, type AIToolError } from './errors.ts';
import * as Claude from './providers/claude-sdk.ts';
import * as Gemini from './providers/gemini-cli.ts';
import * as Codex from './providers/codex-cli.ts';
import * as Opencode from './providers/opencode-cli.ts';

// Main client interface
export class AIClient {
  constructor(private defaultConfig: Partial<AIToolConfig> = {}) {}

  // Execute prompt with specified provider
  execute = (prompt: string, config: AIToolConfig): Effect.Effect<AIResponse, AIToolError> =>
    pipe(
      Effect.succeed(config),

      // Merge with defaults
      Effect.map(
        (validConfig) =>
          ({
            ...this.defaultConfig,
            ...validConfig,
          }) as AIToolConfig,
      ),

      // Route to appropriate provider and unify error types
      Effect.flatMap((finalConfig) => {
        switch (finalConfig.provider) {
          case 'claude':
            return Claude.executeClaudePrompt(prompt, finalConfig) as Effect.Effect<AIResponse, AIToolError>;
          case 'gemini':
            return Gemini.executeGeminiPrompt(prompt, finalConfig) as Effect.Effect<AIResponse, AIToolError>;
          case 'codex':
            return Codex.executeCodexPrompt(prompt, finalConfig) as Effect.Effect<AIResponse, AIToolError>;
          case 'opencode':
            return Opencode.executeOpencodePrompt(prompt, finalConfig) as Effect.Effect<AIResponse, AIToolError>;
          default:
            return Effect.fail(new ConfigurationError(`Unsupported provider: ${(finalConfig as any).provider}`));
        }
      }),
    );

  // Streaming version (simplified - just returns single response as stream for now)
  stream = (prompt: string, config: AIToolConfig): Stream.Stream<StreamingMessage, AIToolError> =>
    Stream.fromEffect(
      pipe(
        this.execute(prompt, config),
        Effect.map((response) => ({
          type: 'result' as const,
          response,
        })),
      ),
    );

  // Helper method to check if a provider is available
  checkProviderAvailability = (provider: AIProvider): Effect.Effect<boolean, never> =>
    pipe(
      Effect.tryPromise({
        try: async () => {
          switch (provider) {
            case 'claude':
              // Claude SDK is always available if installed
              return true;
            case 'gemini':
            case 'codex':
            case 'opencode': {
              // Check if CLI tools are available
              const { spawn } = await import('node:child_process');
              return new Promise<boolean>((resolve) => {
                const process = spawn(provider, ['--version'], { stdio: 'ignore' });
                process.on('close', (code) => resolve(code === 0));
                process.on('error', () => resolve(false));
              });
            }
            default:
              return false;
          }
        },
        catch: () => false,
      }),
      Effect.orElse(() => Effect.succeed(false)),
    );

  // Get list of available providers
  getAvailableProviders = (): Effect.Effect<AIProvider[], never> =>
    pipe(
      Effect.all([
        this.checkProviderAvailability('claude'),
        this.checkProviderAvailability('gemini'),
        this.checkProviderAvailability('codex'),
        this.checkProviderAvailability('opencode'),
      ]),
      Effect.map(([claudeAvailable, geminiAvailable, codexAvailable, opencodeAvailable]) => {
        const available: AIProvider[] = [];
        if (claudeAvailable) available.push('claude');
        if (geminiAvailable) available.push('gemini');
        if (codexAvailable) available.push('codex');
        if (opencodeAvailable) available.push('opencode');
        return available;
      }),
    );
}

// Factory function
export const createAIClient = (defaultConfig?: Partial<AIToolConfig>): AIClient => new AIClient(defaultConfig);

// Convenience function for simple execution
export const executeAI = (
  prompt: string,
  provider: AIProvider,
  options: Partial<Omit<AIToolConfig, 'provider'>> = {},
): Effect.Effect<AIResponse, AIToolError> => {
  const client = createAIClient();
  return client.execute(prompt, {
    provider,
    ...options,
  });
};
