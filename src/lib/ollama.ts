import { createHash } from 'crypto';

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



  async generate(prompt: string, options?: { model?: string }): Promise<string> {
    const model = options?.model || 'gemma3n:latest';
    
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: {
            temperature: 0.7,
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




  // Create a hash of content for change detection
  static contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }
}