import { MeiliSearch, Index } from 'meilisearch';
import type { SearchableContent } from './content-manager.js';
import type { SearchResult } from './embeddings.js';

export class MeilisearchAdapter {
  private client: MeiliSearch;
  private jiraIndex!: Index;
  private confluenceIndex!: Index;
  private initialized = false;

  constructor(host: string = 'http://localhost:7700', apiKey?: string) {
    this.client = new MeiliSearch({ host, apiKey });
  }

  async initialize() {
    if (this.initialized) return;

    // Get or create indexes
    this.jiraIndex = this.client.index('jira-issues');
    this.confluenceIndex = this.client.index('confluence-pages');
    
    // Create indexes if they don't exist
    try {
      await this.jiraIndex.getStats();
    } catch {
      await this.client.createIndex('jira-issues', { primaryKey: 'id' });
    }

    try {
      await this.confluenceIndex.getStats();
    } catch {
      await this.client.createIndex('confluence-pages', { primaryKey: 'id' });
    }

    // Wait for indexes to be created
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Configure Jira index
    await this.jiraIndex.updateSettings({
      searchableAttributes: ['key', 'title', 'content', 'summary', 'description'],
      filterableAttributes: ['status', 'priority', 'assignee', 'projectKey', 'source', 'reporter', 'originalId'],
      sortableAttributes: ['updatedAt', 'createdAt'],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'sort',
        'exactness',
        'updatedAt:desc'
      ],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 3,
          twoTypos: 6
        }
      },
      synonyms: {
        'k8s': ['kubernetes'],
        'auth': ['authentication', 'authorization'],
        'db': ['database'],
        'config': ['configuration'],
        'deploy': ['deployment', 'release'],
        'api': ['endpoint', 'service'],
        'error': ['exception', 'failure', 'issue'],
        'setup': ['configuration', 'install']
      }
    });

    // Configure Confluence index
    await this.confluenceIndex.updateSettings({
      searchableAttributes: ['title', 'content', 'spaceKey'],
      filterableAttributes: ['spaceKey', 'source', 'type', 'originalId'],
      sortableAttributes: ['updatedAt', 'createdAt'],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'sort',
        'exactness',
        'updatedAt:desc'
      ],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 3,
          twoTypos: 6
        }
      }
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
    this.initialized = true;
  }

  async indexContent(content: SearchableContent) {
    await this.initialize();

    const doc = {
      id: content.id.replace(':', '_'), // Replace colon with underscore for Meilisearch compatibility
      originalId: content.id, // Keep original ID for reference
      key: content.id.replace(/^(jira|confluence):/, ''),
      title: content.title,
      content: content.content.substring(0, 50000), // Meilisearch has a 100KB limit per field
      source: content.source,
      url: content.url,
      spaceKey: content.spaceKey,
      projectKey: content.projectKey,
      updatedAt: content.updatedAt || Date.now(),
      createdAt: content.createdAt || Date.now(),
      syncedAt: content.syncedAt,
      // Flatten metadata for filtering
      status: content.metadata?.status,
      priority: content.metadata?.priority,
      assignee: content.metadata?.assignee,
      reporter: content.metadata?.reporter,
      type: content.type,
      // Add description and summary for Jira issues
      description: content.type === 'issue' ? content.content.split('\n')[0] : undefined,
      summary: content.title.includes(':') ? content.title.split(': ')[1] : content.title
    };

    if (content.source === 'jira') {
      await this.jiraIndex.addDocuments([doc], { primaryKey: 'id' });
    } else {
      await this.confluenceIndex.addDocuments([doc], { primaryKey: 'id' });
    }
  }

  async indexBatch(contents: SearchableContent[]) {
    await this.initialize();

    const jiraDocs: any[] = [];
    const confluenceDocs: any[] = [];

    for (const content of contents) {
      const doc = {
        id: content.id.replace(':', '_'), // Replace colon with underscore for Meilisearch compatibility
        originalId: content.id, // Keep original ID for reference
        key: content.id.replace(/^(jira|confluence):/, ''),
        title: content.title,
        content: content.content.substring(0, 50000),
        source: content.source,
        url: content.url,
        spaceKey: content.spaceKey,
        projectKey: content.projectKey,
        updatedAt: content.updatedAt || Date.now(),
        createdAt: content.createdAt || Date.now(),
        syncedAt: content.syncedAt,
        status: content.metadata?.status,
        priority: content.metadata?.priority,
        assignee: content.metadata?.assignee,
        reporter: content.metadata?.reporter,
        type: content.type,
        description: content.type === 'issue' ? content.content.split('\n')[0] : undefined,
        summary: content.title.includes(':') ? content.title.split(': ')[1] : content.title
      };

      if (content.source === 'jira') {
        jiraDocs.push(doc);
      } else {
        confluenceDocs.push(doc);
      }
    }

    const tasks = [];
    if (jiraDocs.length > 0) {
      tasks.push(this.jiraIndex.addDocuments(jiraDocs, { primaryKey: 'id' }));
    }
    if (confluenceDocs.length > 0) {
      tasks.push(this.confluenceIndex.addDocuments(confluenceDocs, { primaryKey: 'id' }));
    }

    await Promise.all(tasks);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async search(query: string, options: {
    source?: 'jira' | 'confluence';
    filters?: string[];
    limit?: number;
    includeAll?: boolean;
  } = {}): Promise<SearchResult[]> {
    await this.initialize();

    const baseSearchParams: any = {
      limit: options.limit || 20,
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

    // Convert to SearchResult format
    return sortedHits.map(hit => ({
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

  async deleteContent(contentId: string) {
    await this.initialize();
    
    // Convert ID to Meilisearch format
    const meilisearchId = contentId.replace(':', '_');
    
    if (contentId.startsWith('jira:')) {
      await this.jiraIndex.deleteDocument(meilisearchId);
    } else if (contentId.startsWith('confluence:')) {
      await this.confluenceIndex.deleteDocument(meilisearchId);
    }
  }

  async clearIndex(source: 'jira' | 'confluence') {
    await this.initialize();
    
    if (source === 'jira') {
      await this.jiraIndex.deleteAllDocuments();
    } else {
      await this.confluenceIndex.deleteAllDocuments();
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async getStats() {
    await this.initialize();
    
    const [jiraStats, confluenceStats] = await Promise.all([
      this.jiraIndex.getStats(),
      this.confluenceIndex.getStats()
    ]);

    return {
      jira: {
        numberOfDocuments: jiraStats.numberOfDocuments,
        isIndexing: jiraStats.isIndexing
      },
      confluence: {
        numberOfDocuments: confluenceStats.numberOfDocuments,
        isIndexing: confluenceStats.isIndexing
      }
    };
  }

  async waitForIndexing() {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}