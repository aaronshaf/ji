import { createHash } from 'node:crypto';
import { Effect, pipe } from 'effect';

// Error types for Ollama operations
export class OllamaError extends Error {
  readonly _tag = 'OllamaError';
}

export class NetworkError extends Error {
  readonly _tag = 'NetworkError';
}

export class GenerationError extends Error {
  readonly _tag = 'GenerationError';
}

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

export class OllamaClient {
  private baseUrl = 'http://127.0.0.1:11434';

  // Effect-based availability check
  isAvailableEffect(): Effect.Effect<boolean, NetworkError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000), // 5 second timeout
        });

        if (!response.ok) {
          if (response.status >= 500) {
            throw new NetworkError(`Ollama server error: ${response.status} ${response.statusText}`);
          }
          return false; // Ollama is running but returned client error
        }

        return true;
      },
      catch: (error) => {
        if (error instanceof NetworkError) return error;
        return new NetworkError(`Failed to connect to Ollama: ${error}`);
      },
    });
  }

  // Backward compatible version
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        console.error(`Ollama API returned ${response.status}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to connect to Ollama:', error);
      return false;
    }
  }

  // Effect-based generate
  generateEffect(
    prompt: string,
    options?: { model?: string; temperature?: number },
  ): Effect.Effect<string, ValidationError | NetworkError | GenerationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!prompt || prompt.trim().length === 0) {
          throw new ValidationError('Prompt cannot be empty');
        }
        if (prompt.length > 100000) {
          throw new ValidationError('Prompt too long (max 100k characters)');
        }
        if (options?.temperature !== undefined && (options.temperature < 0 || options.temperature > 2)) {
          throw new ValidationError('Temperature must be between 0 and 2');
        }
      }),
      Effect.flatMap(() => {
        const model = options?.model || 'gemma3n:latest';
        const temperature = options?.temperature ?? 0.7;

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                prompt,
                stream: false,
                options: {
                  temperature,
                  top_p: 0.9,
                },
              }),
              signal: AbortSignal.timeout(60000), // 60 second timeout
            });

            if (!response.ok) {
              if (response.status >= 500) {
                throw new NetworkError(`Ollama server error: ${response.status} ${response.statusText}`);
              }
              throw new GenerationError(`Generation failed: ${response.status} ${response.statusText}`);
            }

            const data = (await response.json()) as { response?: string; error?: string };

            if (data.error) {
              throw new GenerationError(`Ollama error: ${data.error}`);
            }

            if (!data.response) {
              throw new GenerationError('Empty response from Ollama');
            }

            return data.response;
          },
          catch: (error) => {
            if (error instanceof NetworkError) return error;
            if (error instanceof GenerationError) return error;
            return new NetworkError(`Failed to generate response: ${error}`);
          },
        });
      }),
    );
  }

  // Backward compatible version
  async generate(prompt: string, options?: { model?: string; temperature?: number }): Promise<string> {
    const model = options?.model || 'gemma3n:latest';
    const temperature = options?.temperature ?? 0.7;

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: {
            temperature,
            top_p: 0.9,
          },
        }),
      });

      if (!response.ok) {
        console.error(`Ollama generation failed: ${response.statusText}`);
        return '';
      }

      const data = (await response.json()) as { response: string };
      return data.response;
    } catch (error) {
      console.error('Failed to generate response:', error);
      return '';
    }
  }

  async generateStream(prompt: string, options?: { model?: string }): Promise<ReadableStream<Uint8Array> | null> {
    const model = options?.model || 'gemma3n:latest';

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: true,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          },
        }),
      });

      if (!response.ok) {
        console.error(`Ollama generation failed: ${response.statusText}`);
        return null;
      }

      return response.body;
    } catch (error) {
      console.error('Failed to generate response:', error);
      return null;
    }
  }

  // Create a hash of content for change detection (Effect version)
  static contentHashEffect(content: string): Effect.Effect<string, Error> {
    // Validate input first
    if (!content || content.length === 0) {
      return Effect.fail(new Error('Cannot hash empty content'));
    }

    if (content.length > 10_000_000) {
      // 10MB limit
      return Effect.fail(new Error('Content too large to hash'));
    }

    // Create hash using Effect.sync since this operation won't throw
    return Effect.sync(() => createHash('sha256').update(content).digest('hex').substring(0, 16));
  }

  // Backward-compatible version
  static contentHash(content: string): string {
    // Run the Effect synchronously and handle errors
    return Effect.runSync(
      pipe(
        OllamaClient.contentHashEffect(content),
        Effect.catchAll((_error) =>
          // Fallback to old behavior for compatibility
          Effect.sync(() =>
            createHash('sha256')
              .update(content || '')
              .digest('hex')
              .substring(0, 16),
          ),
        ),
      ),
    );
  }
}
