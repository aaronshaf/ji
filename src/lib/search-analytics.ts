import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Effect, pipe } from 'effect';

export interface SearchInteraction {
  query: string;
  resultId: string;
  resultTitle: string;
  resultScore: number;
  interactionType: 'view' | 'click' | 'helpful' | 'not_helpful';
  timestamp: number;
}

// Error types for search analytics operations
export class AnalyticsError extends Error {
  readonly _tag = 'AnalyticsError';
}

export class DatabaseError extends Error {
  readonly _tag = 'DatabaseError';
}

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

export class SearchAnalytics {
  private db: Database;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
    this.initDB();
  }

  private initDB(): void {
    // Create search analytics table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS search_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        result_id TEXT NOT NULL,
        result_title TEXT NOT NULL,
        result_score REAL NOT NULL,
        interaction_type TEXT NOT NULL CHECK(interaction_type IN ('view', 'click', 'helpful', 'not_helpful')),
        timestamp INTEGER NOT NULL
      )
    `);

    // Create indexes for efficient queries
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_search_query ON search_analytics(query)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_search_result ON search_analytics(result_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_search_timestamp ON search_analytics(timestamp DESC)`);
  }

  // Effect-based record interaction
  recordInteractionEffect(interaction: SearchInteraction): Effect.Effect<void, DatabaseError | ValidationError> {
    return pipe(
      // Validate interaction
      Effect.sync(() => {
        if (!interaction.query || interaction.query.trim().length === 0) {
          throw new ValidationError('Query cannot be empty');
        }
        if (!interaction.resultId || interaction.resultId.trim().length === 0) {
          throw new ValidationError('Result ID cannot be empty');
        }
        if (interaction.resultScore < 0 || interaction.resultScore > 1) {
          throw new ValidationError('Result score must be between 0 and 1');
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          const stmt = this.db.prepare(`
            INSERT INTO search_analytics 
            (query, result_id, result_title, result_score, interaction_type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
          `);

          stmt.run(
            interaction.query,
            interaction.resultId,
            interaction.resultTitle,
            interaction.resultScore,
            interaction.interactionType,
            interaction.timestamp,
          );
        }).pipe(Effect.mapError((error) => new DatabaseError(`Failed to record interaction: ${error}`))),
      ),
    );
  }

  // Record a search interaction (backward compatible)
  recordInteraction(interaction: SearchInteraction): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO search_analytics 
        (query, result_id, result_title, result_score, interaction_type, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        interaction.query,
        interaction.resultId,
        interaction.resultTitle,
        interaction.resultScore,
        interaction.interactionType,
        interaction.timestamp,
      );
    } catch (_error) {
      // Silent fail - analytics shouldn't break search
    }
  }

  // Effect-based click-through rate calculation
  getClickThroughRateEffect(resultId: string, query: string): Effect.Effect<number, DatabaseError | ValidationError> {
    return pipe(
      // Validate inputs
      Effect.sync(() => {
        if (!resultId || resultId.trim().length === 0) {
          throw new ValidationError('Result ID cannot be empty');
        }
        if (!query || query.trim().length === 0) {
          throw new ValidationError('Query cannot be empty');
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          const stmt = this.db.prepare(`
            SELECT 
              COUNT(*) as total_views,
              SUM(CASE WHEN interaction_type = 'click' THEN 1 ELSE 0 END) as clicks
            FROM search_analytics 
            WHERE result_id = ? AND query = ? AND interaction_type IN ('view', 'click')
          `);

          const result = stmt.get(resultId, query) as { total_views: number; clicks: number } | undefined;

          if (!result || result.total_views === 0) return 0;
          return result.clicks / result.total_views;
        }).pipe(Effect.mapError((error) => new DatabaseError(`Failed to calculate click-through rate: ${error}`))),
      ),
    );
  }

  // Get click-through rate for a specific result given a query (backward compatible)
  getClickThroughRate(resultId: string, query: string): number {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          COUNT(*) as total_views,
          SUM(CASE WHEN interaction_type = 'click' THEN 1 ELSE 0 END) as clicks
        FROM search_analytics 
        WHERE result_id = ? AND query = ? AND interaction_type IN ('view', 'click')
      `);

      const result = stmt.get(resultId, query) as { total_views: number; clicks: number } | undefined;

      if (!result || result.total_views === 0) return 0;
      return result.clicks / result.total_views;
    } catch {
      return 0;
    }
  }

  // Effect-based popularity score calculation
  getPopularityScoreEffect(resultId: string): Effect.Effect<number, DatabaseError | ValidationError> {
    return pipe(
      // Validate input
      Effect.sync(() => {
        if (!resultId || resultId.trim().length === 0) {
          throw new ValidationError('Result ID cannot be empty');
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          const stmt = this.db.prepare(`
            SELECT 
              COUNT(*) as total_interactions,
              SUM(CASE WHEN interaction_type = 'helpful' THEN 1 ELSE 0 END) as helpful_votes,
              SUM(CASE WHEN interaction_type = 'not_helpful' THEN 1 ELSE 0 END) as unhelpful_votes
            FROM search_analytics 
            WHERE result_id = ? AND timestamp > ?
          `);

          const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
          const result = stmt.get(resultId, thirtyDaysAgo) as
            | {
                total_interactions: number;
                helpful_votes: number;
                unhelpful_votes: number;
              }
            | undefined;

          if (!result || result.total_interactions === 0) return 1.0;

          // Calculate a score based on helpful vs unhelpful votes
          const helpfulness = (result.helpful_votes - result.unhelpful_votes) / result.total_interactions;
          const popularity = Math.log(result.total_interactions + 1) / 10; // Log scale for popularity

          return Math.max(0.5, Math.min(2.0, 1.0 + helpfulness + popularity));
        }).pipe(Effect.mapError((error) => new DatabaseError(`Failed to calculate popularity score: ${error}`))),
      ),
    );
  }

  // Get overall popularity score for a result (backward compatible)
  getPopularityScore(resultId: string): number {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          COUNT(*) as total_interactions,
          SUM(CASE WHEN interaction_type = 'helpful' THEN 1 ELSE 0 END) as helpful_votes,
          SUM(CASE WHEN interaction_type = 'not_helpful' THEN 1 ELSE 0 END) as unhelpful_votes
        FROM search_analytics 
        WHERE result_id = ? AND timestamp > ?
      `);

      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const result = stmt.get(resultId, thirtyDaysAgo) as
        | {
            total_interactions: number;
            helpful_votes: number;
            unhelpful_votes: number;
          }
        | undefined;

      if (!result || result.total_interactions === 0) return 1.0;

      // Calculate a score based on helpful vs unhelpful votes
      const helpfulness = (result.helpful_votes - result.unhelpful_votes) / result.total_interactions;
      const popularity = Math.log(result.total_interactions + 1) / 10; // Log scale for popularity

      return Math.max(0.5, Math.min(2.0, 1.0 + helpfulness + popularity));
    } catch {
      return 1.0;
    }
  }

  // Get similar queries that led to successful interactions
  getSimilarSuccessfulQueries(query: string, limit: number = 5): string[] {
    try {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      if (words.length === 0) return [];

      const wordConditions = words.map(() => 'LOWER(query) LIKE ?').join(' AND ');
      const params: (string | number)[] = words.map((w) => `%${w}%`);
      params.push(query); // Add original query
      params.push(limit); // Add limit as number

      const stmt = this.db.prepare(`
        SELECT DISTINCT query, COUNT(*) as success_count
        FROM search_analytics 
        WHERE ${wordConditions}
        AND interaction_type IN ('click', 'helpful')
        AND query != ?
        GROUP BY query
        HAVING success_count >= 2
        ORDER BY success_count DESC
        LIMIT ?
      `);

      const results = stmt.all(...params) as { query: string; success_count: number }[];

      return results.map((r) => r.query);
    } catch {
      return [];
    }
  }

  // Clean up old analytics data
  cleanup(): void {
    try {
      const sixMonthsAgo = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
      const stmt = this.db.prepare('DELETE FROM search_analytics WHERE timestamp < ?');
      stmt.run(sixMonthsAgo);
    } catch {
      // Silent fail
    }
  }

  close(): void {
    this.db.close();
  }
}
