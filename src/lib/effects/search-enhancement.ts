import type { Database } from 'bun:sqlite';
import { Context, Duration, Effect, Layer, Option, pipe, Stream } from 'effect';
import type { SearchResult } from '../content-manager.js';
import type { CacheService } from './caching-layer.js';
import { DatabaseError, NetworkError, ValidationError } from './errors.js';

/**
 * Enhanced search query with metadata
 */
export interface SearchQuery {
  query: string;
  source?: 'jira' | 'confluence';
  filters?: SearchFilter[];
  sort?: SearchSort;
  facets?: string[];
  limit?: number;
  offset?: number;
  userId?: string;
  sessionId?: string;
}

export interface SearchFilter {
  field: string;
  operator: 'eq' | 'ne' | 'in' | 'range' | 'contains' | 'starts_with';
  value: string | string[] | { min?: number; max?: number };
}

export interface SearchSort {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Search result with enhanced metadata
 */
export interface EnhancedSearchResult extends SearchResult {
  rank: number;
  explanation?: SearchExplanation;
  highlights: SearchHighlight[];
  relatedResults?: SearchResult[];
  searchTime: number;
  cacheHit: boolean;
}

export interface SearchExplanation {
  totalScore: number;
  factors: Array<{
    factor: string;
    score: number;
    description: string;
  }>;
}

export interface SearchHighlight {
  field: string;
  fragments: string[];
}

/**
 * Search analytics for improving relevance
 */
export interface SearchAnalytics {
  recordQuery: (query: SearchQuery, results: EnhancedSearchResult[]) => Effect.Effect<void, DatabaseError>;
  recordClick: (queryId: string, resultId: string, position: number) => Effect.Effect<void, DatabaseError>;
  getPopularQueries: (limit?: number) => Effect.Effect<Array<{ query: string; count: number }>, DatabaseError>;
  getClickThroughRate: (query: string) => Effect.Effect<number, DatabaseError>;
  getSuggestions: (partial: string) => Effect.Effect<string[], DatabaseError>;
}

/**
 * Streaming search service with real-time results
 */
export interface StreamingSearchService {
  search: (query: SearchQuery) => Stream.Stream<EnhancedSearchResult, NetworkError | DatabaseError>;
  searchWithFacets: (query: SearchQuery) => Effect.Effect<
    {
      results: EnhancedSearchResult[];
      facets: Record<string, Array<{ value: string; count: number }>>;
      total: number;
    },
    NetworkError | DatabaseError
  >;
  autoComplete: (partial: string) => Stream.Stream<string, DatabaseError>;
  similarDocuments: (contentId: string) => Effect.Effect<SearchResult[], NetworkError | DatabaseError>;
  bulkSearch: (queries: SearchQuery[]) => Effect.Effect<EnhancedSearchResult[][], NetworkError | DatabaseError>;
}

/**
 * Enhanced search implementation with streaming capabilities
 */
export class EnhancedSearchEngine implements StreamingSearchService {
  constructor(
    private cache: CacheService,
    private analytics: SearchAnalytics,
  ) {}

  /**
   * Streaming search with real-time results
   */
  search(query: SearchQuery): Stream.Stream<EnhancedSearchResult, NetworkError | DatabaseError> {
    return pipe(
      Stream.fromEffect(this.validateQuery(query)),
      Stream.mapError((error) => new DatabaseError(`Validation failed: ${error.message}`, error)),
      Stream.flatMap(() => this.createSearchStream(query)),
      Stream.tap((result) => this.recordInteraction(query, result)),
    );
  }

  /**
   * Search with faceted navigation
   */
  searchWithFacets(query: SearchQuery): Effect.Effect<
    {
      results: EnhancedSearchResult[];
      facets: Record<string, Array<{ value: string; count: number }>>;
      total: number;
    },
    NetworkError | DatabaseError
  > {
    return pipe(
      this.validateQuery(query),
      Effect.mapError((error) => new DatabaseError(`Validation failed: ${error.message}`, error)),
      Effect.flatMap(() => this.getCachedResults(query)),
      Effect.flatMap((maybeResults) =>
        Option.isSome(maybeResults) ? Effect.succeed(maybeResults.value) : this.executeSearchWithFacets(query),
      ),
      Effect.tap((results) => this.cacheResults(query, results)),
    );
  }

