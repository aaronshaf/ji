import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { OllamaClient } from './ollama.js';
import { Effect, pipe } from 'effect';

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

// Error types for memory operations
export class MemoryError extends Error {
  readonly _tag = 'MemoryError';
}

export class MemoryNotFoundError extends Error {
  readonly _tag = 'MemoryNotFoundError';
}

export class DatabaseError extends Error {
  readonly _tag = 'DatabaseError';
}

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
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
      // Check if Ollama is available
      if (!await this.ollama.isAvailable()) {
        // Skip memory extraction if Ollama is not available
        return;
      }
      
      // Only extract memory for certain types of questions to reduce false memories
      if (!this.shouldExtractMemory(question, answer)) {
        return;
      }

      const extractPrompt = `Extract 1-2 key FACTUAL statements from this Q&A session for future reference. Only extract facts that are:
- Clearly stated and unambiguous
- About team ownership, system architecture, or process definitions
- Not opinions, estimates, or speculative answers

Question: ${question}
Answer: ${answer}

IMPORTANT: Only extract facts if the answer is confident and factual. If the answer contains uncertainty (like "might be", "probably", "I think"), do not extract any facts.

Examples of good facts:
- "EVAL: Canvas evaluation team, works on assessments"
- "Decoder Ring: team ownership doc, updated 2025"
- "Rate limiting: 1000 requests per minute for API v1"

Return only definitive facts, one per line (or nothing if uncertain):`;

      const response = await this.ollama.generate(extractPrompt);
      if (!response?.trim()) return;

      const facts = response
        .trim()
        .split('\n')
        .filter(f => f.trim().length > 0)
        .slice(0, 2) // Max 2 facts
        .map(f => f.replace(/^[-•]\s*/, '').trim())
        .filter(f => f.length > 10 && f.length <= 150) // Quality filter
        .filter(f => !this.containsUncertainty(f)); // Filter out uncertain statements

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

  // List all memories for review/correction
  listAllMemories(limit: number = 50): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ask_memory 
      ORDER BY last_accessed DESC, created_at DESC 
      LIMIT ?
    `);
    
    const rows = stmt.all(limit) as any[];
    return rows.map(row => ({
      id: row.id,
      questionHash: row.question_hash,
      keyFacts: row.key_facts,
      relevantDocIds: row.relevant_doc_ids ? row.relevant_doc_ids.split(',') : [],
      confidence: row.confidence,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count
    }));
  }

  // Effect-based delete memory
  deleteMemoryEffect(memoryId: string): Effect.Effect<boolean, MemoryNotFoundError | DatabaseError | ValidationError> {
    return pipe(
      // Validate input
      Effect.sync(() => {
        if (!memoryId || memoryId.trim().length === 0) {
          throw new ValidationError('Memory ID cannot be empty');
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          // Check if the memory exists
          const checkStmt = this.db.prepare('SELECT id FROM ask_memory WHERE id = ?');
          const exists = checkStmt.get(memoryId);
          
          if (!exists) {
            throw new MemoryNotFoundError(`Memory with ID ${memoryId} not found`);
          }
          
          // Delete the memory
          const stmt = this.db.prepare('DELETE FROM ask_memory WHERE id = ?');
          stmt.run(memoryId);
          
          // Verify deletion
          const verifyStmt = this.db.prepare('SELECT id FROM ask_memory WHERE id = ?');
          const stillExists = verifyStmt.get(memoryId);
          
          if (stillExists) {
            throw new DatabaseError('Failed to delete memory - verification failed');
          }
          
          return true;
        }).pipe(
          Effect.mapError(error => {
            if (error instanceof MemoryNotFoundError) return error;
            if (error instanceof DatabaseError) return error;
            return new DatabaseError(`Database error while deleting memory: ${error}`);
          })
        )
      )
    );
  }

  // Delete a specific memory by ID (backward compatible)
  deleteMemory(memoryId: string): boolean {
    try {
      // First check if the memory exists
      const checkStmt = this.db.prepare('SELECT id FROM ask_memory WHERE id = ?');
      const exists = checkStmt.get(memoryId);
      
      if (!exists) {
        return false;
      }
      
      const stmt = this.db.prepare('DELETE FROM ask_memory WHERE id = ?');
      stmt.run(memoryId);
      
      // Verify deletion by checking if the memory still exists
      const verifyStmt = this.db.prepare('SELECT id FROM ask_memory WHERE id = ?');
      const stillExists = verifyStmt.get(memoryId);
      
      return !stillExists;
    } catch (error) {
      return false;
    }
  }

  // Effect-based update memory facts
  updateMemoryFactsEffect(memoryId: string, newFacts: string): Effect.Effect<boolean, MemoryNotFoundError | DatabaseError | ValidationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!memoryId || memoryId.trim().length === 0) {
          throw new ValidationError('Memory ID cannot be empty');
        }
        if (!newFacts || newFacts.trim().length === 0) {
          throw new ValidationError('New facts cannot be empty');
        }
        if (newFacts.length > 1000) {
          throw new ValidationError('Facts too long (max 1000 characters)');
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          // Check if memory exists
          const checkStmt = this.db.prepare('SELECT id FROM ask_memory WHERE id = ?');
          const exists = checkStmt.get(memoryId);
          
          if (!exists) {
            throw new MemoryNotFoundError(`Memory with ID ${memoryId} not found`);
          }
          
          // Update the memory
          const stmt = this.db.prepare(`
            UPDATE ask_memory 
            SET key_facts = ?, last_accessed = ? 
            WHERE id = ?
          `);
          const result = stmt.run(newFacts, Date.now(), memoryId);
          
          if (result.changes === 0) {
            throw new DatabaseError('Failed to update memory - no changes made');
          }
          
          return true;
        }).pipe(
          Effect.mapError(error => {
            if (error instanceof MemoryNotFoundError) return error;
            if (error instanceof DatabaseError) return error;
            return new DatabaseError(`Database error while updating memory: ${error}`);
          })
        )
      )
    );
  }

  // Update/correct a memory's facts (backward compatible)
  updateMemoryFacts(memoryId: string, newFacts: string): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE ask_memory 
        SET key_facts = ?, last_accessed = ? 
        WHERE id = ?
      `);
      const result = stmt.run(newFacts, Date.now(), memoryId);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  // Search memories by content for review
  searchMemories(searchTerm: string): MemoryEntry[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM ask_memory 
        WHERE key_facts LIKE ? 
        ORDER BY last_accessed DESC, access_count DESC
        LIMIT 20
      `);
      
      const rows = stmt.all(`%${searchTerm}%`) as any[];
      return rows.map(row => ({
        id: row.id,
        questionHash: row.question_hash,
        keyFacts: row.key_facts,
        relevantDocIds: row.relevant_doc_ids ? row.relevant_doc_ids.split(',') : [],
        confidence: row.confidence,
        createdAt: row.created_at,
        lastAccessed: row.last_accessed,
        accessCount: row.access_count
      }));
    } catch {
      return [];
    }
  }

  // Mark memory as incorrect/low confidence
  markMemoryAsIncorrect(memoryId: string): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE ask_memory 
        SET confidence = 0.2, last_accessed = ? 
        WHERE id = ?
      `);
      const result = stmt.run(Date.now(), memoryId);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  // Manually add a memory fact (user-provided)
  addManualMemory(fact: string, relatedTerms: string[] = []): boolean {
    try {
      // Create a hash based on the fact content for deduplication
      const factHash = this.hashQuestion(fact);
      const now = Date.now();
      const id = `manual_${factHash}_${now}`;
      
      // Check if similar fact already exists (exact hash match only for manual memories)
      const existingStmt = this.db.prepare(`
        SELECT id FROM ask_memory 
        WHERE question_hash = ? AND id LIKE 'manual_%'
      `);
      const existing = existingStmt.get(factHash);
      
      if (existing) {
        // Update existing fact instead of creating duplicate
        return this.updateMemoryFacts((existing as any).id, fact);
      }
      
      const stmt = this.db.prepare(`
        INSERT INTO ask_memory 
        (id, question_hash, key_facts, relevant_doc_ids, confidence, created_at, last_accessed, access_count)
        VALUES (?, ?, ?, ?, 1.0, ?, ?, 1)
      `);
      
      const relatedTermsStr = relatedTerms.join(',');
      stmt.run(id, factHash, fact, relatedTermsStr, now, now);
      
      // Verify insertion
      const verifyStmt = this.db.prepare('SELECT id FROM ask_memory WHERE id = ?');
      const inserted = verifyStmt.get(id);
      
      return !!inserted;
    } catch (error) {
      return false;
    }
  }

  // Helper function to check if memory should be extracted
  private shouldExtractMemory(question: string, answer: string): boolean {
    const lowerQuestion = question.toLowerCase();
    const lowerAnswer = answer.toLowerCase();
    
    // Extract memory for specific types of questions
    const extractionPatterns = [
      /who is|what is.*team|team.*owns|owned by/i,
      /how.*works|what.*does|process.*for/i,
      /rate limit|configuration|setting/i,
      /api.*endpoint|service.*location/i
    ];
    
    const shouldExtract = extractionPatterns.some(pattern => pattern.test(lowerQuestion));
    
    // Don't extract if answer is uncertain
    const uncertaintyMarkers = [
      'not sure', 'might be', 'probably', 'i think', 'maybe', 
      'unclear', 'uncertain', 'not certain', 'depends on'
    ];
    
    const isUncertain = uncertaintyMarkers.some(marker => lowerAnswer.includes(marker));
    
    return shouldExtract && !isUncertain;
  }

  // Helper function to detect uncertainty in extracted facts
  private containsUncertainty(fact: string): boolean {
    const uncertaintyPatterns = [
      /might|maybe|probably|possibly|perhaps/i,
      /not sure|unclear|uncertain/i,
      /i think|seems like|appears to/i,
      /\?|\.\.\./
    ];
    
    return uncertaintyPatterns.some(pattern => pattern.test(fact));
  }

  // Clear all manual memories (user-added ones)
  clearManualMemories(): number {
    try {
      // Count before deletion
      const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM ask_memory WHERE id LIKE 'manual_%'");
      const beforeCount = (countStmt.get() as {count: number}).count;
      
      const stmt = this.db.prepare("DELETE FROM ask_memory WHERE id LIKE 'manual_%'");
      stmt.run();
      
      return beforeCount;
    } catch (error) {
      return -1; // Error indicator
    }
  }

  // Clear ALL memories (including auto-extracted ones) - dangerous operation
  clearAllMemories(): number {
    try {
      const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM ask_memory");
      const beforeCount = (countStmt.get() as {count: number}).count;
      
      const stmt = this.db.prepare("DELETE FROM ask_memory");
      stmt.run();
      
      return beforeCount;
    } catch (error) {
      return -1; // Error indicator
    }
  }

  close(): void {
    this.db.close();
  }
}