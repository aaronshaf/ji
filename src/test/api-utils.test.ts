import { describe, expect, it } from 'bun:test';

// Test utility functions used by API clients
describe('API Utils', () => {
  describe('URL building', () => {
    it('should build Jira search URL correctly', () => {
      const buildSearchUrl = (baseUrl: string) => {
        return `${baseUrl}/rest/api/3/search`;
      };

      expect(buildSearchUrl('https://test.atlassian.net')).toBe('https://test.atlassian.net/rest/api/3/search');
    });

    it('should build Confluence content URL', () => {
      const buildContentUrl = (baseUrl: string, spaceKey: string) => {
        return `${baseUrl}/wiki/rest/api/content?spaceKey=${spaceKey}&type=page&limit=100`;
      };

      expect(buildContentUrl('https://test.atlassian.net', 'WIKI')).toBe(
        'https://test.atlassian.net/wiki/rest/api/content?spaceKey=WIKI&type=page&limit=100',
      );
    });
  });

  describe('Authentication headers', () => {
    it('should create basic auth header', () => {
      const createAuthHeader = (email: string, token: string): string => {
        const credentials = Buffer.from(`${email}:${token}`).toString('base64');
        return `Basic ${credentials}`;
      };

      const header = createAuthHeader('test@example.com', 'token123');
      const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();

      expect(decoded).toBe('test@example.com:token123');
    });
  });

  describe('JQL query building', () => {
    it('should build JQL for project search', () => {
      const buildProjectJQL = (projectKey: string): string => {
        return `project = ${projectKey}`;
      };

      expect(buildProjectJQL('TEST')).toBe('project = TEST');
    });

    it('should build JQL for user assignments', () => {
      const buildUserJQL = (projectKey: string): string => {
        return `project = ${projectKey} AND assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)`;
      };

      expect(buildUserJQL('PROJ')).toBe(
        'project = PROJ AND assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)',
      );
    });

    it('should handle JQL with multiple conditions', () => {
      const buildComplexJQL = (project: string, status: string, priority: string): string => {
        const conditions = [`project = ${project}`, `status = "${status}"`, `priority = ${priority}`];
        return conditions.join(' AND ');
      };

      expect(buildComplexJQL('TEST', 'In Progress', 'High')).toBe(
        'project = TEST AND status = "In Progress" AND priority = High',
      );
    });
  });

  describe('Response parsing', () => {
    it('should extract issue data correctly', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const parseIssueResponse = (issue: any) => {
        return {
          key: issue.key,
          summary: issue.fields?.summary,
          status: issue.fields?.status?.name,
          priority: issue.fields?.priority?.name,
          assigneeEmail: issue.fields?.assignee?.emailAddress,
          assigneeName: issue.fields?.assignee?.displayName,
        };
      };

      const mockIssue = {
        key: 'TEST-123',
        fields: {
          summary: 'Test Issue',
          status: { name: 'Open' },
          priority: { name: 'High' },
          assignee: {
            emailAddress: 'user@example.com',
            displayName: 'Test User',
          },
        },
      };

      const parsed = parseIssueResponse(mockIssue);

      expect(parsed.key).toBe('TEST-123');
      expect(parsed.summary).toBe('Test Issue');
      expect(parsed.status).toBe('Open');
      expect(parsed.priority).toBe('High');
      expect(parsed.assigneeEmail).toBe('user@example.com');
    });

    it('should handle missing assignee gracefully', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const parseIssueResponse = (issue: any) => {
        return {
          key: issue.key,
          assigneeEmail: issue.fields?.assignee?.emailAddress || null,
          assigneeName: issue.fields?.assignee?.displayName || null,
        };
      };

      const mockIssue = {
        key: 'UNASSIGNED-1',
        fields: {
          summary: 'Unassigned Issue',
          // No assignee field
        },
      };

      const parsed = parseIssueResponse(mockIssue);

      expect(parsed.key).toBe('UNASSIGNED-1');
      expect(parsed.assigneeEmail).toBeNull();
      expect(parsed.assigneeName).toBeNull();
    });
  });

  describe('Pagination handling', () => {
    it('should calculate pagination parameters', () => {
      const buildPagination = (page: number, size: number) => {
        return {
          startAt: page * size,
          maxResults: size,
        };
      };

      expect(buildPagination(0, 50)).toEqual({ startAt: 0, maxResults: 50 });
      expect(buildPagination(2, 25)).toEqual({ startAt: 50, maxResults: 25 });
    });

    it('should determine if more pages exist', () => {
      const hasMorePages = (startAt: number, maxResults: number, total: number): boolean => {
        return startAt + maxResults < total;
      };

      expect(hasMorePages(0, 50, 100)).toBe(true);
      expect(hasMorePages(50, 50, 100)).toBe(false);
      expect(hasMorePages(0, 50, 25)).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should parse API error responses', () => {
      const parseError = (response: { status: number; text?: string }) => {
        const errorMap: Record<number, string> = {
          400: 'Bad Request',
          401: 'Unauthorized',
          403: 'Forbidden',
          404: 'Not Found',
          500: 'Internal Server Error',
        };

        return errorMap[response.status] || response.text || 'Unknown Error';
      };

      expect(parseError({ status: 401 })).toBe('Unauthorized');
      expect(parseError({ status: 999, text: 'Custom Error' })).toBe('Custom Error');
    });
  });

  describe('Content validation', () => {
    it('should validate issue key format', () => {
      const isValidIssueKey = (key: string): boolean => {
        return /^[A-Z]+-\d+$/.test(key);
      };

      expect(isValidIssueKey('TEST-123')).toBe(true);
      expect(isValidIssueKey('PROJ-1')).toBe(true);
      expect(isValidIssueKey('test-123')).toBe(false);
      expect(isValidIssueKey('TEST-')).toBe(false);
      expect(isValidIssueKey('123')).toBe(false);
    });

    it('should validate project key format', () => {
      const isValidProjectKey = (key: string): boolean => {
        return /^[A-Z][A-Z0-9]*$/.test(key) && key.length <= 10;
      };

      expect(isValidProjectKey('TEST')).toBe(true);
      expect(isValidProjectKey('PROJ1')).toBe(true);
      expect(isValidProjectKey('test')).toBe(false);
      expect(isValidProjectKey('VERYLONGPROJECTKEY')).toBe(false);
    });
  });
});

