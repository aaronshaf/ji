import { Effect, Stream, pipe } from 'effect';
import { spawn } from 'node:child_process';
import type { AIToolConfig, AIResponse, StreamingMessage } from '../types.ts';
import { AIProviderError, ProcessExecutionError } from '../errors.ts';

// Execute prompt with opencode CLI (with process cleanup)
export const executeOpencodePrompt = (
  prompt: string,
  config: AIToolConfig,
): Effect.Effect<AIResponse, AIProviderError | ProcessExecutionError> =>
  Effect.scoped(
    pipe(
      Effect.acquireRelease(
        Effect.sync(() => {
          const args = ['-p', prompt];

          // Add optional parameters
          if (config.model) {
            args.push('--model', config.model);
          }
          if (config.temperature) {
            args.push('--temperature', config.temperature.toString());
          }
          if (config.maxTurns) {
            args.push('--max-turns', config.maxTurns.toString());
          }
          if (config.systemPrompt) {
            args.push('--system', config.systemPrompt);
          }

          return spawn('opencode', args, { stdio: 'pipe' });
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

      Effect.flatMap((process) =>
        Effect.async<string, AIProviderError | ProcessExecutionError>((resume) => {
          let stdout = '';
          let stderr = '';

          process.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
          });

          process.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
          });

          process.on('close', (code) => {
            if (code === 0) {
              resume(Effect.succeed(stdout));
            } else {
              const error = stderr || `opencode process exited with code ${code}`;
              resume(Effect.fail(new ProcessExecutionError('opencode', code || -1, error)));
            }
          });

          process.on('error', (error) => {
            resume(Effect.fail(new ProcessExecutionError('opencode', -1, `Process error: ${error.message}`)));
          });
        }),
      ),

      // Parse the output into AIResponse format
      Effect.map((output) => ({
        provider: 'opencode' as const,
        content: output.trim(),
        usage: undefined, // opencode doesn't provide usage info
        sessionId: undefined,
        metadata: undefined,
      })),

      Effect.mapError((error) =>
        error._tag === 'ProcessExecutionError'
          ? error
          : new AIProviderError('opencode', 'Failed to execute opencode CLI', error),
      ),
    ),
  );

// Streaming version (simplified - just convert single response to stream)
export const streamOpencodePrompt = (
  prompt: string,
  config: AIToolConfig,
): Stream.Stream<StreamingMessage, AIProviderError | ProcessExecutionError> =>
  Stream.fromEffect(
    pipe(
      executeOpencodePrompt(prompt, config),
      Effect.map(
        (response) =>
          ({
            type: 'result' as const,
            response,
          }) satisfies StreamingMessage,
      ),
    ),
  );
