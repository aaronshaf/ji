import { Effect, Stream, pipe } from 'effect';
import { spawn } from 'node:child_process';
import type { AIToolConfig, AIResponse, StreamingMessage } from '../types.ts';
import { ProcessExecutionError, AIProviderError } from '../errors.ts';

// Execute Gemini CLI command
export const executeGeminiPrompt = (
  prompt: string,
  config: AIToolConfig,
): Effect.Effect<AIResponse, ProcessExecutionError | AIProviderError> =>
  Effect.scoped(
    pipe(
      // Create process resource with automatic cleanup
      Effect.acquireRelease(
        Effect.sync(() => {
          const args = ['--prompt', prompt];

          // Add optional flags
          if (config.model) {
            args.push('--model', config.model);
          }

          return spawn('gemini', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }),
        (process) =>
          Effect.gen(function* () {
            if (!process.killed) {
              // Try graceful shutdown first
              process.kill('SIGTERM');

              // Wait 3 seconds, then force kill if still alive
              yield* Effect.sleep(3000);
              if (!process.killed) {
                process.kill('SIGKILL');
              }
            }
          }),
      ),

      // Execute process and collect output
      Effect.flatMap((process) =>
        Effect.tryPromise({
          try: () =>
            new Promise<string>((resolve, reject) => {
              let stdout = '';
              let stderr = '';

              process.stdout?.on('data', (data) => {
                stdout += data.toString();
              });

              process.stderr?.on('data', (data) => {
                stderr += data.toString();
              });

              process.on('close', (code) => {
                if (code === 0) {
                  resolve(stdout.trim());
                } else {
                  reject(
                    new ProcessExecutionError(
                      `gemini --prompt "${prompt.substring(0, 50)}..."`,
                      code || -1,
                      stderr.trim(),
                    ),
                  );
                }
              });

              process.on('error', (error) => {
                reject(new ProcessExecutionError(`gemini --prompt "${prompt.substring(0, 50)}..."`, -1, error.message));
              });
            }),
          catch: (error) =>
            error instanceof ProcessExecutionError
              ? error
              : new ProcessExecutionError(`gemini --prompt "${prompt.substring(0, 50)}..."`, -1, String(error)),
        }),
      ),

      // Transform output to AIResponse format
      Effect.map(
        (output) =>
          ({
            provider: 'gemini' as const,
            content: output,
            usage: undefined, // Gemini CLI doesn't provide usage info in standard output
            sessionId: undefined,
            metadata: {
              command: 'gemini --prompt',
              model: config.model,
            },
          }) satisfies AIResponse,
      ),

      // Handle any unexpected errors
      Effect.mapError((error) =>
        error instanceof ProcessExecutionError ? error : new AIProviderError('gemini', 'Execution failed', error),
      ),
    ),
  );

// Streaming version (simulated since Gemini CLI doesn't support true streaming)
export const streamGeminiPrompt = (
  prompt: string,
  config: AIToolConfig,
): Stream.Stream<StreamingMessage, ProcessExecutionError | AIProviderError> =>
  Stream.fromEffect(
    pipe(
      executeGeminiPrompt(prompt, config),
      Effect.map(
        (response) =>
          ({
            type: 'result' as const,
            response,
          }) satisfies StreamingMessage,
      ),
    ),
  );
