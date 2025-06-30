# Meilisearch Integration for Ji

## Installation & Setup

### 1. Install Meilisearch
```bash
# macOS
brew install meilisearch

# Or using Docker
docker run -it --rm \
  -p 7700:7700 \
  -v $(pwd)/meili_data:/meili_data \
  getmeili/meilisearch:latest
```

### 2. Add Dependencies
```bash
bun add meilisearch
```

## Implementation Example

### MeilisearchAdapter Class

```typescript
// src/lib/meilisearch-adapter.ts
import { MeiliSearch, Index } from 'meilisearch';
import type { SearchableContent } from './content-manager.js';

export class MeilisearchAdapter {
  private client: MeiliSearch;
  private jiraIndex: Index;
  private confluenceIndex: Index;

  constructor(host: string = 'http://localhost:7700', apiKey?: string) {
    this.client = new MeiliSearch({ host, apiKey });
    this.jiraIndex = this.client.index('jira-issues');
    this.confluenceIndex = this.client.index('confluence-pages');
  }

  async initialize() {
    // Configure Jira index
    await this.jiraIndex.updateSettings({
      searchableAttributes: ['title', 'content', 'key', 'summary'],
      filterableAttributes: ['status', 'priority', 'assignee', 'projectKey', 'source'],
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
      synonyms: {
        'k8s': ['kubernetes'],
        'auth': ['authentication', 'authorization'],
        'db': ['database'],
      }
    });

    // Configure Confluence index
    await this.confluenceIndex.updateSettings({
      searchableAttributes: ['title', 'content', 'spaceKey'],
      filterableAttributes: ['spaceKey', 'source'],
      sortableAttributes: ['updatedAt', 'createdAt'],
    });
  }

  async indexContent(content: SearchableContent) {
    const doc = {
      id: content.id,
      key: content.id.replace(/^(jira|confluence):/, ''),
      title: content.title,
      content: content.content.substring(0, 10000), // Meilisearch has limits
      source: content.source,
      url: content.url,
      updatedAt: content.updatedAt || Date.now(),
      createdAt: content.createdAt || Date.now(),
      ...content.metadata
    };

    if (content.source === 'jira') {
      await this.jiraIndex.addDocuments([doc]);
    } else {
      await this.confluenceIndex.addDocuments([doc]);
    }
  }

  async search(query: string, options: {
    source?: 'jira' | 'confluence';
    filters?: string[];
    limit?: number;
  }) {
    const searchParams = {
      limit: options.limit || 20,
      attributesToHighlight: ['title', 'content'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
      attributesToCrop: ['content'],
      cropLength: 200,
    };

    if (options.filters?.length) {
      searchParams.filter = options.filters.join(' AND ');
    }

    const indexes = options.source 
      ? [options.source === 'jira' ? this.jiraIndex : this.confluenceIndex]
      : [this.jiraIndex, this.confluenceIndex];

    const results = await Promise.all(
      indexes.map(index => index.search(query, searchParams))
    );

    // Merge and sort results
    const allHits = results.flatMap(r => r.hits);
    return allHits.sort((a, b) => (b._rankingScore || 0) - (a._rankingScore || 0));
  }
}
```

### Integration with Existing Code

```typescript
// src/cli.ts - Modified search function
async function search(query: string, options: { 
  semantic?: boolean, 
  source?: 'jira' | 'confluence',
  limit?: number,
  includeAll?: boolean,
  engine?: 'sqlite' | 'meilisearch'
}) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  try {
    let results: SearchResult[];

    if (options.engine === 'meilisearch') {
      const meili = new MeilisearchAdapter();
      const hits = await meili.search(query, {
        source: options.source,
        limit: options.limit,
        filters: options.includeAll ? [] : ['status != Closed', 'status != Done']
      });

      // Convert Meilisearch results to SearchResult format
      results = hits.map(hit => ({
        content: {
          id: `${hit.source}:${hit.key}`,
          source: hit.source,
          type: hit.source === 'jira' ? 'issue' : 'page',
          title: hit.title,
          content: hit.content,
          url: hit.url,
          metadata: {
            status: hit.status,
            priority: hit.priority,
            assignee: hit.assignee,
          },
          updatedAt: hit.updatedAt,
          createdAt: hit.createdAt,
          syncedAt: Date.now()
        },
        score: hit._rankingScore || 0,
        snippet: hit._formatted?.content || ''
      }));
    } else {
      // Use existing SQLite/embeddings search
      const embeddingManager = new EmbeddingManager();
      results = options.semantic 
        ? await embeddingManager.searchSemantic(query, options)
        : await embeddingManager.hybridSearch(query, options);
    }

    // Display results (existing code)
    // ...
  } catch (error) {
    console.error(`Search failed: ${error}`);
  }
}
```

## Migration Strategy

### 1. Parallel Indexing
```typescript
async function syncToMeilisearch() {
  const contentManager = new ContentManager();
  const meili = new MeilisearchAdapter();
  
  // Get all content from SQLite
  const contents = await contentManager.getAllContent();
  
  // Batch index to Meilisearch
  const batchSize = 1000;
  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);
    await Promise.all(batch.map(content => meili.indexContent(content)));
    console.log(`Indexed ${i + batch.length}/${contents.length}`);
  }
}
```

### 2. Hybrid Mode
- Keep SQLite as primary storage
- Use Meilisearch for search only
- Fall back to SQLite if Meilisearch is unavailable

### 3. Gradual Rollout
```bash
# Start with opt-in
ji search --engine meilisearch "query"

# Make it default with env var
export JI_SEARCH_ENGINE=meilisearch

# Eventually make it default in code
```

## Benefits Over Current Implementation

1. **Performance**
   - Sub-50ms search latency
   - Handles millions of documents
   - Built-in caching and optimization

2. **Features**
   - Typo tolerance (finds "xslint" when searching "xsslint")
   - Faceted search UI possibilities
   - Built-in analytics dashboard

3. **Operations**
   - Zero-downtime reindexing
   - Easy backup/restore
   - Prometheus metrics

## Considerations

1. **Additional Dependency**
   - Requires running Meilisearch server
   - Could use cloud version for simplicity

2. **Data Consistency**
   - Need to keep SQLite and Meilisearch in sync
   - Handle partial failures gracefully

3. **Offline Support**
   - Keep SQLite for offline mode
   - Detect Meilisearch availability

## Next Steps

1. Set up local Meilisearch instance
2. Implement MeilisearchAdapter
3. Add --engine flag to search command
4. Test with your dataset
5. Measure performance improvements