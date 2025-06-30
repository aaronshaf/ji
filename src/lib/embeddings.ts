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
    includeAll?: boolean;
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
    
    // By default, exclude closed/done issues unless includeAll is true
    if (!options?.includeAll) {
      sql += ` AND (
        sc.source != 'jira' 
        OR sc.metadata NOT LIKE '%"status":"Closed"%'
        AND sc.metadata NOT LIKE '%"status":"Done"%'
        AND sc.metadata NOT LIKE '%"status":"Resolved"%'
        AND sc.metadata NOT LIKE '%"status":"Cancelled"%'
        AND sc.metadata NOT LIKE '%"status":"Rejected"%'
        AND sc.metadata NOT LIKE '%"status":"Won''t Do"%'
      )`;
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
    const threshold = 0.3; // Lowered threshold - all-minilm might have lower similarities
    return results
      .filter(r => r.score >= threshold)
      .slice(0, options?.limit || 10);
  }

  async hybridSearch(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
    includeAll?: boolean;
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
    const allResults = Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score);
    
    // If no source filter, ensure we get a mix of both sources
    if (!options?.source && allResults.length > 0) {
      const confluenceResults = allResults.filter(r => r.content.source === 'confluence');
      const jiraResults = allResults.filter(r => r.content.source === 'jira');
      
      // If we have both types, try to include at least some from each
      if (confluenceResults.length > 0 && jiraResults.length > 0) {
        const balancedResults: SearchResult[] = [];
        let confIndex = 0, jiraIndex = 0;
        
        // Alternate between sources, but still respect score order within each source
        while (balancedResults.length < limit && (confIndex < confluenceResults.length || jiraIndex < jiraResults.length)) {
          // Add confluence result if available and we haven't exceeded half the limit
          if (confIndex < confluenceResults.length && balancedResults.filter(r => r.content.source === 'confluence').length < Math.ceil(limit / 2)) {
            balancedResults.push(confluenceResults[confIndex++]);
          }
          
          // Add jira result if available and we haven't filled up
          if (jiraIndex < jiraResults.length && balancedResults.length < limit) {
            balancedResults.push(jiraResults[jiraIndex++]);
          }
          
          // If we've reached our confluence limit but still have space, fill with jira
          if (balancedResults.filter(r => r.content.source === 'confluence').length >= Math.ceil(limit / 2)) {
            while (balancedResults.length < limit && jiraIndex < jiraResults.length) {
              balancedResults.push(jiraResults[jiraIndex++]);
            }
          }
        }
        
        return balancedResults;
      }
    }
    
    return allResults.slice(0, limit);
  }

  private async searchFTS(query: string, options?: {
    source?: 'jira' | 'confluence';
    limit?: number;
    includeAll?: boolean;
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

    // Escape special characters for FTS5
    // FTS5 has issues with quotes, parentheses, and other special chars
    const ftsQuery = query
      .replace(/[-"'()]/g, ' ')  // Remove problematic chars
      .replace(/\s+/g, ' ')      // Normalize whitespace
      .trim();
    
    if (!ftsQuery) {
      // If query becomes empty after sanitization, return empty results
      return [];
    }
    
    const params: any[] = [ftsQuery];

    if (options?.source) {
      sql += ' AND sc.source = ?';
      params.push(options.source);
    }
    
    // By default, exclude closed/done issues unless includeAll is true
    if (!options?.includeAll) {
      sql += ` AND (
        sc.source != 'jira' 
        OR sc.metadata NOT LIKE '%"status":"Closed"%'
        AND sc.metadata NOT LIKE '%"status":"Done"%'
        AND sc.metadata NOT LIKE '%"status":"Resolved"%'
        AND sc.metadata NOT LIKE '%"status":"Cancelled"%'
        AND sc.metadata NOT LIKE '%"status":"Rejected"%'
        AND sc.metadata NOT LIKE '%"status":"Won''t Do"%'
      )`;
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(options?.limit || 10);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    const queryLower = query.toLowerCase();
    
    return rows.map(row => {
      // Calculate score based on BM25 rank and title matches
      let score = Math.abs(row.rank); // BM25 returns negative values, lower is better
      
      // Boost if query matches title
      const titleLower = row.title.toLowerCase();
      if (titleLower.includes(queryLower)) {
        score *= 0.5; // Lower score is better for BM25
      }
      
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
        score: 1.0 / (1 + score), // Convert to 0-1 range where higher is better
        snippet: row.snippet
      };
    });
  }


  private generateSnippet(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  close() {
    this.db.close();
  }
}