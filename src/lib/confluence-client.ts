import { z } from 'zod';
import type { Config } from './config.js';

// Confluence API schemas
const PageSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  space: z.object({
    key: z.string(),
    name: z.string(),
  }),
  version: z.object({
    number: z.number(),
    when: z.string(),
  }),
  body: z.object({
    storage: z.object({
      value: z.string(),
      representation: z.literal('storage'),
    }).optional(),
    view: z.object({
      value: z.string(),
      representation: z.literal('view'),
    }).optional(),
  }).optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
  }),
});

// Schema for search API results - Confluence search API wraps results in 'content'
const SearchResultSchema = z.object({
  content: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    version: z.object({
      number: z.number(),
      when: z.string(),
      by: z.object({
        displayName: z.string(),
      }).optional(),
    }).optional(), // Make version optional for now to debug
    _links: z.object({
      webui: z.string(),
    }),
  }),
});

const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  totalSize: z.number().optional(),
  _links: z.object({
    next: z.string().optional(),
  }).optional(),
});

const SpaceSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
  }),
});

const PageListResponseSchema = z.object({
  results: z.array(PageSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  _links: z.object({
    next: z.string().optional(),
  }).optional(),
});

export type Page = z.infer<typeof PageSchema>;
export type Space = z.infer<typeof SpaceSchema>;

export class ConfluenceClient {
  private config: Config;
  private baseUrl: string;

  constructor(config: Config) {
    this.config = config;
    // Confluence uses the same base URL as Jira
    this.baseUrl = `${config.jiraUrl}/wiki/rest/api`;
  }

  private getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async getSpace(spaceKey: string): Promise<Space> {
    const url = `${this.baseUrl}/space/${spaceKey}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch space: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return SpaceSchema.parse(data);
  }

  async getSpaceContent(spaceKey: string, options?: {
    start?: number;
    limit?: number;
    expand?: string[];
  }): Promise<z.infer<typeof PageListResponseSchema>> {
    const params = new URLSearchParams({
      start: (options?.start || 0).toString(),
      limit: (options?.limit || 25).toString(),
      expand: options?.expand?.join(',') || 'body.storage,version,space',
    });

    const url = `${this.baseUrl}/space/${spaceKey}/content/page?${params}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch space content: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return PageListResponseSchema.parse(data);
  }

  async getPagesSince(
    spaceKey: string,
    sinceDate: Date,
    onProgress?: (current: number) => void
  ): Promise<{ id: string; title: string; version: { number: number; when: string } }[]> {
    // Unfortunately, the Confluence search API doesn't return version info
    // So we'll fall back to getting all pages with the regular method
    // This is still more efficient than before because we track last sync time
    
    // For now, just use the regular getSpacePagesLightweight method
    // which does return version information
    return this.getSpacePagesLightweight(spaceKey, onProgress);
  }

  async getRecentlyUpdatedPages(
    spaceKey: string,
    limit: number = 10
  ): Promise<{ id: string; title: string; version: { number: number; when: string; by: { displayName: string } }; webUrl: string }[]> {
    // Use CQL to search for recently modified pages in the space
    const cql = `space="${spaceKey}" and type=page order by lastmodified desc`;
    const url = `${this.baseUrl}/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=version`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to search pages: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const parsedData = SearchResponseSchema.parse(data);
    
    return parsedData.results.map((result) => {
      // The search API doesn't always return version info
      // Use lastModified from the search result instead
      const searchResult = result as any; // Access the full result object
      return {
        id: result.content.id,
        title: result.content.title,
        version: {
          number: result.content.version?.number || 0,
          when: result.content.version?.when || searchResult.lastModified || new Date().toISOString(),
          by: {
            displayName: result.content.version?.by?.displayName || 'Unknown'
          }
        },
        webUrl: result.content._links.webui
      };
    });
  }

  async getSpacePagesLightweight(
    spaceKey: string,
    onProgress?: (current: number) => void
  ): Promise<{ id: string; title: string; version: { number: number; when: string }; }[]> {
    const allPages: { id: string; title: string; version: { number: number; when: string }; }[] = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['version', 'space'] // Get version and space info, no body content
      });

      const lightweightPages = response.results.map(page => ({
        id: page.id,
        title: page.title,
        version: page.version
      }));

      allPages.push(...lightweightPages);
      
      // Report progress
      if (onProgress) {
        onProgress(allPages.length);
      }

      if (response.results.length < limit) {
        break;
      }

      start += limit;
    }

    return allPages;
  }

  async getAllSpacePages(spaceKey: string, onProgress?: (current: number, total: number) => void): Promise<Page[]> {
    const allPages: Page[] = [];
    let start = 0;
    const limit = 100; // Max allowed by API
    let hasMore = true;
    let estimatedTotal = 0;

    while (hasMore) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['body.storage', 'version', 'space'],
      });

      allPages.push(...response.results);
      
      // The API doesn't give us a total count, so we estimate based on whether there are more pages
      // If we got a full page of results, there are likely more pages
      if (response.results.length === limit) {
        // Estimate there's at least one more full page
        estimatedTotal = allPages.length + limit;
      } else {
        // This is the last page, we know the exact total
        estimatedTotal = allPages.length;
        hasMore = false;
      }
      
      if (onProgress) {
        onProgress(allPages.length, estimatedTotal);
      }

      // Check if there are more pages
      if (!response._links?.next || response.results.length === 0) {
        hasMore = false;
      }

      start += limit;
    }

    return allPages;
  }

  async getPage(pageId: string): Promise<Page> {
    const url = `${this.baseUrl}/content/${pageId}?expand=body.storage,body.view,version,space`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch page: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return PageSchema.parse(data);
  }

  async getChildPages(pageId: string): Promise<Page[]> {
    const url = `${this.baseUrl}/content/${pageId}/child/page?expand=body.storage,version,space`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch child pages: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const parsed = PageListResponseSchema.parse(data);
    return parsed.results;
  }
}