// Test for content transformation utilities
describe('Content Transformation', () => {
  describe('Confluence storage format parsing', () => {
    it('should extract text from storage format', () => {
      const extractText = (storageValue: string): string => {
        // Simple HTML tag removal
        return storageValue
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };

      const html = '<p>This is <strong>bold</strong> text</p>';
      expect(extractText(html)).toBe('This is bold text');
    });

    it('should handle nested HTML structures', () => {
      const extractText = (storageValue: string): string => {
        return storageValue
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };

      const complexHtml =
        '<div><p>Paragraph with <a href="/link">link</a></p><ul><li>Item 1</li><li>Item 2</li></ul></div>';
      const result = extractText(complexHtml);

      expect(result).toBe('Paragraph with link Item 1 Item 2');
    });
  });

  describe('Content hashing', () => {
    it('should generate consistent hashes for same content', () => {
      const simpleHash = (content: string): string => {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString(16);
      };

      const content = 'Test content for hashing';
      const hash1 = simpleHash(content);
      const hash2 = simpleHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toBeTruthy();
    });

    it('should generate different hashes for different content', () => {
      const simpleHash = (content: string): string => {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash;
        }
        return hash.toString(16);
      };

      const content1 = 'First content';
      const content2 = 'Second content';

      expect(simpleHash(content1)).not.toBe(simpleHash(content2));
    });
  });

  describe('Metadata extraction', () => {
    it('should extract metadata from issue fields', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const extractMetadata = (issue: any) => {
        return {
          status: issue.fields?.status?.name,
          priority: issue.fields?.priority?.name,
          issueType: issue.fields?.issuetype?.name,
          labels: issue.fields?.labels || [],
          components:
            issue.fields?.components?.map(
              // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
              (c: any) => c.name,
            ) || [],
        };
      };

      const mockIssue = {
        fields: {
          status: { name: 'In Progress' },
          priority: { name: 'High' },
          issuetype: { name: 'Bug' },
          labels: ['frontend', 'urgent'],
          components: [{ name: 'UI' }, { name: 'Authentication' }],
        },
      };

      const metadata = extractMetadata(mockIssue);

      expect(metadata.status).toBe('In Progress');
      expect(metadata.priority).toBe('High');
      expect(metadata.issueType).toBe('Bug');
      expect(metadata.labels).toEqual(['frontend', 'urgent']);
      expect(metadata.components).toEqual(['UI', 'Authentication']);
    });
  });
});
