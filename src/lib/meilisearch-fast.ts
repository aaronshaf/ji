import { MeiliSearch, Index } from 'meilisearch';
import type { SearchableContent } from './content-manager.js';
import type { SearchResult } from './embeddings.js';

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
    const sortedHits = allHits.sort((a, b) => (b._rankingScore || 0) - (a._rankingScore || 0));
    
    // Limit to requested total
    const limitedHits = sortedHits.slice(0, totalLimit);

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
}