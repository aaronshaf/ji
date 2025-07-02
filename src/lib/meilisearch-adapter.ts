import { MeiliSearch, Index } from 'meilisearch';
import type { SearchableContent } from './content-manager.js';
import type { SearchResult } from './content-manager.js';
import { ConfigManager } from './config.js';
import { Effect, Schedule, pipe } from 'effect';
import {
  NetworkError,
  ValidationError,
  ParseError,
  ContentError,
  DatabaseError
} from './effects/errors.js';

interface MeilisearchDocument {
  id: string;
  originalId: string;
  key: string;
  title: string;
  content: string;
  source: string;
  url?: string;
  spaceKey?: string;
  projectKey?: string;
  updatedAt: number;
  createdAt: number;
  syncedAt: number;
  status?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  type?: string;
  description?: string;
  summary: string;
}

export class MeilisearchAdapter {
  private client: MeiliSearch;
  private jiraIndex!: Index;
  private confluenceIndex!: Index;
  private initialized = false;
  // Connection pool with retry strategy
  private retrySchedule = Schedule.exponential('200 millis').pipe(
    Schedule.intersect(Schedule.recurs(3))
  );
  // Circuit breaker state
  private isCircuitOpen = false;
  private lastFailureTime = 0;
  private circuitOpenDuration = 60000; // 1 minute

  constructor(host: string = 'http://localhost:7700', apiKey?: string) {
    this.client = new MeiliSearch({ host, apiKey });
  }

  private async getEmbedderConfig(embeddingModel: string): Promise<Record<string, unknown> | undefined> {
    // Check if Ollama is available
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      if (response.ok) {
        // Ollama is available, use hybrid search
        return {
          'hybrid': {
            source: 'ollama' as const,
            model: embeddingModel,
            url: 'http://localhost:11434/api/embeddings',
            documentTemplate: '{{doc.title}} {{doc.content}}'
          }
        };
      }
    } catch {
      // Ollama not available
    }
    