  /**
   * Auto-complete suggestions stream
   */
  autoComplete(partial: string): Stream.Stream<string, DatabaseError> {
    return pipe(
      Stream.fromEffect(this.validatePartialQuery(partial)),
      Stream.mapError((error) => new DatabaseError(`Validation failed: ${error.message}`, error)),
      Stream.flatMap(() => Stream.fromEffect(this.analytics.getSuggestions(partial))),
      Stream.flatMap((suggestions) => Stream.fromIterable(suggestions)),
      Stream.take(10), // Limit suggestions
    );
  }

  /**
   * Find similar documents using content similarity
   */
  similarDocuments(contentId: string): Effect.Effect<SearchResult[], NetworkError | DatabaseError> {
    return pipe(
      this.validateContentId(contentId),
      Effect.mapError((error) => new DatabaseError(`Validation failed: ${error.message}`, error)),
      Effect.flatMap(() =>
        this.cache.getOrCompute(`similar:${contentId}`, this.computeSimilarDocuments(contentId), Duration.hours(1), [
          'similarity',
          contentId,
        ]),
      ),
      Effect.mapError((error) =>
        error instanceof NetworkError || error instanceof DatabaseError
          ? error
          : new DatabaseError(`Cache operation failed: ${error}`, error),
      ),
    );
  }

  /**
   * Execute multiple searches in parallel with controlled concurrency
   */
  bulkSearch(queries: SearchQuery[]): Effect.Effect<EnhancedSearchResult[][], NetworkError | DatabaseError> {
    return pipe(
      Effect.all(
        queries.map((query) => this.executeSearchQuery(query)),
        { concurrency: 5 },
      ),
    );
  }

  /**
   * Private implementation methods
   */
  private createSearchStream(query: SearchQuery): Stream.Stream<EnhancedSearchResult, NetworkError | DatabaseError> {
    return pipe(
      // Start with cached results for immediate response
      Stream.fromEffect(this.getCachedQuickResults(query)),
      Stream.flatMap((cachedResults) => {
        if (cachedResults.length > 0) {
          return Stream.concat(Stream.fromIterable(cachedResults), this.createLiveSearchStream(query));
        } else {
          return this.createLiveSearchStream(query);
        }
      }),
    );
  }

  private createLiveSearchStream(
    query: SearchQuery,
  ): Stream.Stream<EnhancedSearchResult, NetworkError | DatabaseError> {
    return pipe(
      // Search multiple sources concurrently
      Stream.mergeAll(
        [
          this.searchJiraStream(query).pipe(Stream.mapError((error) => error as NetworkError | DatabaseError)),
          this.searchConfluenceStream(query).pipe(Stream.mapError((error) => error as NetworkError | DatabaseError)),
          this.searchMeilisearchStream(query).pipe(Stream.mapError((error) => error as NetworkError | DatabaseError)),
        ],
        { concurrency: 3 },
      ),
      Stream.map((result) => this.enhanceResult(result, query)),
      Stream.groupedWithin(10, Duration.millis(100)), // Batch results for better UX
      Stream.flatMap((chunk) => Stream.fromEffect(this.rankResults(Array.from(chunk)))),
      Stream.flatMap((rankedResults) => Stream.fromIterable(rankedResults)),
    );
  }

  private searchJiraStream(query: SearchQuery): Stream.Stream<SearchResult, DatabaseError> {
    return Stream.fromEffect(
      Effect.tryPromise({
        try: async () => {
          const { ContentManager } = await import('../content-manager.js');
          const contentManager = new ContentManager();

          try {
            const results = await contentManager.searchContent(query.query, {
              source: 'jira',
              limit: query.limit || 20,
            });

            return results.map((content) => ({
              content,
              score: 1.0,
              snippet: `${content.content.slice(0, 200)}...`,
            }));
          } finally {
            contentManager.close();
          }
        },
        catch: (error) => new DatabaseError(`Jira search failed: ${error}`, error),
      }),
    ).pipe(Stream.flatMap((results) => Stream.fromIterable(results)));
  }

