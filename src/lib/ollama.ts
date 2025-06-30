import { createHash } from 'crypto';

export interface EmbeddingOptions {
  model?: string;
}

export class OllamaClient {
  private baseUrl = 'http://127.0.0.1:11434';
  private model = 'mxbai-embed-large:latest';

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        console.error(`Ollama API returned ${response.status}`);
        return false;
      }
      
      // Check if our model is installed
      const data = await response.json() as { models?: Array<{ name: string }> };
      const hasModel = data.models?.some((m) => 
        m.name === this.model || m.name === 'mxbai-embed-large'
      );
      
      if (!hasModel) {
        console.log(`\n⚠️  Ollama model '${this.model}' not found.`);
        console.log(`   Available models:`, data.models?.map(m => m.name).join(', '));
        console.log(`   Run: ollama pull mxbai-embed-large`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Failed to connect to Ollama:', error);
      return false;
    }
  }

  async generateEmbedding(text: string): Promise<Float32Array | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: text
        })
      });

      if (!response.ok) {
        console.error(`Ollama embedding failed: ${response.statusText}`);
        return null;
      }

      const data = await response.json() as { embedding: number[] };
      return new Float32Array(data.embedding);
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      return null;
    }
  }

  async generateEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
    // Generate embeddings one by one (Ollama doesn't support batch)
    const embeddings: (Float32Array | null)[] = [];
    
    for (const text of texts) {
      const embedding = await this.generateEmbedding(text);
      embeddings.push(embedding);
    }
    
    return embeddings;
  }

  // Helper to convert embedding to/from storage format
  static embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer);
  }

  static bufferToEmbedding(buffer: Buffer): Float32Array {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  }

  // Calculate cosine similarity between two embeddings
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  // Create a hash of content for change detection
  static contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }
}