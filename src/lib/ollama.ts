import { createHash } from 'crypto';
import { Effect, pipe } from 'effect';

export class OllamaClient {
  private baseUrl = 'http://127.0.0.1:11434';

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
          }
        })
      });

      if (!response.ok) {
        console.error(`Ollama generation failed: ${response.statusText}`);
        return '';
      }

      const data = await response.json() as { response: string };
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
          }
        })
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
      return Effect.fail(new Error("Cannot hash empty content"));
    }
    
    if (content.length > 10_000_000) { // 10MB limit
      return Effect.fail(new Error("Content too large to hash"));
    }
    
    // Create hash using Effect.sync since this operation won't throw
    return Effect.sync(() => 
      createHash('sha256').update(content).digest('hex').substring(0, 16)
    );
  }
  
  // Backward-compatible version
  static contentHash(content: string): string {
    // Run the Effect synchronously and handle errors
    return Effect.runSync(
      pipe(
        this.contentHashEffect(content),
        Effect.catchAll((error) => 
          // Fallback to old behavior for compatibility
          Effect.sync(() => createHash('sha256').update(content || '').digest('hex').substring(0, 16))
        )
      )
    );
  }
}