  private searchConfluenceStream(query: SearchQuery): Stream.Stream<SearchResult, DatabaseError> {
    return Stream.fromEffect(
      Effect.tryPromise({
        try: async () => {
          const { ContentManager } = await import('../content-manager.js');
          const contentManager = new ContentManager();

          try {
            const results = await contentManager.searchContent(query.query, {
              source: 'confluence',
              limit: query.limit || 20,
            });

            return results.map((content) => ({
              content,
              score: 1.0,
              snippet: `${content.content.slice(0, 200)}...`,
            }));
          } finally {
            contentManager.close();
          }
        },
        catch: (error) => new DatabaseError(`Confluence search failed: ${error}`, error),
      }),
    ).pipe(Stream.flatMap((results) => Stream.fromIterable(results)));
  }

  private searchMeilisearchStream(_query: SearchQuery): Stream.Stream<SearchResult, NetworkError> {
    // Meilisearch support has been removed - using SQLite FTS5 only
    return Stream.empty;
  }

  private enhanceResult(result: SearchResult, query: SearchQuery): EnhancedSearchResult {
    const searchTime = Date.now(); // Would be calculated properly

    return {
      ...result,
      rank: 0, // Will be set during ranking
      highlights: this.generateHighlights(result, query),
      searchTime,
      cacheHit: false,
      explanation: this.generateExplanation(result, query),
    };
  }

  private generateHighlights(result: SearchResult, query: SearchQuery): SearchHighlight[] {
    const queryTerms = query.query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const highlights: SearchHighlight[] = [];

    // Highlight in title
    const titleHighlights = this.highlightText(result.content.title, queryTerms);
    if (titleHighlights.length > 0) {
      highlights.push({
        field: 'title',
        fragments: titleHighlights,
      });
    }

    // Highlight in content
    const contentHighlights = this.highlightText(result.content.content.slice(0, 1000), queryTerms);
    if (contentHighlights.length > 0) {
      highlights.push({
        field: 'content',
        fragments: contentHighlights.slice(0, 3), // Limit fragments
      });
    }

    return highlights;
  }

  private highlightText(text: string, terms: string[]): string[] {
    const fragments: string[] = [];
    const lowerText = text.toLowerCase();

    for (const term of terms) {
      const index = lowerText.indexOf(term);
      if (index >= 0) {
        const start = Math.max(0, index - 50);
        const end = Math.min(text.length, index + term.length + 50);
        const fragment = text.slice(start, end);
        const highlightedFragment = fragment.replace(new RegExp(term, 'gi'), `<mark>$&</mark>`);
        fragments.push(highlightedFragment);
      }
    }

    return fragments;
  }

  private generateExplanation(result: SearchResult, query: SearchQuery): SearchExplanation {
    const factors: Array<{ factor: string; score: number; description: string }> = [];

    // Text relevance
    const textScore = this.calculateTextRelevance(result, query);
    factors.push({
      factor: 'text_relevance',
      score: textScore,
      description: 'How well the content matches the search query',
    });

    // Freshness boost
    const freshnessScore = this.calculateFreshnessScore(result);
    factors.push({
      factor: 'freshness',
      score: freshnessScore,
      description: 'Boost for recently updated content',
    });

    // Source preference
    const sourceScore = query.source ? 1.0 : 0.8;
    factors.push({
      factor: 'source_preference',
      score: sourceScore,
      description: 'Preference for specific content sources',
    });

    const totalScore = factors.reduce((sum, factor) => sum + factor.score, 0) / factors.length;

    return {
      totalScore,
      factors,
    };
  }

