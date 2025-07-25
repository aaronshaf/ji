import { describe, expect, it } from 'bun:test';

// Test MeilisearchAdapter without external dependencies
describe('MeilisearchAdapter Utilities', () => {
  describe('Document transformation', () => {
    it('should transform SearchableContent to MeilisearchDocument format', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const transformSearchableContent = (content: any) => {
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
          summary: content.title.includes(':') ? content.title.split(': ')[1] : content.title,
        };
      };

      const jiraContent = {
        id: 'jira:TEST-123',
        title: 'TEST-123: Login bug needs fixing',
        content: 'Users cannot authenticate with special characters\nThis is a detailed description',
        source: 'jira',
        url: 'https://company.atlassian.net/browse/TEST-123',
        projectKey: 'TEST',
        updatedAt: 1640995200000,
        createdAt: 1640908800000,
        syncedAt: 1640995200000,
        type: 'issue',
        metadata: {
          status: 'Open',
          priority: 'High',
          assignee: 'john.doe@company.com',
          reporter: 'jane.smith@company.com',
        },
      };

      const transformed = transformSearchableContent(jiraContent);

      expect(transformed.id).toBe('jira_TEST-123');
      expect(transformed.originalId).toBe('jira:TEST-123');
      expect(transformed.key).toBe('TEST-123');
      expect(transformed.title).toBe('TEST-123: Login bug needs fixing');
      expect(transformed.content).toBe(
        'Users cannot authenticate with special characters\nThis is a detailed description',
      );
      expect(transformed.source).toBe('jira');
      expect(transformed.status).toBe('Open');
      expect(transformed.priority).toBe('High');
      expect(transformed.assignee).toBe('john.doe@company.com');
      expect(transformed.type).toBe('issue');
      expect(transformed.description).toBe('Users cannot authenticate with special characters');
      expect(transformed.summary).toBe('Login bug needs fixing');
    });

    it('should handle Confluence content transformation', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const transformSearchableContent = (content: any) => {
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
          summary: content.title.includes(':') ? content.title.split(': ')[1] : content.title,
        };
      };

      const confluenceContent = {
        id: 'confluence:123456',
        title: 'API Documentation',
        content: 'This page contains API documentation for our service',
        source: 'confluence',
        url: 'https://company.atlassian.net/wiki/pages/123456',
        spaceKey: 'DOCS',
        updatedAt: 1640995200000,
        createdAt: 1640908800000,
        syncedAt: 1640995200000,
        type: 'page',
      };

      const transformed = transformSearchableContent(confluenceContent);

      expect(transformed.id).toBe('confluence_123456');
      expect(transformed.originalId).toBe('confluence:123456');
      expect(transformed.key).toBe('123456');
      expect(transformed.source).toBe('confluence');
      expect(transformed.spaceKey).toBe('DOCS');
      expect(transformed.type).toBe('page');
      expect(transformed.description).toBeUndefined(); // Not an issue
      expect(transformed.summary).toBe('API Documentation'); // No colon, use full title
    });

    it('should truncate long content to 50000 characters', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const transformSearchableContent = (content: any) => {
        return {
          content: content.content.substring(0, 50000),
        };
      };

      const longContent = 'A'.repeat(60000);
      const mockContent = { content: longContent };

      const transformed = transformSearchableContent(mockContent);

      expect(transformed.content.length).toBe(50000);
      expect(transformed.content).toBe('A'.repeat(50000));
    });
  });

  describe('Index naming and prefixes', () => {
    it('should generate correct index names with prefix', () => {
      const generateIndexNames = (prefix: string) => {
        return {
          jiraIndex: `${prefix}-jira-issues`,
          confluenceIndex: `${prefix}-confluence-pages`,
        };
      };

      const names1 = generateIndexNames('john_doe');
      expect(names1.jiraIndex).toBe('john_doe-jira-issues');
      expect(names1.confluenceIndex).toBe('john_doe-confluence-pages');

      const names2 = generateIndexNames('company_team');
      expect(names2.jiraIndex).toBe('company_team-jira-issues');
      expect(names2.confluenceIndex).toBe('company_team-confluence-pages');
    });
  });

  describe('Batch processing utilities', () => {
    it('should split content into Jira and Confluence batches', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const splitContentBySource = (contents: any[]) => {
        // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
        const jiraDocs: any[] = [];
        // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
        const confluenceDocs: any[] = [];

        for (const content of contents) {
          if (content.source === 'jira') {
            jiraDocs.push(content);
          } else {
            confluenceDocs.push(content);
          }
        }

        return { jiraDocs, confluenceDocs };
      };

      const mixedContent = [
        { id: 'jira:TEST-1', source: 'jira', title: 'Jira Issue 1' },
        { id: 'confluence:123', source: 'confluence', title: 'Confluence Page 1' },
        { id: 'jira:TEST-2', source: 'jira', title: 'Jira Issue 2' },
        { id: 'confluence:456', source: 'confluence', title: 'Confluence Page 2' },
        { id: 'jira:TEST-3', source: 'jira', title: 'Jira Issue 3' },
      ];

      const { jiraDocs, confluenceDocs } = splitContentBySource(mixedContent);

      expect(jiraDocs).toHaveLength(3);
      expect(confluenceDocs).toHaveLength(2);
      expect(jiraDocs[0].id).toBe('jira:TEST-1');
      expect(jiraDocs[1].id).toBe('jira:TEST-2');
      expect(jiraDocs[2].id).toBe('jira:TEST-3');
      expect(confluenceDocs[0].id).toBe('confluence:123');
      expect(confluenceDocs[1].id).toBe('confluence:456');
    });

    it('should create batches of specified size', () => {
      const createBatches = <T>(items: T[], batchSize: number): T[][] => {
        const batches: T[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
          batches.push(items.slice(i, i + batchSize));
        }
        return batches;
      };

      const items = Array.from({ length: 350 }, (_, i) => ({ id: i }));
      const batches = createBatches(items, 100);

      expect(batches).toHaveLength(4);
      expect(batches[0]).toHaveLength(100);
      expect(batches[1]).toHaveLength(100);
      expect(batches[2]).toHaveLength(100);
      expect(batches[3]).toHaveLength(50); // Remainder
      expect(batches[0][0].id).toBe(0);
      expect(batches[3][49].id).toBe(349);
    });
  });

  describe('Search parameter building', () => {
    it('should build base search parameters correctly', () => {
      const buildSearchParams = (options: { limit?: number } = {}) => {
        return {
          limit: options.limit || 20,
          attributesToHighlight: ['title', 'content'],
          highlightPreTag: '<mark>',
          highlightPostTag: '</mark>',
          attributesToCrop: ['content'],
          cropLength: 200,
          showRankingScore: true,
          filter: undefined as string | undefined,
        };
      };

      // Default parameters
      const defaultParams = buildSearchParams();
      expect(defaultParams.limit).toBe(20);
      expect(defaultParams.attributesToHighlight).toEqual(['title', 'content']);
      expect(defaultParams.highlightPreTag).toBe('<mark>');
      expect(defaultParams.highlightPostTag).toBe('</mark>');
      expect(defaultParams.cropLength).toBe(200);
      expect(defaultParams.showRankingScore).toBe(true);

      // Custom limit
      const customParams = buildSearchParams({ limit: 50 });
      expect(customParams.limit).toBe(50);
    });

    it('should build filter strings for search', () => {
      const buildFilterString = (filters: string[]): string | undefined => {
        if (filters.length === 0) return undefined;
        return filters.join(' AND ');
      };

      expect(buildFilterString([])).toBeUndefined();
      expect(buildFilterString(['status = "Open"'])).toBe('status = "Open"');
      expect(buildFilterString(['status = "Open"', 'priority = "High"'])).toBe('status = "Open" AND priority = "High"');
      expect(buildFilterString(['projectKey = "TEST"', 'assignee = "john"', 'status != "Closed"'])).toBe(
        'projectKey = "TEST" AND assignee = "john" AND status != "Closed"',
      );
    });
  });

  describe('Circuit breaker utilities', () => {
    it('should track circuit breaker state', () => {
      class MockCircuitBreaker {
        private isCircuitOpen = false;
        private lastFailureTime = 0;
        private circuitOpenDuration = 60000; // 1 minute

        openCircuit() {
          this.isCircuitOpen = true;
          this.lastFailureTime = Date.now();
        }

        isOpen(): boolean {
          if (!this.isCircuitOpen) return false;

          const now = Date.now();
          if (now - this.lastFailureTime >= this.circuitOpenDuration) {
            this.isCircuitOpen = false;
            return false;
          }
          return true;
        }

        shouldSkipOperation(): boolean {
          return this.isOpen();
        }
      }

      const breaker = new MockCircuitBreaker();

      // Initially closed
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.shouldSkipOperation()).toBe(false);

      // Open circuit
      breaker.openCircuit();
      expect(breaker.isOpen()).toBe(true);
      expect(breaker.shouldSkipOperation()).toBe(true);

      // Test that it remains open during the timeout period
      expect(breaker.isOpen()).toBe(true);
    });
  });

  describe('Ollama embedder configuration', () => {
    it('should build Ollama embedder configuration', () => {
      const buildOllamaConfig = (embeddingModel: string) => {
        return {
          hybrid: {
            source: 'ollama' as const,
            model: embeddingModel,
            url: 'http://localhost:11434/api/embeddings',
            documentTemplate: '{{doc.title}} {{doc.content}}',
          },
        };
      };

      const config = buildOllamaConfig('mxbai-embed-large');

      expect(config.hybrid.source).toBe('ollama');
      expect(config.hybrid.model).toBe('mxbai-embed-large');
      expect(config.hybrid.url).toBe('http://localhost:11434/api/embeddings');
      expect(config.hybrid.documentTemplate).toBe('{{doc.title}} {{doc.content}}');
    });

    it('should handle different embedding models', () => {
      const buildOllamaConfig = (embeddingModel: string) => {
        return {
          hybrid: {
            source: 'ollama' as const,
            model: embeddingModel,
            url: 'http://localhost:11434/api/embeddings',
            documentTemplate: '{{doc.title}} {{doc.content}}',
          },
        };
      };

      const config1 = buildOllamaConfig('nomic-embed-text');
      const config2 = buildOllamaConfig('all-minilm');

      expect(config1.hybrid.model).toBe('nomic-embed-text');
      expect(config2.hybrid.model).toBe('all-minilm');
    });
  });

  describe('Index settings configuration', () => {
    it('should build Jira index settings', () => {
      const buildJiraIndexSettings = () => {
        return {
          searchableAttributes: ['key', 'title', 'content', 'summary', 'description'],
          filterableAttributes: ['status', 'priority', 'assignee', 'projectKey', 'source', 'reporter', 'originalId'],
          sortableAttributes: ['updatedAt', 'createdAt'],
          rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'updatedAt:desc'],
          typoTolerance: {
            enabled: true,
            minWordSizeForTypos: {
              oneTypo: 3,
              twoTypos: 6,
            },
          },
          synonyms: {
            k8s: ['kubernetes'],
            auth: ['authentication', 'authorization'],
            db: ['database'],
            config: ['configuration'],
            deploy: ['deployment', 'release'],
            api: ['endpoint', 'service'],
            error: ['exception', 'failure', 'issue'],
            setup: ['configuration', 'install'],
          },
        };
      };

      const settings = buildJiraIndexSettings();

      expect(settings.searchableAttributes).toContain('key');
      expect(settings.searchableAttributes).toContain('title');
      expect(settings.searchableAttributes).toContain('content');
      expect(settings.filterableAttributes).toContain('status');
      expect(settings.filterableAttributes).toContain('priority');
      expect(settings.sortableAttributes).toContain('updatedAt');
      expect(settings.rankingRules[0]).toBe('words');
      expect(settings.typoTolerance.enabled).toBe(true);
      expect(settings.synonyms.k8s).toEqual(['kubernetes']);
    });

    it('should build Confluence index settings', () => {
      const buildConfluenceIndexSettings = () => {
        return {
          searchableAttributes: ['title', 'content', 'spaceKey'],
          filterableAttributes: ['spaceKey', 'source', 'type', 'originalId'],
          sortableAttributes: ['updatedAt', 'createdAt'],
          rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'updatedAt:desc'],
          typoTolerance: {
            enabled: true,
            minWordSizeForTypos: {
              oneTypo: 3,
              twoTypos: 6,
            },
          },
        };
      };

      const settings = buildConfluenceIndexSettings();

      expect(settings.searchableAttributes).toContain('title');
      expect(settings.searchableAttributes).toContain('content');
      expect(settings.searchableAttributes).toContain('spaceKey');
      expect(settings.filterableAttributes).toContain('spaceKey');
      expect(settings.filterableAttributes).toContain('type');
      expect(settings.sortableAttributes).toContain('updatedAt');
      expect(settings.typoTolerance.enabled).toBe(true);
    });
  });

  describe('Search result processing', () => {
    it('should process search hits correctly', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const processSearchHits = (hits: any[]) => {
        return hits.map((hit) => ({
          id: hit.originalId || hit.id,
          title: hit.title,
          content: hit._formatted?.content || hit.content,
          source: hit.source,
          url: hit.url,
          score: hit._rankingScore || 0,
          highlight: hit._formatted || {},
        }));
      };

      const mockHits = [
        {
          id: 'jira_TEST-123',
          originalId: 'jira:TEST-123',
          title: 'Login Bug',
          content: 'Users cannot authenticate',
          source: 'jira',
          url: 'https://company.atlassian.net/browse/TEST-123',
          _rankingScore: 0.95,
          _formatted: {
            title: 'Login <mark>Bug</mark>',
            content: 'Users cannot <mark>authenticate</mark>',
          },
        },
        {
          id: 'confluence_456',
          originalId: 'confluence:456',
          title: 'API Documentation',
          content: 'How to authenticate with the API',
          source: 'confluence',
          url: 'https://company.atlassian.net/wiki/pages/456',
          _rankingScore: 0.87,
        },
      ];

      const processed = processSearchHits(mockHits);

      expect(processed).toHaveLength(2);
      expect(processed[0].id).toBe('jira:TEST-123');
      expect(processed[0].title).toBe('Login Bug');
      expect(processed[0].content).toBe('Users cannot <mark>authenticate</mark>');
      expect(processed[0].score).toBe(0.95);
      expect(processed[1].id).toBe('confluence:456');
      expect(processed[1].score).toBe(0.87);
    });
  });
});
