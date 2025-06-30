import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { DocumentChunker } from './chunker.js';
import type { SearchableContent } from './content-manager.js';

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
    // For now, fall back to FTS search
    // In the future, we can implement a Bun-compatible embedding solution
    return this.searchFTS(query, options);
  }

  async hybridSearch(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
  }): Promise<SearchResult[]> {
    // For now, just use FTS search
    // When we have a Bun-compatible embedding solution, we can implement true hybrid search
    return this.searchFTS(query, options);
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