  private calculateTextRelevance(result: SearchResult, query: SearchQuery): number {
    const queryTerms = query.query.toLowerCase().split(/\s+/);
    const contentText = `${result.content.title} ${result.content.content}`.toLowerCase();

    let matches = 0;
    for (const term of queryTerms) {
      if (contentText.includes(term)) {
        matches++;
      }
    }

    return queryTerms.length > 0 ? matches / queryTerms.length : 0;
  }

  private calculateFreshnessScore(result: SearchResult): number {
    if (!result.content.updatedAt) return 0.5;

    const daysSinceUpdate = (Date.now() - result.content.updatedAt) / (1000 * 60 * 60 * 24);

    if (daysSinceUpdate <= 7) return 1.0;
    if (daysSinceUpdate <= 30) return 0.8;
    if (daysSinceUpdate <= 90) return 0.6;
    return 0.4;
  }

  private rankResults(results: EnhancedSearchResult[]): Effect.Effect<EnhancedSearchResult[], never> {
    return Effect.sync(() => {
      const rankedResults = results
        .map((result, index) => ({
          ...result,
          rank: index + 1,
        }))
        .sort((a, b) => {
          // Primary sort by explanation score
          const scoreDiff = (b.explanation?.totalScore || 0) - (a.explanation?.totalScore || 0);
          if (scoreDiff !== 0) return scoreDiff;

          // Secondary sort by original score
          return b.score - a.score;
        })
        .map((result, index) => ({
          ...result,
          rank: index + 1,
        }));

      return rankedResults;
    });
  }

  private executeSearchWithFacets(query: SearchQuery): Effect.Effect<
    {
      results: EnhancedSearchResult[];
      facets: Record<string, Array<{ value: string; count: number }>>;
      total: number;
    },
    NetworkError | DatabaseError
  > {
    return pipe(
      this.executeSearchQuery(query),
      Effect.flatMap((results) =>
        pipe(
          this.calculateFacets(results, query.facets || []),
          Effect.map((facets) => ({
            results,
            facets,
            total: results.length,
          })),
        ),
      ),
    );
  }

  private executeSearchQuery(query: SearchQuery): Effect.Effect<EnhancedSearchResult[], NetworkError | DatabaseError> {
    return pipe(
      this.search(query),
      Stream.take(query.limit || 20),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );
  }

  private calculateFacets(
    results: EnhancedSearchResult[],
    facetFields: string[],
  ): Effect.Effect<Record<string, Array<{ value: string; count: number }>>, never> {
    return Effect.sync(() => {
      const facets: Record<string, Array<{ value: string; count: number }>> = {};

      for (const field of facetFields) {
        const valueCount = new Map<string, number>();

        for (const result of results) {
          const value = this.extractFacetValue(result, field);
          if (value) {
            valueCount.set(value, (valueCount.get(value) || 0) + 1);
          }
        }

        facets[field] = Array.from(valueCount.entries())
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10); // Limit facet values
      }

      return facets;
    });
  }

  private extractFacetValue(result: EnhancedSearchResult, field: string): string | null {
    switch (field) {
      case 'source':
        return result.content.source;
      case 'type':
        return result.content.type;
      case 'projectKey':
        return result.content.projectKey || null;
      case 'spaceKey':
        return result.content.spaceKey || null;
      case 'status':
        return result.content.metadata?.status || null;
      default:
        return null;
    }
  }

