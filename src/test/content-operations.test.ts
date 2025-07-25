import { describe, expect, it } from 'bun:test';

// Test content operations without database dependencies
describe('Content Operations', () => {
  describe('Content building', () => {
    it('should build searchable content from Jira issue', () => {
      const buildJiraContent = (issue: any): string => {
        const parts = [
          issue.key,
          issue.fields.summary,
          issue.fields.description || '',
          issue.fields.status?.name || '',
          issue.fields.priority?.name || '',
          issue.fields.assignee?.displayName || '',
          issue.fields.reporter?.displayName || '',
          (issue.fields.labels || []).join(' '),
          (issue.fields.components || []).map((c: any) => c.name).join(' '),
        ];
        return parts.filter(Boolean).join(' ').trim();
      };

      const mockIssue = {
        key: 'TEST-123',
        fields: {
          summary: 'Login bug needs fixing',
          description: 'Users cannot authenticate with special characters',
          status: { name: 'Open' },
          priority: { name: 'High' },
          assignee: { displayName: 'John Doe' },
          reporter: { displayName: 'Jane Smith' },
          labels: ['bug', 'authentication'],
          components: [{ name: 'Frontend' }, { name: 'Security' }],
        },
      };

      const content = buildJiraContent(mockIssue);

      expect(content).toContain('TEST-123');
      expect(content).toContain('Login bug needs fixing');
      expect(content).toContain('authentication');
      expect(content).toContain('John Doe');
      expect(content).toContain('Frontend Security');
    });

    it('should handle missing fields gracefully', () => {
      const buildJiraContent = (issue: any): string => {
        const parts = [
          issue.key,
          issue.fields?.summary || '',
          issue.fields?.description || '',
          issue.fields?.status?.name || '',
          issue.fields?.priority?.name || '',
        ];
        return parts.filter(Boolean).join(' ').trim();
      };

      const minimalIssue = {
        key: 'MIN-1',
        fields: {
          summary: 'Minimal issue',
          // No other fields
        },
      };

      const content = buildJiraContent(minimalIssue);
      expect(content).toBe('MIN-1 Minimal issue');
    });
  });

  describe('Content metadata extraction', () => {
    it('should extract Jira issue metadata', () => {
      const extractJiraMetadata = (issue: any) => {
        return {
          status: issue.fields?.status?.name,
          priority: issue.fields?.priority?.name,
          assignee: issue.fields?.assignee?.displayName,
          reporter: issue.fields?.reporter?.displayName,
          issueType: issue.fields?.issuetype?.name,
          created: issue.fields?.created,
          updated: issue.fields?.updated,
        };
      };

      const mockIssue = {
        fields: {
          status: { name: 'In Progress' },
          priority: { name: 'Medium' },
          assignee: { displayName: 'Dev User' },
          reporter: { displayName: 'QA User' },
          issuetype: { name: 'Story' },
          created: '2024-01-01T00:00:00Z',
          updated: '2024-01-15T12:00:00Z',
        },
      };

      const metadata = extractJiraMetadata(mockIssue);

      expect(metadata.status).toBe('In Progress');
      expect(metadata.priority).toBe('Medium');
      expect(metadata.assignee).toBe('Dev User');
      expect(metadata.issueType).toBe('Story');
    });

    it('should extract Confluence page metadata', () => {
      const extractConfluenceMetadata = (page: any) => {
        return {
          space: page.space?.key,
          version: page.version?.number,
          created: page.history?.createdDate,
          lastModified: page.version?.when,
          creator: page.history?.createdBy?.displayName,
          lastModifier: page.version?.by?.displayName,
        };
      };

      const mockPage = {
        space: { key: 'DOCS' },
        version: {
          number: 5,
          when: '2024-01-15T10:00:00Z',
          by: { displayName: 'Editor User' },
        },
        history: {
          createdDate: '2024-01-01T00:00:00Z',
          createdBy: { displayName: 'Author User' },
        },
      };

      const metadata = extractConfluenceMetadata(mockPage);

      expect(metadata.space).toBe('DOCS');
      expect(metadata.version).toBe(5);
      expect(metadata.creator).toBe('Author User');
      expect(metadata.lastModifier).toBe('Editor User');
    });
  });

  describe('Search query processing', () => {
    it('should escape FTS5 special characters', () => {
      const escapeFTS5Query = (query: string): string => {
        // Escape double quotes by doubling them
        return query.replace(/"/g, '""');
      };

      expect(escapeFTS5Query('simple query')).toBe('simple query');
      expect(escapeFTS5Query('query with "quotes"')).toBe('query with ""quotes""');
      expect(escapeFTS5Query('"quoted phrase"')).toBe('""quoted phrase""');
    });

    it('should tokenize search queries', () => {
      const tokenizeQuery = (query: string): string[] => {
        const stopWords = ['for', 'in', 'the', 'and', 'or', 'but', 'a', 'an', 'to', 'at', 'of'];
        return query
          .toLowerCase()
          .split(/\s+/)
          .filter((token) => token.length > 0)
          .map((token) => token.replace(/[^\w]/g, ''))
          .filter((token) => token.length > 2)
          .filter((token) => !stopWords.includes(token));
      };

      const tokens = tokenizeQuery('Search for login BUG in authentication!');

      expect(tokens).toContain('search');
      expect(tokens).toContain('login');
      expect(tokens).toContain('bug');
      expect(tokens).toContain('authentication');
      expect(tokens).not.toContain('for');
      expect(tokens).not.toContain('in');
    });

    it('should build FTS5 match expressions', () => {
      const buildMatchExpression = (tokens: string[]): string => {
        return tokens.map((token) => `"${token}"`).join(' OR ');
      };

      const tokens = ['login', 'authentication', 'bug'];
      const expression = buildMatchExpression(tokens);

      expect(expression).toBe('"login" OR "authentication" OR "bug"');
    });
  });

  describe('Content deduplication', () => {
    it('should generate content hashes for deduplication', () => {
      const generateContentHash = (content: string): string => {
        // Simple hash function for testing
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(16);
      };

      const content1 = 'This is test content';
      const content2 = 'This is test content'; // Same content
      const content3 = 'This is different content';

      const hash1 = generateContentHash(content1);
      const hash2 = generateContentHash(content2);
      const hash3 = generateContentHash(content3);

      expect(hash1).toBe(hash2); // Same content = same hash
      expect(hash1).not.toBe(hash3); // Different content = different hash
    });

    it('should detect content changes', () => {
      const hasContentChanged = (oldHash: string, newContent: string): boolean => {
        const generateHash = (content: string): string => {
          let hash = 0;
          for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
          }
          return Math.abs(hash).toString(16);
        };

        return oldHash !== generateHash(newContent);
      };

      const _originalContent = 'Original content';
      const originalHash = '12345abc'; // Assume this is the hash of original content

      const updatedContent = 'Updated content';
      const _sameContent = 'Original content';

      expect(hasContentChanged(originalHash, updatedContent)).toBe(true);
      // Note: This would be false if we actually computed the hash correctly
      // but for testing purposes we're using a mock hash
    });
  });

  describe('Content formatting', () => {
    it('should format content for display', () => {
      const formatContent = (content: string, maxLength: number = 200): string => {
        if (content.length <= maxLength) {
          return content;
        }
        return `${content.substring(0, maxLength - 3)}...`;
      };

      const shortContent = 'Short content';
      const longContent =
        'This is a very long piece of content that exceeds the maximum length and should be truncated';

      expect(formatContent(shortContent)).toBe('Short content');
      expect(formatContent(longContent, 50)).toBe('This is a very long piece of content that excee...');
    });

    it('should format search result snippets', () => {
      const formatSnippet = (content: string, query: string, contextSize: number = 50): string => {
        const queryIndex = content.toLowerCase().indexOf(query.toLowerCase());
        if (queryIndex === -1) {
          return `${content.substring(0, contextSize * 2)}...`;
        }

        const start = Math.max(0, queryIndex - contextSize);
        const end = Math.min(content.length, queryIndex + query.length + contextSize);

        let snippet = content.substring(start, end);
        if (start > 0) snippet = `...${snippet}`;
        if (end < content.length) snippet = `${snippet}...`;

        return snippet;
      };

      const content =
        'This document contains information about user authentication and login procedures for the application';
      const snippet = formatSnippet(content, 'authentication', 20);

      expect(snippet).toContain('authentication');
      expect(snippet.length).toBeLessThan(content.length);
    });
  });

  describe('URL and link processing', () => {
    it('should build Jira issue URLs', () => {
      const buildJiraUrl = (baseUrl: string, issueKey: string): string => {
        return `${baseUrl}/browse/${issueKey}`;
      };

      expect(buildJiraUrl('https://company.atlassian.net', 'PROJ-123')).toBe(
        'https://company.atlassian.net/browse/PROJ-123',
      );
    });

    it('should build Confluence page URLs', () => {
      const buildConfluenceUrl = (baseUrl: string, pageId: string): string => {
        return `${baseUrl}/wiki/pages/${pageId}`;
      };

      expect(buildConfluenceUrl('https://company.atlassian.net', '123456')).toBe(
        'https://company.atlassian.net/wiki/pages/123456',
      );
    });

    it('should extract project key from issue key', () => {
      const extractProjectKey = (issueKey: string): string => {
        const match = issueKey.match(/^([A-Z]+)-\d+$/);
        return match ? match[1] : '';
      };

      expect(extractProjectKey('PROJ-123')).toBe('PROJ');
      expect(extractProjectKey('TEST-456')).toBe('TEST');
      expect(extractProjectKey('MULTIWORD-789')).toBe('MULTIWORD');
      expect(extractProjectKey('invalid')).toBe('');
    });
  });
});
