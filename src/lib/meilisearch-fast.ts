import { MeiliSearch, Index } from 'meilisearch';
import type { SearchableContent } from './content-manager.js';
import type { SearchResult } from './content-manager.js';

// Singleton instance for fast access
let instance: MeilisearchFast | null = null;

export class MeilisearchFast {
  private client: MeiliSearch;
  private jiraIndex: Index;
  private confluenceIndex: Index;
  
  constructor(host: string = 'http://localhost:7700', apiKey?: string) {
    this.client = new MeiliSearch({ host, apiKey });
    // Pre-initialize indexes - no async needed
    this.jiraIndex = this.client.index('jira-issues');
    this.confluenceIndex = this.client.index('confluence-pages');
  }
  
  static getInstance(): MeilisearchFast {
    if (!instance) {
      instance = new MeilisearchFast();
    }
    return instance;
  }
  
  async search(query: string, options: {
    source?: 'jira' | 'confluence';
    filters?: string[];
    limit?: number;
    includeAll?: boolean;
  } = {}): Promise<SearchResult[]> {
    // Calculate per-index limit based on total desired limit
    const totalLimit = options.limit || 5;
    const perIndexLimit = options.source ? totalLimit : Math.ceil(totalLimit * 0.6);
    
    const baseSearchParams: any = {
      limit: perIndexLimit,
      attributesToHighlight: ['title', 'content'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
      attributesToCrop: ['content'],
      cropLength: 200,
      showRankingScore: true
    };

    // Handle search based on source
    let results: any[] = [];
    
    if (!options.source || options.source === 'jira') {
      // Search Jira with status filters
      const jiraParams = { ...baseSearchParams };
      const jiraFilters: string[] = [];
      
      if (!options.includeAll) {
        // Exclude closed/done issues by default for Jira
        jiraFilters.push('(status != "Closed" AND status != "Done" AND status != "Resolved" AND status != "Cancelled" AND status != "Rejected" AND status != "Won\'t Do")');
      }
      
      if (options.filters?.length) {
        jiraFilters.push(...options.filters);
      }
      
      if (jiraFilters.length > 0) {
        jiraParams.filter = jiraFilters.join(' AND ');
      }
      
      const jiraResult = await this.jiraIndex.search(query, jiraParams);
      results.push(jiraResult);
    }
    
    if (!options.source || options.source === 'confluence') {
      // Search Confluence without status filters
      const confluenceParams = { ...baseSearchParams };
      
      if (options.filters?.length) {
        confluenceParams.filter = options.filters.join(' AND ');
      }
      
      const confluenceResult = await this.confluenceIndex.search(query, confluenceParams);
      results.push(confluenceResult);
    }

    // Merge and sort results by ranking score
    const allHits = results.flatMap(r => r.hits);
    
    // Sort first to analyze score distribution
    const sortedHits = allHits.sort((a, b) => (b._rankingScore || 0) - (a._rankingScore || 0));
    
    // Smart filtering based on score gaps between results
    let filteredHits = sortedHits;
    
    if (sortedHits.length > 1) {
      const topScore = sortedHits[0]._rankingScore || 0;
      
      // Look for significant score drops (15%+ gap)
      const results = [];
      results.push(sortedHits[0]); // Always include the top result
      
      for (let i = 1; i < sortedHits.length; i++) {
        const currentScore = sortedHits[i]._rankingScore || 0;
        const previousScore = sortedHits[i - 1]._rankingScore || 0;
        
        // Calculate the gap as a percentage of the top score
        const scoreGap = (previousScore - currentScore);
        const gapPercentage = scoreGap / topScore;
        
        // If there's a 15%+ gap from the previous result, stop here
        if (gapPercentage >= 0.15) {
          break;
        }
        
        // Also stop if the current result is below 50% of the top score
        if (currentScore / topScore < 0.5) {
          break;
        }
        
        results.push(sortedHits[i]);
      }
      
      filteredHits = results;
    } else if (sortedHits.length === 1) {
      // Single result, check if it meets minimum quality
      const score = sortedHits[0]._rankingScore || 0;
      filteredHits = score >= 0.3 ? sortedHits : [];
    }
    
    // Limit to requested total
    const limitedHits = filteredHits.slice(0, totalLimit);

    // Convert to SearchResult format
    return limitedHits.map(hit => ({
      content: {
        id: hit.originalId || hit.id.replace('_', ':'), // Convert back to original ID format
        source: hit.source as 'jira' | 'confluence',
        type: hit.type || (hit.source === 'jira' ? 'issue' : 'page'),
        title: hit.title,
        content: hit.content,
        url: hit.url,
        spaceKey: hit.spaceKey,
        projectKey: hit.projectKey,
        metadata: {
          status: hit.status,
          priority: hit.priority,
          assignee: hit.assignee,
          reporter: hit.reporter
        },
        createdAt: hit.createdAt,
        updatedAt: hit.updatedAt,
        syncedAt: hit.syncedAt
      },
      score: hit._rankingScore || 0,
      snippet: hit._formatted?.content || hit._cropLength?.content || ''
    }));
  }

  async hybridSearch(query: string, options: {
    source?: 'jira' | 'confluence';
    filters?: string[];
    limit?: number;
    includeAll?: boolean;
  } = {}): Promise<SearchResult[]> {
    // Calculate per-index limit based on total desired limit
    const totalLimit = options.limit || 5;
    const perIndexLimit = options.source ? totalLimit : Math.ceil(totalLimit * 0.6);
    
    const baseSearchParams: any = {
      limit: perIndexLimit,
      attributesToHighlight: ['title', 'content'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
      attributesToCrop: ['content'],
      cropLength: 200,
      showRankingScore: true,
      hybrid: {
        embedder: 'hybrid',
        semanticRatio: 0.5 // 50% semantic, 50% keyword
      }
    };
    
    // Debug: Log to verify hybrid search is being used
    if (process.env.DEBUG) {
      console.log('Hybrid search params:', JSON.stringify(baseSearchParams, null, 2));
    }

    // Handle search based on source
    let results: any[] = [];
    
    if (!options.source || options.source === 'jira') {
      // Search Jira with status filters
      const jiraParams = { ...baseSearchParams };
      const jiraFilters: string[] = [];
      
      if (!options.includeAll) {
        // Exclude closed/done issues by default for Jira
        jiraFilters.push('(status != "Closed" AND status != "Done" AND status != "Resolved" AND status != "Cancelled" AND status != "Rejected" AND status != "Won\'t Do")');
      }
      
      if (options.filters?.length) {
        jiraFilters.push(...options.filters);
      }
      
      if (jiraFilters.length > 0) {
        jiraParams.filter = jiraFilters.join(' AND ');
      }
      
      try {
        const jiraResult = await this.jiraIndex.search(query, jiraParams);
        results.push(jiraResult);
      } catch (error) {
        console.error('Jira hybrid search failed:', error);
        // Fall back to regular search
        const { hybrid, ...fallbackParams } = jiraParams;
        const jiraResult = await this.jiraIndex.search(query, fallbackParams);
        results.push(jiraResult);
      }
    }
    
    if (!options.source || options.source === 'confluence') {
      // Search Confluence without status filters
      const confluenceParams = { ...baseSearchParams };
      
      if (options.filters?.length) {
        confluenceParams.filter = options.filters.join(' AND ');
      }
      
      try {
        const confluenceResult = await this.confluenceIndex.search(query, confluenceParams);
        results.push(confluenceResult);
      } catch (error) {
        console.error('Confluence hybrid search failed:', error);
        // Fall back to regular search
        const { hybrid, ...fallbackParams } = confluenceParams;
        const confluenceResult = await this.confluenceIndex.search(query, fallbackParams);
        results.push(confluenceResult);
      }
    }

    // Process results the same way as regular search
    const allHits = results.flatMap(r => r.hits);
    const sortedHits = allHits.sort((a, b) => (b._rankingScore || 0) - (a._rankingScore || 0));
    
    // Smart filtering based on score gaps between results
    let filteredHits = sortedHits;
    
    if (sortedHits.length > 1) {
      const topScore = sortedHits[0]._rankingScore || 0;
      
      // Look for significant score drops (15%+ gap)
      const results = [];
      results.push(sortedHits[0]); // Always include the top result
      
      for (let i = 1; i < sortedHits.length; i++) {
        const currentScore = sortedHits[i]._rankingScore || 0;
        const previousScore = sortedHits[i - 1]._rankingScore || 0;
        
        // Calculate the gap as a percentage of the top score
        const scoreGap = (previousScore - currentScore);
        const gapPercentage = scoreGap / topScore;
        
        // If there's a 15%+ gap from the previous result, stop here
        if (gapPercentage >= 0.15) {
          break;
        }
        
        // Also stop if the current result is below 50% of the top score
        if (currentScore / topScore < 0.5) {
          break;
        }
        
        results.push(sortedHits[i]);
      }
      
      filteredHits = results;
    } else if (sortedHits.length === 1) {
      // Single result, check if it meets minimum quality
      const score = sortedHits[0]._rankingScore || 0;
      filteredHits = score >= 0.3 ? sortedHits : [];
    }
    
    const limitedHits = filteredHits.slice(0, totalLimit);

    // Convert to SearchResult format
    return limitedHits.map(hit => ({
      content: {
        id: hit.originalId || hit.id.replace('_', ':'),
        source: hit.source as 'jira' | 'confluence',
        type: hit.type || (hit.source === 'jira' ? 'issue' : 'page'),
        title: hit.title,
        content: hit.content,
        url: hit.url,
        spaceKey: hit.spaceKey,
        projectKey: hit.projectKey,
        metadata: {
          status: hit.status,
          priority: hit.priority,
          assignee: hit.assignee,
          reporter: hit.reporter
        },
        createdAt: hit.createdAt,
        updatedAt: hit.updatedAt,
        syncedAt: hit.syncedAt
      },
      score: hit._rankingScore || 0,
      snippet: hit._formatted?.content || hit._cropLength?.content || ''
    }));
  }
}