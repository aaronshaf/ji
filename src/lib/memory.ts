import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { OllamaClient } from './ollama.js';

export interface MemoryEntry {
  id: string;
  questionHash: string;
  keyFacts: string;
  relevantDocIds: string[];
  confidence: number;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
}

export class MemoryManager {
  private db: Database;
  private ollama: OllamaClient;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
    this.ollama = new OllamaClient();
  }

  // Create a simple hash for similar questions
  private hashQuestion(question: string): string {
    const normalized = question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Extract key concepts for matching similar questions
    const words = normalized.split(' ');
    const keyWords = words.filter(w => w.length > 2).sort();
    return keyWords.slice(0, 5).join('_'); // Use top 5 words as hash
  }

  // Extract key facts from a successful ask session
  async extractMemory(question: string, answer: string, sourceDocIds: string[]): Promise<void> {
    try {
      const extractPrompt = `Extract 1-2 key facts from this Q&A session for future reference. Keep each fact under 100 characters.

Question: ${question}
Answer: ${answer}

Extract the most important facts as brief statements. Examples:
- "EVAL: Canvas evaluation team, works on assessments"
- "Decoder Ring: team ownership doc, updated 2025"

Return only the facts, one per line:`;

      const response = await this.ollama.generate(extractPrompt);
      if (!response?.trim()) return;

      const facts = response
        .trim()
        .split('\n')
        .filter(f => f.trim().length > 0)
        .slice(0, 2) // Max 2 facts
        .map(f => f.replace(/^[-•]\s*/, '').trim())
        .filter(f => f.length > 10 && f.length <= 150); // Quality filter

      if (facts.length === 0) return;

      const questionHash = this.hashQuestion(question);
      const keyFacts = facts.join(' | ');
      const docIds = sourceDocIds.slice(0, 3).join(','); // Max 3 doc IDs

      // Store or update memory using separate connection
      const asyncDb = new Database(join(homedir(), '.ji', 'data.db'));
      try {
        const stmt = asyncDb.prepare(`
          INSERT OR REPLACE INTO ask_memory 
          (id, question_hash, key_facts, relevant_doc_ids, confidence, created_at, last_accessed, access_count)
          VALUES (?, ?, ?, ?, 0.8, ?, ?, 1)
        `);
        
        const now = Date.now();
        const id = `mem_${questionHash}_${now}`;
        stmt.run(id, questionHash, keyFacts, docIds, now, now);
      } finally {
        asyncDb.close();
      }
      
    } catch (error) {
      // Silent fail - memory extraction is optional
    }
  }

  // Retrieve relevant memories for a question
  getRelevantMemories(question: string, limit: number = 3): MemoryEntry[] {
    const questionHash = this.hashQuestion(question);
    
    // Find memories with similar question hashes or containing key terms
    const words = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const searchTerms = words.slice(0, 3); // Top 3 words
    
    let sql = `
      SELECT * FROM ask_memory 
      WHERE question_hash = ? 
      OR key_facts LIKE '%' || ? || '%'
    `;
    
    const params: (string | number)[] = [questionHash, words[0] || ''];
    
    // Add more search terms if available
    if (searchTerms.length > 1) {
      sql += ` OR key_facts LIKE '%' || ? || '%'`;
      params.push(searchTerms[1]);
    }
    
    sql += ` ORDER BY 
      CASE WHEN question_hash = ? THEN 1 ELSE 2 END,
      confidence DESC, 
      last_accessed DESC 
      LIMIT ?`;
    
    params.push(questionHash, limit);
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    
    // Update access tracking
    const updateStmt = this.db.prepare(`
      UPDATE ask_memory 
      SET last_accessed = ?, access_count = access_count + 1 
      WHERE id = ?
    `);
    
    return rows.map(row => {
      updateStmt.run(Date.now(), row.id);
      return {
        id: row.id,
        questionHash: row.question_hash,
        keyFacts: row.key_facts,
        relevantDocIds: row.relevant_doc_ids ? row.relevant_doc_ids.split(',') : [],
        confidence: row.confidence,
        createdAt: row.created_at,
        lastAccessed: row.last_accessed,
        accessCount: row.access_count
      };
    });
  }

  // Clean up old/unused memories
  cleanupMemories(): void {
    const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    // Remove memories older than 1 month with low access count
    const stmt = this.db.prepare(`
      DELETE FROM ask_memory 
      WHERE last_accessed < ? AND access_count < 3
    `);
    
    stmt.run(oneMonthAgo);
  }

  // Get memory statistics
  getMemoryStats(): { total: number; recent: number } {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM ask_memory');
    const recentStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM ask_memory 
      WHERE last_accessed > ?
    `);
    
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    const total = (totalStmt.get() as any).count;
    const recent = (recentStmt.get(weekAgo) as any).count;
    
    return { total, recent };
  }

  close(): void {
    this.db.close();
  }
}