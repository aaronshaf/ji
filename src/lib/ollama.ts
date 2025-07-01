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

  // Helper to convert embedding to/from storage format with compression
  static embeddingToBuffer(embedding: Float32Array, compress: boolean = true): Buffer {
    if (!compress) {
      return Buffer.from(embedding.buffer);
    }
    
    // Quantize to Int8 for 4x compression
    // Find min/max for normalization
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i] < min) min = embedding[i];
      if (embedding[i] > max) max = embedding[i];
    }
    
    // Create compressed format: [min(4 bytes), max(4 bytes), quantized values(n bytes)]
    const compressed = new ArrayBuffer(8 + embedding.length);
    const view = new DataView(compressed);
    
    // Store min/max as Float32
    view.setFloat32(0, min, true);
    view.setFloat32(4, max, true);
    
    // Quantize to Int8
    const scale = (max - min) / 255;
    const quantized = new Int8Array(compressed, 8);
    for (let i = 0; i < embedding.length; i++) {
      quantized[i] = Math.round((embedding[i] - min) / scale - 128);
    }
    
    return Buffer.from(compressed);
  }

  static bufferToEmbedding(buffer: Buffer): Float32Array {
    // Check if this is compressed format (has min/max header)
    if (buffer.length > 8) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const min = view.getFloat32(0, true);
      const max = view.getFloat32(4, true);
      
      // If min/max look reasonable, assume compressed format
      if (min >= -10 && min <= 10 && max >= -10 && max <= 10 && max > min) {
        const scale = (max - min) / 255;
        const quantized = new Int8Array(buffer.buffer, buffer.byteOffset + 8, buffer.byteLength - 8);
        const embedding = new Float32Array(quantized.length);
        
        // Dequantize
        for (let i = 0; i < quantized.length; i++) {
          embedding[i] = (quantized[i] + 128) * scale + min;
        }
        
        return embedding;
      }
    }
    
    // Fall back to uncompressed format
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