import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { DocumentChunker } from './chunker.js';
import type { SearchableContent } from './content-manager.js';
import { OllamaClient } from './ollama.js';

// For now, we'll use a simpler approach until we find a Bun-compatible embedding solution
// This uses TF-IDF style keyword extraction instead of neural embeddings

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
  private db: Database;
  private chunker: DocumentChunker;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
    this.chunker = new DocumentChunker();
  }

  async initialize(): Promise<void> {
    // No-op for now - would initialize embedding model here
  }

  async embedContent(content: SearchableContent): Promise<void> {
    // For now, we'll skip embedding generation
    // The FTS5 search will still work well for keyword search
  }

  async searchSemantic(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    const ollama = new OllamaClient();
    
    // Check if Ollama is available
    if (!await ollama.isAvailable()) {
      console.log('⚠️  Semantic search unavailable (Ollama not running). Using keyword search...');
      return this.searchFTS(query, options);
    }
    
    // Generate embedding for query
    const queryEmbedding = await ollama.generateEmbedding(query);
    if (!queryEmbedding) {
      return this.searchFTS(query, options);
    }
    
    // Search using cosine similarity
    let sql = `
      SELECT 
        sc.*,
        ce.embedding,
        ce.embedding_hash
      FROM searchable_content sc
      JOIN content_embeddings ce ON sc.id = ce.content_id
      WHERE ce.embedding IS NOT NULL
    `;
    
    const params: any[] = [];
    
    if (options?.source) {
      sql += ' AND sc.source = ?';
      params.push(options.source);
    }
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    
    // Calculate similarities and sort
    const results = rows.map(row => {
      const embedding = OllamaClient.bufferToEmbedding(row.embedding);
      const similarity = OllamaClient.cosineSimilarity(queryEmbedding, embedding);
      
      return {
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
        score: similarity,
        snippet: this.generateSnippet(row.content, 200)
      };
    });
    
    // Sort by similarity score and limit
    results.sort((a, b) => b.score - a.score);
    
    // Filter out low scores and apply limit
    const threshold = 0.5; // Minimum similarity score
    return results
      .filter(r => r.score >= threshold)
      .slice(0, options?.limit || 10);
  }

  async hybridSearch(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    const limit = options?.limit || 10;
    
    // Get both semantic and FTS results
    const [semanticResults, ftsResults] = await Promise.all([
      this.searchSemantic(query, { ...options, limit: limit * 2 }),
      this.searchFTS(query, { ...options, limit: limit * 2 })
    ]);
    
    // Merge and deduplicate results
    const resultMap = new Map<string, SearchResult>();
    
    // Add semantic results with boosted scores
    semanticResults.forEach(result => {
      resultMap.set(result.content.id, {
        ...result,
        score: result.score * 1.5 // Boost semantic matches
      });
    });
    
    // Add FTS results (lower priority)
    ftsResults.forEach(result => {
      if (!resultMap.has(result.content.id)) {
        resultMap.set(result.content.id, result);
      }
    });
    
    // Sort by score and return top results
    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async searchFTS(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    let sql = `
      SELECT 
        sc.*,
        snippet(content_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM searchable_content sc
      JOIN content_fts ON content_fts.id = sc.id
      WHERE content_fts MATCH ?
    `;

    const params: any[] = [query];

    if (options?.source) {
      sql += ' AND sc.source = ?';
      params.push(options.source);
    }

    sql += ' LIMIT ?';
    params.push(options?.limit || 10);

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
      score: 1.0, // Fixed score for now
      snippet: row.snippet
    }));
  }


  private generateSnippet(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  close() {
    this.db.close();
  }
}