  private computeSimilarDocuments(_contentId: string): Effect.Effect<SearchResult[], NetworkError | DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        // This would use vector similarity or content-based similarity
        // For now, return empty array as placeholder
        return [];
      },
      catch: (error) => new DatabaseError(`Similar documents computation failed: ${error}`, error),
    });
  }

  private getCachedResults(query: SearchQuery): Effect.Effect<
    Option.Option<{
      results: EnhancedSearchResult[];
      facets: Record<string, Array<{ value: string; count: number }>>;
      total: number;
    }>,
    never
  > {
    const cacheKey = this.generateQueryCacheKey(query);
    return pipe(
      this.cache.get<{
        results: EnhancedSearchResult[];
        facets: Record<string, Array<{ value: string; count: number }>>;
        total: number;
      }>(cacheKey),
      Effect.catchAll(() => Effect.succeed(Option.none())),
    );
  }

  private getCachedQuickResults(query: SearchQuery): Effect.Effect<EnhancedSearchResult[], never> {
    const quickCacheKey = `quick:${this.generateQueryCacheKey(query)}`;
    return pipe(
      this.cache.get<EnhancedSearchResult[]>(quickCacheKey),
      Effect.map((maybeResults) => Option.getOrElse(maybeResults, () => [])),
      Effect.catchAll(() => Effect.succeed([])),
    );
  }

  private cacheResults(
    query: SearchQuery,
    results: {
      results: EnhancedSearchResult[];
      facets: Record<string, Array<{ value: string; count: number }>>;
      total: number;
    },
  ): Effect.Effect<void, never> {
    const cacheKey = this.generateQueryCacheKey(query);
    const quickCacheKey = `quick:${cacheKey}`;

    return pipe(
      Effect.all([
        this.cache.set(cacheKey, results, Duration.minutes(15), ['search']),
        this.cache.set(quickCacheKey, results.results.slice(0, 5), Duration.minutes(30), ['search', 'quick']),
      ]),
      Effect.map(() => undefined),
      Effect.catchAll(() => Effect.succeed(undefined)), // Don't fail on cache errors
    );
  }

  private generateQueryCacheKey(query: SearchQuery): string {
    const normalized = {
      query: query.query.toLowerCase().trim(),
      source: query.source || 'all',
      filters: query.filters || [],
      sort: query.sort || { field: 'relevance', direction: 'desc' },
    };

    return `search:${Buffer.from(JSON.stringify(normalized)).toString('base64')}`;
  }

  private recordInteraction(query: SearchQuery, result: EnhancedSearchResult): Effect.Effect<void, never> {
    return pipe(
      this.analytics.recordQuery(query, [result]),
      Effect.catchAll(() => Effect.succeed(undefined)), // Don't fail on analytics errors
    );
  }

  private validateQuery(query: SearchQuery): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!query.query || query.query.trim().length === 0) {
        throw new ValidationError('Search query cannot be empty', 'query', query.query);
      }
      if (query.query.length > 1000) {
        throw new ValidationError('Search query too long (max 1000 chars)', 'query', query.query);
      }
      if (query.limit && (query.limit <= 0 || query.limit > 1000)) {
        throw new ValidationError('Search limit must be between 1 and 1000', 'limit', query.limit);
      }
    });
  }

  private validatePartialQuery(partial: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!partial || partial.trim().length === 0) {
        throw new ValidationError('Partial query cannot be empty', 'partial', partial);
      }
      if (partial.length > 100) {
        throw new ValidationError('Partial query too long (max 100 chars)', 'partial', partial);
      }
    });
  }

  private validateContentId(contentId: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!contentId || contentId.trim().length === 0) {
        throw new ValidationError('Content ID cannot be empty', 'contentId', contentId);
      }
    });
  }
}

/**
 * Search analytics implementation
 */
export class SearchAnalyticsService implements SearchAnalytics {
  constructor(private db: Database) {}

