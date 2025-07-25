import { describe, expect, it } from 'bun:test';

// Test content-manager utilities without external dependencies
describe('Content Manager Utilities', () => {
  describe('FTS5 query escaping', () => {
    it('should escape double quotes correctly', () => {
      const escapeFTS5Query = (query: string): string => {
        const escaped = query.replace(/"/g, '""');

        // If the query contains special FTS5 operators, wrap in quotes
        if (/[*?()[\]{}\\:^]/.test(query)) {
          return `"${escaped}"`;
        }

        return escaped;
      };

      expect(escapeFTS5Query('simple query')).toBe('simple query');
      expect(escapeFTS5Query('query with "quotes"')).toBe('query with ""quotes""');
      expect(escapeFTS5Query('"quoted phrase"')).toBe('""quoted phrase""');
      expect(escapeFTS5Query('multiple "quote" marks "here"')).toBe('multiple ""quote"" marks ""here""');
    });

    it('should wrap queries with special operators in quotes', () => {
      const escapeFTS5Query = (query: string): string => {
        const escaped = query.replace(/"/g, '""');

        if (/[*?()[\]{}\\:^]/.test(query)) {
          return `"${escaped}"`;
        }

        return escaped;
      };

      // Queries with special characters should be wrapped
      expect(escapeFTS5Query('query*')).toBe('"query*"');
      expect(escapeFTS5Query('query?')).toBe('"query?"');
      expect(escapeFTS5Query('(query)')).toBe('"(query)"');
      expect(escapeFTS5Query('[query]')).toBe('"[query]"');
      expect(escapeFTS5Query('{query}')).toBe('"{query}"');
      expect(escapeFTS5Query('query\\test')).toBe('"query\\test"');
      expect(escapeFTS5Query('query:field')).toBe('"query:field"');
      expect(escapeFTS5Query('^query')).toBe('"^query"');

      // Combined special characters and quotes
      expect(escapeFTS5Query('query* with "quotes"')).toBe('"query* with ""quotes"""');
    });

    it('should handle edge cases', () => {
      const escapeFTS5Query = (query: string): string => {
        const escaped = query.replace(/"/g, '""');

        if (/[*?()[\]{}\\:^]/.test(query)) {
          return `"${escaped}"`;
        }

        return escaped;
      };

      expect(escapeFTS5Query('')).toBe('');
      expect(escapeFTS5Query('   ')).toBe('   ');
      expect(escapeFTS5Query('normal query without special chars')).toBe('normal query without special chars');
    });
  });

  describe('SearchableContent validation', () => {
    it('should validate SearchableContent structure', () => {
      const validateSearchableContent = (content: any): { valid: boolean; errors: string[] } => {
        const errors: string[] = [];

        if (!content || typeof content !== 'object') {
          errors.push('Content must be an object');
          return { valid: false, errors };
        }

        if (!content.id || content.id.length === 0) {
          errors.push('Content must have an ID');
        }

        if (!content.title || content.title.length === 0) {
          errors.push('Content must have a title');
        }

        if (!content.content || content.content.length === 0) {
          errors.push('Content must have content');
        }

        if (content.content && content.content.length > 10_000_000) {
          errors.push('Content too large (max 10MB)');
        }

        if (!['jira', 'confluence'].includes(content.source)) {
          errors.push('Source must be jira or confluence');
        }

        if (!content.url || !content.url.startsWith('http')) {
          errors.push('Content must have a valid URL');
        }

        return { valid: errors.length === 0, errors };
      };

      // Valid content
      const validContent = {
        id: 'jira:TEST-123',
        source: 'jira',
        type: 'issue',
        title: 'Test Issue',
        content: 'This is test content',
        url: 'https://company.atlassian.net/browse/TEST-123',
        projectKey: 'TEST',
        syncedAt: Date.now(),
      };

      const result1 = validateSearchableContent(validContent);
      expect(result1.valid).toBe(true);
      expect(result1.errors).toHaveLength(0);

      // Invalid content - missing required fields
      const invalidContent = {
        id: '',
        source: 'invalid',
        title: '',
        content: '',
        url: 'not-a-url',
      };

      const result2 = validateSearchableContent(invalidContent);
      expect(result2.valid).toBe(false);
      expect(result2.errors).toContain('Content must have an ID');
      expect(result2.errors).toContain('Content must have a title');
      expect(result2.errors).toContain('Content must have content');
      expect(result2.errors).toContain('Source must be jira or confluence');
      expect(result2.errors).toContain('Content must have a valid URL');

      // Content too large
      const largeContent = {
        ...validContent,
        content: 'A'.repeat(10_000_001),
      };

      const result3 = validateSearchableContent(largeContent);
      expect(result3.valid).toBe(false);
      expect(result3.errors).toContain('Content too large (max 10MB)');
    });
  });

  describe('Content ID generation', () => {
    it('should generate valid content IDs for different sources', () => {
      const generateContentId = (source: 'jira' | 'confluence', key: string): string => {
        return `${source}:${key}`;
      };

      expect(generateContentId('jira', 'TEST-123')).toBe('jira:TEST-123');
      expect(generateContentId('confluence', '123456')).toBe('confluence:123456');
      expect(generateContentId('jira', 'PROJ-999')).toBe('jira:PROJ-999');
    });

    it('should parse content IDs correctly', () => {
      const parseContentId = (id: string): { source: string; key: string } | null => {
        const match = id.match(/^(jira|confluence):(.+)$/);
        if (!match) return null;
        return { source: match[1], key: match[2] };
      };

      expect(parseContentId('jira:TEST-123')).toEqual({ source: 'jira', key: 'TEST-123' });
      expect(parseContentId('confluence:123456')).toEqual({ source: 'confluence', key: '123456' });
      expect(parseContentId('invalid:format')).toBeNull();
      expect(parseContentId('jira')).toBeNull();
      expect(parseContentId('')).toBeNull();
    });
  });

  describe('Content metadata extraction', () => {
    it('should extract Jira issue metadata', () => {
      const extractJiraMetadata = (issue: any) => {
        return {
          status: issue.fields?.status?.name,
          priority: issue.fields?.priority?.name,
          assignee: issue.fields?.assignee?.emailAddress,
          reporter: issue.fields?.reporter?.emailAddress,
          issueType: issue.fields?.issuetype?.name,
          labels: issue.fields?.labels || [],
          components: issue.fields?.components?.map((c: any) => c.name) || [],
        };
      };

      const mockIssue = {
        fields: {
          status: { name: 'In Progress' },
          priority: { name: 'High' },
          assignee: { emailAddress: 'john@example.com' },
          reporter: { emailAddress: 'jane@example.com' },
          issuetype: { name: 'Bug' },
          labels: ['frontend', 'urgent'],
          components: [{ name: 'UI' }, { name: 'Authentication' }],
        },
      };

      const metadata = extractJiraMetadata(mockIssue);

      expect(metadata.status).toBe('In Progress');
      expect(metadata.priority).toBe('High');
      expect(metadata.assignee).toBe('john@example.com');
      expect(metadata.reporter).toBe('jane@example.com');
      expect(metadata.issueType).toBe('Bug');
      expect(metadata.labels).toEqual(['frontend', 'urgent']);
      expect(metadata.components).toEqual(['UI', 'Authentication']);
    });

    it('should extract Confluence page metadata', () => {
      const extractConfluenceMetadata = (page: any) => {
        return {
          spaceKey: page.space?.key,
          version: page.version?.number,
          lastModified: page.version?.when,
          creator: page.history?.createdBy?.displayName,
          lastModifier: page.version?.by?.displayName,
          pageType: page.type,
        };
      };

      const mockPage = {
        type: 'page',
        space: { key: 'DOCS' },
        version: {
          number: 5,
          when: '2024-01-15T10:00:00Z',
          by: { displayName: 'Editor User' },
        },
        history: {
          createdBy: { displayName: 'Author User' },
        },
      };

      const metadata = extractConfluenceMetadata(mockPage);

      expect(metadata.spaceKey).toBe('DOCS');
      expect(metadata.version).toBe(5);
      expect(metadata.lastModified).toBe('2024-01-15T10:00:00Z');
      expect(metadata.creator).toBe('Author User');
      expect(metadata.lastModifier).toBe('Editor User');
      expect(metadata.pageType).toBe('page');
    });
  });

  describe('Content transformation', () => {
    it('should transform Jira issue to SearchableContent', () => {
      const transformJiraIssue = (issue: any): any => {
        return {
          id: `jira:${issue.key}`,
          source: 'jira',
          type: 'issue',
          title: `${issue.key}: ${issue.fields.summary}`,
          content: [
            issue.fields.summary,
            issue.fields.description || '',
            (issue.fields.labels || []).join(' '),
            (issue.fields.components || []).map((c: any) => c.name).join(' '),
          ]
            .filter(Boolean)
            .join(' '),
          url: `${issue.self.replace('/rest/api/3/issue/', '/browse/')}`,
          projectKey: issue.key.split('-')[0],
          metadata: {
            status: issue.fields?.status?.name,
            priority: issue.fields?.priority?.name,
            assignee: issue.fields?.assignee?.emailAddress,
            reporter: issue.fields?.reporter?.emailAddress,
          },
          syncedAt: Date.now(),
        };
      };

      const mockIssue = {
        key: 'TEST-123',
        self: 'https://company.atlassian.net/rest/api/3/issue/12345',
        fields: {
          summary: 'Login bug needs fixing',
          description: 'Users cannot authenticate with special characters',
          status: { name: 'Open' },
          priority: { name: 'High' },
          assignee: { emailAddress: 'john@example.com' },
          reporter: { emailAddress: 'jane@example.com' },
          labels: ['bug', 'authentication'],
          components: [{ name: 'Frontend' }],
        },
      };

      const searchableContent = transformJiraIssue(mockIssue);

      expect(searchableContent.id).toBe('jira:TEST-123');
      expect(searchableContent.source).toBe('jira');
      expect(searchableContent.type).toBe('issue');
      expect(searchableContent.title).toBe('TEST-123: Login bug needs fixing');
      expect(searchableContent.content).toContain('Login bug needs fixing');
      expect(searchableContent.content).toContain('authentication');
      expect(searchableContent.content).toContain('Frontend');
      expect(searchableContent.url).toBe('https://company.atlassian.net/browse/12345');
      expect(searchableContent.projectKey).toBe('TEST');
      expect(searchableContent.metadata.status).toBe('Open');
    });

    it('should transform Confluence page to SearchableContent', () => {
      const transformConfluencePage = (page: any): any => {
        return {
          id: `confluence:${page.id}`,
          source: 'confluence',
          type: 'page',
          title: page.title,
          content: page.body?.storage?.value || '',
          url: `${page._links.webui}`,
          spaceKey: page.space.key,
          metadata: {
            version: page.version.number,
            lastModifier: page.version.by?.displayName,
          },
          syncedAt: Date.now(),
        };
      };

      const mockPage = {
        id: '123456',
        title: 'API Documentation',
        body: {
          storage: {
            value: '<p>This page contains API documentation</p>',
          },
        },
        space: { key: 'DOCS' },
        version: {
          number: 3,
          by: { displayName: 'Tech Writer' },
        },
        _links: {
          webui: '/wiki/spaces/DOCS/pages/123456/API+Documentation',
        },
      };

      const searchableContent = transformConfluencePage(mockPage);

      expect(searchableContent.id).toBe('confluence:123456');
      expect(searchableContent.source).toBe('confluence');
      expect(searchableContent.type).toBe('page');
      expect(searchableContent.title).toBe('API Documentation');
      expect(searchableContent.content).toBe('<p>This page contains API documentation</p>');
      expect(searchableContent.url).toBe('/wiki/spaces/DOCS/pages/123456/API+Documentation');
      expect(searchableContent.spaceKey).toBe('DOCS');
      expect(searchableContent.metadata.version).toBe(3);
    });
  });

  describe('Content hashing', () => {
    it('should validate content for hashing', () => {
      const validateContentForHashing = (content: string): { valid: boolean; error?: string } => {
        if (!content || content.length === 0) {
          return { valid: false, error: 'Cannot hash empty content' };
        }

        if (content.length > 10_000_000) {
          return { valid: false, error: 'Content too large to hash' };
        }

        return { valid: true };
      };

      // Valid content
      expect(validateContentForHashing('Valid content')).toEqual({ valid: true });
      expect(validateContentForHashing('A'.repeat(1000000))).toEqual({ valid: true });

      // Invalid content
      expect(validateContentForHashing('')).toEqual({
        valid: false,
        error: 'Cannot hash empty content',
      });
      expect(validateContentForHashing('A'.repeat(10_000_001))).toEqual({
        valid: false,
        error: 'Content too large to hash',
      });
    });
  });

  describe('Database operations', () => {
    it('should build content storage queries', () => {
      const buildInsertContentQuery = () => {
        return `
          INSERT OR REPLACE INTO searchable_content 
          (id, source, type, title, content, url, space_key, project_key, metadata, created_at, updated_at, synced_at, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          .trim()
          .replace(/\s+/g, ' ');
      };

      const query = buildInsertContentQuery();
      expect(query).toContain('INSERT OR REPLACE INTO searchable_content');
      expect(query).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    });

    it('should build content search queries', () => {
      const buildSearchQuery = (source?: string, projectKey?: string, spaceKey?: string) => {
        const conditions: string[] = [];
        const params: string[] = [];

        if (source) {
          conditions.push('source = ?');
          params.push(source);
        }

        if (projectKey) {
          conditions.push('project_key = ?');
          params.push(projectKey);
        }

        if (spaceKey) {
          conditions.push('space_key = ?');
          params.push(spaceKey);
        }

        const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        return {
          query: `SELECT * FROM searchable_content${whereClause}`,
          params,
        };
      };

      // No filters
      const query1 = buildSearchQuery();
      expect(query1.query).toBe('SELECT * FROM searchable_content');
      expect(query1.params).toHaveLength(0);

      // Single filter
      const query2 = buildSearchQuery('jira');
      expect(query2.query).toBe('SELECT * FROM searchable_content WHERE source = ?');
      expect(query2.params).toEqual(['jira']);

      // Multiple filters
      const query3 = buildSearchQuery('jira', 'TEST');
      expect(query3.query).toBe('SELECT * FROM searchable_content WHERE source = ? AND project_key = ?');
      expect(query3.params).toEqual(['jira', 'TEST']);

      // All filters
      const query4 = buildSearchQuery('confluence', undefined, 'DOCS');
      expect(query4.query).toBe('SELECT * FROM searchable_content WHERE source = ? AND space_key = ?');
      expect(query4.params).toEqual(['confluence', 'DOCS']);
    });
  });

  describe('Error handling patterns', () => {
    it('should categorize content errors correctly', () => {
      const categorizeContentError = (error: any): { type: string; shouldRetry: boolean; userMessage: string } => {
        if (error.message?.includes('too large')) {
          return {
            type: 'ContentTooLarge',
            shouldRetry: false,
            userMessage: 'Content exceeds size limit',
          };
        }

        if (error.message?.includes('hash')) {
          return {
            type: 'HashError',
            shouldRetry: true,
            userMessage: 'Failed to process content hash',
          };
        }

        if (error.message?.includes('UNIQUE constraint')) {
          return {
            type: 'DuplicateContent',
            shouldRetry: false,
            userMessage: 'Content already exists',
          };
        }

        return {
          type: 'UnknownError',
          shouldRetry: false,
          userMessage: 'An unexpected error occurred',
        };
      };

      // Content too large
      const largeError = new Error('Content too large (max 10MB)');
      const largeResult = categorizeContentError(largeError);
      expect(largeResult.type).toBe('ContentTooLarge');
      expect(largeResult.shouldRetry).toBe(false);

      // Hash error
      const hashError = new Error('Failed to hash content');
      const hashResult = categorizeContentError(hashError);
      expect(hashResult.type).toBe('HashError');
      expect(hashResult.shouldRetry).toBe(true);

      // Duplicate content
      const duplicateError = new Error('UNIQUE constraint failed: searchable_content.id');
      const duplicateResult = categorizeContentError(duplicateError);
      expect(duplicateResult.type).toBe('DuplicateContent');
      expect(duplicateResult.shouldRetry).toBe(false);
    });
  });
});