    // Return undefined - will use keyword search only
    return undefined;
  }

  async initialize() {
    if (this.initialized) return;

    // Get configured embedding model
    const configManager = new ConfigManager();
    const settings = await configManager.getSettings();
    const embeddingModel = settings.embeddingModel || 'mxbai-embed-large';
    configManager.close();

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
      },
      embedders: (await this.getEmbedderConfig(embeddingModel)) as never
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
      },
      embedders: (await this.getEmbedderConfig(embeddingModel)) as never
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

    const jiraDocs: MeilisearchDocument[] = [];
    const confluenceDocs: MeilisearchDocument[] = [];

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
    // Removed unnecessary 1-second delay - Meilisearch handles queuing internally
  }

  async search(query: string, options: {
    source?: 'jira' | 'confluence';
    filters?: string[];
    limit?: number;
    includeAll?: boolean;
  } = {}): Promise<SearchResult[]> {
    await this.initialize();

    const baseSearchParams = {
      limit: options.limit || 20,
      attributesToHighlight: ['title', 'content'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
      attributesToCrop: ['content'],
      cropLength: 200,
      showRankingScore: true,
      filter: undefined as string | undefined
    };

    // Handle search based on source
    const results: Array<{
      hits: Array<{
        _rankingScore?: number;
        _formatted?: { content?: string };
        _cropLength?: { content?: string };
        [key: string]: unknown;
      }>;
    }> = [];
    
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
    return sortedHits.map(hit => {
      const hitData = hit as unknown as MeilisearchDocument & {
        _rankingScore?: number;
        _formatted?: { content?: string };
        _cropLength?: { content?: string };
      };
      
      return {
        content: {
          id: hitData.originalId || (typeof hitData.id === 'string' ? hitData.id.replace('_', ':') : hitData.id),
          source: hitData.source as 'jira' | 'confluence',
          type: hitData.type || (hitData.source === 'jira' ? 'issue' : 'page'),
          title: hitData.title,
          content: hitData.content,
          url: hitData.url || '',
          spaceKey: hitData.spaceKey,
          projectKey: hitData.projectKey,
          metadata: {
            status: hitData.status,
            priority: hitData.priority,
            assignee: hitData.assignee,
            reporter: hitData.reporter
          },
          createdAt: hitData.createdAt,
          updatedAt: hitData.updatedAt,
          syncedAt: hitData.syncedAt
        },
        score: hitData._rankingScore || 0,
        snippet: hitData._formatted?.content || hitData._cropLength?.content || ''
      };
    });
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

  /**
   * Effect-based initialization with proper error handling
   */
  initializeEffect(): Effect.Effect<void, NetworkError | DatabaseError> {
    if (this.initialized) {
      return Effect.succeed(undefined);
    }

    return pipe(
      Effect.tryPromise({
        try: async () => {
          // Get configured embedding model
          const configManager = new ConfigManager();
          const settings = await configManager.getSettings();
          const embeddingModel = settings.embeddingModel || 'mxbai-embed-large';
          configManager.close();

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

          // Configure indexes
          const embedderConfig = await this.getEmbedderConfig(embeddingModel);
          
          await Promise.all([
            this.configureJiraIndex(embedderConfig),
            this.configureConfluenceIndex(embedderConfig)
          ]);

          await new Promise(resolve => setTimeout(resolve, 1000));
          this.initialized = true;
        },
        catch: (error) => {
          if (error instanceof Error) {
            if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
              return new NetworkError(`Failed to connect to Meilisearch: ${error.message}`);
            }
            return new DatabaseError(`Meilisearch initialization failed: ${error.message}`, error);
          }
          return new DatabaseError('Unknown initialization error', error);
        }
      }),
      Effect.retry(this.retrySchedule)
    );
  }

  /**
   * Effect-based content indexing with circuit breaker pattern
   */
  indexContentEffect(content: SearchableContent): Effect.Effect<void, NetworkError | ValidationError | ContentError | DatabaseError> {
    return pipe(
      Effect.sync(() => {
        if (!content || typeof content !== 'object') {
          throw new ValidationError('Content must be an object', 'content', content);
        }
        if (!content.id || content.id.length === 0) {
          throw new ValidationError('Content must have an ID', 'content.id', content.id);
        }
        if (!content.title || content.title.length === 0) {
          throw new ValidationError('Content must have a title', 'content.title', content.title);
        }
        if (!content.content || content.content.length === 0) {
          throw new ValidationError('Content must have content', 'content.content', undefined);
        }
      }),
      Effect.flatMap(() => this.circuitBreakerEffect(
        pipe(
          this.initializeEffect(),
          Effect.flatMap(() => Effect.tryPromise({
            try: async () => {
              const doc = this.prepareDocument(content);
              
              if (content.source === 'jira') {
                await this.jiraIndex.addDocuments([doc], { primaryKey: 'id' });
              } else {
                await this.confluenceIndex.addDocuments([doc], { primaryKey: 'id' });
              }
            },
            catch: (error) => {
              if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                  throw new NetworkError(`Index timeout: ${error.message}`);
                }
                throw new ContentError(`Failed to index content: ${error.message}`, error);
              }
              throw new ContentError('Unknown indexing error', error);
            }
          }))
        )
      )),
      Effect.retry(this.retrySchedule)
    );
  }

  /**
   * Effect-based batch indexing with concurrency control
   */
  indexBatchEffect(
    contents: SearchableContent[],
    batchSize: number = 100
  ): Effect.Effect<void, NetworkError | ValidationError | ContentError | DatabaseError> {
    return pipe(
      Effect.sync(() => {
        if (!Array.isArray(contents) || contents.length === 0) {
          throw new ValidationError('Contents must be a non-empty array', 'contents', contents);
        }
        if (batchSize <= 0 || batchSize > 1000) {
          throw new ValidationError('Batch size must be between 1 and 1000', 'batchSize', batchSize);
        }
      }),
      Effect.flatMap(() => this.circuitBreakerEffect(
        pipe(
          this.initializeEffect(),
          Effect.flatMap(() => {
            // Split into batches
            const batches = [];
            for (let i = 0; i < contents.length; i += batchSize) {
              batches.push(contents.slice(i, i + batchSize));
            }
            
            // Process batches sequentially to avoid overwhelming Meilisearch
            const batchEffects = batches.map(batch => 
              Effect.tryPromise({
                try: async () => {
                  const jiraDocs: MeilisearchDocument[] = [];
                  const confluenceDocs: MeilisearchDocument[] = [];

                  for (const content of batch) {
                    const doc = this.prepareDocument(content);
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
                },
                catch: (error) => {
                  if (error instanceof Error) {
                    throw new ContentError(`Batch indexing failed: ${error.message}`, error);
                  }
                  throw new ContentError('Unknown batch indexing error', error);
                }
              })
            );
            
            // Process batches with controlled concurrency
            return Effect.all(batchEffects, { concurrency: 2 }).pipe(
              Effect.map(() => undefined)
            );
          })
        )
      ))
    );
  }

  /**
   * Effect-based search with fallback strategies
   */
  searchEffect(
    query: string,
    options: {
      source?: 'jira' | 'confluence';
      filters?: string[];
      limit?: number;
      includeAll?: boolean;
    } = {}
  ): Effect.Effect<SearchResult[], NetworkError | ValidationError | ParseError | DatabaseError> {
    return pipe(
      Effect.sync(() => {
        if (!query || query.trim().length === 0) {
          throw new ValidationError('Query cannot be empty', 'query', query);
        }
        if (options.limit !== undefined && (options.limit <= 0 || options.limit > 1000)) {
          throw new ValidationError('Limit must be between 1 and 1000', 'limit', options.limit);
        }
      }),
      Effect.flatMap(() => this.circuitBreakerEffect(
        pipe(
          this.initializeEffect(),
          Effect.flatMap(() => Effect.tryPromise({
            try: async () => {
              const baseSearchParams = {
                limit: options.limit || 20,
                attributesToHighlight: ['title', 'content'],
                highlightPreTag: '<mark>',
                highlightPostTag: '</mark>',
                attributesToCrop: ['content'],
                cropLength: 200,
                showRankingScore: true,
                filter: undefined as string | undefined
              };

              const results: Array<{
                hits: Array<{
                  _rankingScore?: number;
                  _formatted?: { content?: string };
                  _cropLength?: { content?: string };
                  [key: string]: unknown;
                }>;
              }> = [];
              
              if (!options.source || options.source === 'jira') {
                const jiraParams = { ...baseSearchParams };
                const jiraFilters: string[] = [];
                
                if (!options.includeAll) {
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
                const confluenceParams = { ...baseSearchParams };
                
                if (options.filters?.length) {
                  confluenceParams.filter = options.filters.join(' AND ');
                }
                
                const confluenceResult = await this.confluenceIndex.search(query, confluenceParams);
                results.push(confluenceResult);
              }

              // Merge and sort results
              const allHits = results.flatMap(r => r.hits);
              const sortedHits = allHits.sort((a, b) => (b._rankingScore || 0) - (a._rankingScore || 0));

              // Cast hits to the expected type structure
              const typedHits = sortedHits as Array<{
                _rankingScore?: number;
                _formatted?: { content?: string };
                _cropLength?: { content?: string };
                id: string;
                originalId?: string;
                source: string;
                type?: string;
                title: string;
                content: string;
                url?: string;
                spaceKey?: string;
                projectKey?: string;
                status?: string;
                priority?: string;
                assignee?: string;
                reporter?: string;
                createdAt?: number;
                updatedAt?: number;
                syncedAt?: number;
              }>;
              return this.convertToSearchResults(typedHits);
            },
            catch: (error) => {
              if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                  throw new NetworkError(`Search timeout: ${error.message}`);
                }
                throw new ParseError(`Search failed: ${error.message}`, undefined, undefined, error);
              }
              throw new ParseError('Unknown search error', undefined, undefined, error);
            }
          }))
        )
      )),
      // Fallback to empty results if circuit breaker is open
      Effect.catchAll(error => {
        console.warn(`Meilisearch search failed: ${error.message}`);
        return Effect.succeed([]);
      })
    );
  }

  /**
   * Circuit breaker pattern implementation
   */
  private circuitBreakerEffect<T, E>(
    effect: Effect.Effect<T, E>
  ): Effect.Effect<T, E | NetworkError> {
    return pipe(
      Effect.sync(() => {
        // Check if circuit is open
        if (this.isCircuitOpen) {
          const timeSinceFailure = Date.now() - this.lastFailureTime;
          if (timeSinceFailure < this.circuitOpenDuration) {
            throw new NetworkError('Meilisearch circuit breaker open - service unavailable');
          }
          // Reset circuit breaker
          this.isCircuitOpen = false;
        }
      }),
      Effect.flatMap(() => effect),
      Effect.tapError(error => {
        // Open circuit on repeated failures
        if (error && typeof error === 'object' && '_tag' in error) {
          const taggedError = error as { _tag: string };
          if (taggedError._tag === 'NetworkError' || taggedError._tag === 'DatabaseError') {
            this.isCircuitOpen = true;
            this.lastFailureTime = Date.now();
          }
        }
        return Effect.succeed(undefined);
      })
    );
  }

  /**
   * Helper method to prepare document for indexing
   */
  private prepareDocument(content: SearchableContent) {
    return {
      id: content.id.replace(':', '_'),
      originalId: content.id,
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
  }

  /**
   * Helper method to configure Jira index
   */
  private async configureJiraIndex(embedderConfig: Record<string, unknown> | undefined) {
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
      },
      embedders: embedderConfig as never
    });
  }

  /**
   * Helper method to configure Confluence index
   */
  private async configureConfluenceIndex(embedderConfig: Record<string, unknown> | undefined) {
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
      },
      embedders: embedderConfig as never
    });
  }

  /**
   * Helper method to convert hits to SearchResult format
   */
  private convertToSearchResults(hits: Array<{
    _rankingScore?: number;
    _formatted?: { content?: string };
    _cropLength?: { content?: string };
    id: string;
    originalId?: string;
    source: string;
    type?: string;
    title: string;
    content: string;
    url?: string;
    spaceKey?: string;
    projectKey?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    reporter?: string;
    createdAt?: number;
    updatedAt?: number;
    syncedAt?: number;
  }>): SearchResult[] {
    return hits.map(hit => ({
      content: {
        id: hit.originalId || hit.id.replace('_', ':'),
        source: hit.source as 'jira' | 'confluence',
        type: hit.type || (hit.source === 'jira' ? 'issue' : 'page'),
        title: hit.title,
        content: hit.content,
        url: hit.url || '',
        spaceKey: hit.spaceKey,
        projectKey: hit.projectKey,
        metadata: {
          status: hit.status,
          priority: hit.priority,
          assignee: hit.assignee,
          reporter: hit.reporter
        },
        createdAt: hit.createdAt || Date.now(),
        updatedAt: hit.updatedAt || Date.now(),
        syncedAt: hit.syncedAt || Date.now()
      },
      score: hit._rankingScore || 0,
      snippet: hit._formatted?.content || hit._cropLength?.content || ''
    }));
  }
}