  recordQuery(query: SearchQuery, results: EnhancedSearchResult[]): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const queryId = `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const stmt = this.db.prepare(`
          INSERT INTO search_analytics (
            id, query, source, filters, result_count, timestamp, user_id, session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          queryId,
          query.query,
          query.source || 'all',
          JSON.stringify(query.filters || []),
          results.length,
          Date.now(),
          query.userId || null,
          query.sessionId || null,
        );
      },
      catch: (error) => new DatabaseError(`Failed to record search query: ${error}`, error),
    });
  }

  recordClick(queryId: string, resultId: string, position: number): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const stmt = this.db.prepare(`
          INSERT INTO search_clicks (query_id, result_id, position, timestamp)
          VALUES (?, ?, ?, ?)
        `);

        stmt.run(queryId, resultId, position, Date.now());
      },
      catch: (error) => new DatabaseError(`Failed to record search click: ${error}`, error),
    });
  }

  getPopularQueries(limit: number = 10): Effect.Effect<Array<{ query: string; count: number }>, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const stmt = this.db.prepare(`
          SELECT query, COUNT(*) as count
          FROM search_analytics
          WHERE timestamp > ?
          GROUP BY query
          ORDER BY count DESC
          LIMIT ?
        `);

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const rows = stmt.all(sevenDaysAgo, limit) as Array<{ query: string; count: number }>;

        return rows;
      },
      catch: (error) => new DatabaseError(`Failed to get popular queries: ${error}`, error),
    });
  }

  getClickThroughRate(query: string): Effect.Effect<number, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const queryStmt = this.db.prepare(`
          SELECT COUNT(*) as query_count
          FROM search_analytics
          WHERE query = ? AND timestamp > ?
        `);

        const clickStmt = this.db.prepare(`
          SELECT COUNT(*) as click_count
          FROM search_analytics sa
          JOIN search_clicks sc ON sa.id = sc.query_id
          WHERE sa.query = ? AND sa.timestamp > ?
        `);

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        const queryCount = (queryStmt.get(query, sevenDaysAgo) as { query_count?: number })?.query_count || 0;
        const clickCount = (clickStmt.get(query, sevenDaysAgo) as { click_count?: number })?.click_count || 0;

        return queryCount > 0 ? clickCount / queryCount : 0;
      },
      catch: (error) => new DatabaseError(`Failed to get click-through rate: ${error}`, error),
    });
  }

  getSuggestions(partial: string): Effect.Effect<string[], DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const stmt = this.db.prepare(`
          SELECT DISTINCT query
          FROM search_analytics
          WHERE query LIKE ? AND timestamp > ?
          ORDER BY COUNT(*) DESC
          LIMIT 10
        `);

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const rows = stmt.all(`%${partial}%`, sevenDaysAgo) as Array<{ query: string }>;

        return rows.map((row) => row.query);
      },
      catch: (error) => new DatabaseError(`Failed to get suggestions: ${error}`, error),
    });
  }
}

/**
 * Search service context
 */
export const StreamingSearchServiceContext = Context.GenericTag<StreamingSearchService>('StreamingSearchService');

/**
 * Search service layer
 */
export const SearchServiceLayer = Layer.effect(
  StreamingSearchServiceContext,
  Effect.gen(function* () {
    // Create a simple cache service instance for now
    const { createCacheService } = yield* Effect.promise(() => import('./caching-layer.js'));
    const cacheService = yield* createCacheService();

    // Initialize search analytics database
    const { Database } = yield* Effect.promise(() => import('bun:sqlite'));
    const { homedir } = yield* Effect.promise(() => import('node:os'));
    const { join } = yield* Effect.promise(() => import('node:path'));

    const dbPath = join(homedir(), '.ji', 'data.db');
    const db = new Database(dbPath);

    // Create analytics tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_analytics (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        source TEXT,
        filters TEXT DEFAULT '[]',
        result_count INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        user_id TEXT,
        session_id TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS search_clicks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_id TEXT NOT NULL,
        result_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (query_id) REFERENCES search_analytics(id)
      )
    `);

    // Create indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_search_analytics_query 
      ON search_analytics(query);
      
      CREATE INDEX IF NOT EXISTS idx_search_analytics_timestamp 
      ON search_analytics(timestamp);
      
      CREATE INDEX IF NOT EXISTS idx_search_clicks_query 
      ON search_clicks(query_id);
    `);

    const analytics = new SearchAnalyticsService(db);
    return new EnhancedSearchEngine(cacheService, analytics);
  }),
);

/**
 * Create streaming search service
 */
export function createStreamingSearchService(): Effect.Effect<StreamingSearchService, DatabaseError> {
  return pipe(
    SearchServiceLayer,
    Layer.build,
    Effect.scoped,
    Effect.map((context) => Context.get(context, StreamingSearchServiceContext)),
    Effect.mapError((error) => new DatabaseError(`Failed to create search service: ${error}`, error)),
  );
}
