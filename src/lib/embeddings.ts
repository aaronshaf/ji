import { pipeline, env } from '@xenova/transformers';
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { DocumentChunker } from './chunker.js';
import type { SearchableContent } from './content-manager.js';

// Configure Transformers.js
env.cacheDir = join(homedir(), '.ji', 'models');
env.localURL = join(homedir(), '.ji', 'models');

export interface EmbeddingResult {
  contentId: string;
  chunkIndex: number;
  embedding: Float32Array;
  chunkText: string;
}

export interface SearchResult {
  content: SearchableContent;
  score: number;
  snippet: string;
  chunkIndex?: number;
}

export class EmbeddingManager {
  private embedder: any;
  private db: Database;
  private chunker: DocumentChunker;
  private modelName = 'Xenova/all-MiniLM-L6-v2';
  private initialized = false;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'config.db');
    this.db = new Database(dbPath);
    this.chunker = new DocumentChunker();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    console.log('Initializing embeddings model (first time may take a moment to download)...');
    this.embedder = await pipeline('feature-extraction', this.modelName);
    this.initialized = true;
    console.log('Embeddings model ready.');
  }

  async embedContent(content: SearchableContent): Promise<void> {
    await this.initialize();

    // Delete existing embeddings for this content
    const deleteStmt = this.db.prepare('DELETE FROM content_embeddings WHERE content_id = ?');
    deleteStmt.run(content.id);

    // Chunk the content
    const fullText = `${content.title}\n\n${content.content}`;
    const chunks = this.chunker.chunk(fullText);

    // Generate embeddings for each chunk
    for (const chunk of chunks) {
      const embedding = await this.generateEmbedding(chunk.text);
      await this.saveEmbedding({
        contentId: content.id,
        chunkIndex: chunk.index,
        embedding: embedding,
        chunkText: chunk.text
      });
    }
  }

  async searchSemantic(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    await this.initialize();

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Build SQL query
    let sql = `
      SELECT 
        ce.content_id,
        ce.chunk_index,
        ce.chunk_text,
        ce.embedding,
        sc.source,
        sc.type,
        sc.title,
        sc.content,
        sc.url,
        sc.space_key,
        sc.project_key,
        sc.metadata,
        sc.created_at,
        sc.updated_at,
        sc.synced_at
      FROM content_embeddings ce
      JOIN searchable_content sc ON sc.id = ce.content_id
    `;

    const conditions: string[] = [];
    const params: any[] = [];

    if (options?.source) {
      conditions.push('sc.source = ?');
      params.push(options.source);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    // Calculate similarities and sort
    const results: SearchResult[] = [];
    
    for (const row of rows) {
      const embedding = new Float32Array(row.embedding.buffer);
      const score = this.cosineSimilarity(queryEmbedding, embedding);
      
      results.push({
        content: {
          id: row.content_id,
          source: row.source,
          type: row.type,
          title: row.title,
          content: row.content,
          url: row.url,
          spaceKey: row.space_key,
          projectKey: row.project_key,
          metadata: JSON.parse(row.metadata || '{}'),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          syncedAt: row.synced_at
        },
        score,
        snippet: this.generateSnippet(row.chunk_text, 150),
        chunkIndex: row.chunk_index
      });
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options?.limit || 20);
  }

  async hybridSearch(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    await this.initialize();

    // Get FTS results
    const ftsResults = await this.searchFTS(query, options);
    
    // Get semantic results
    const semanticResults = await this.searchSemantic(query, {
      ...options,
      limit: (options?.limit || 20) * 2 // Get more for merging
    });

    // Merge and deduplicate results
    const merged = new Map<string, SearchResult>();
    
    // Add FTS results with boosted scores
    for (const result of ftsResults) {
      merged.set(result.content.id, {
        ...result,
        score: result.score * 1.2 // Boost exact matches
      });
    }

    // Add semantic results
    for (const result of semanticResults) {
      const existing = merged.get(result.content.id);
      if (existing) {
        // Combine scores
        existing.score = (existing.score + result.score) / 2;
      } else {
        merged.set(result.content.id, result);
      }
    }

    // Sort and limit
    const results = Array.from(merged.values());
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options?.limit || 20);
  }

  private async searchFTS(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    let sql = `
      SELECT 
        sc.*,
        snippet(content_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
        bm25(content_fts) as rank
      FROM searchable_content sc
      JOIN content_fts ON content_fts.id = sc.id
      WHERE content_fts MATCH ?
    `;

    const params: any[] = [query];

    if (options?.source) {
      sql += ' AND sc.source = ?';
      params.push(options.source);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(options?.limit || 20);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      content: {
        id: row.id,
        source: row.source,
        type: row.type,
        title: row.title,
        content: row.content,
        url: row.url,
        spaceKey: row.space_key,
        projectKey: row.project_key,
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        syncedAt: row.synced_at
      },
      score: -row.rank, // BM25 returns negative scores
      snippet: row.snippet
    }));
  }

  private async generateEmbedding(text: string): Promise<Float32Array> {
    const output = await this.embedder(text, {
      pooling: 'mean',
      normalize: true
    });
    
    return new Float32Array(output.data);
  }

  private async saveEmbedding(result: EmbeddingResult): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO content_embeddings (
        content_id, embedding, chunk_index, chunk_text, model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const embeddingBuffer = Buffer.from(result.embedding.buffer);
    
    stmt.run(
      result.contentId,
      embeddingBuffer,
      result.chunkIndex,
      result.chunkText,
      this.modelName,
      Date.now()
    );
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private generateSnippet(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  close() {
    this.db.close();
  }
}