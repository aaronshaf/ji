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

  async getAllSpacePages(spaceKey: string, onProgress?: (current: number, total: number) => void): Promise<Page[]> {
    const allPages: Page[] = [];
    let start = 0;
    const limit = 100; // Max allowed by API
    let total = 0;

    while (true) {
      const response = await this.getSpaceContent(spaceKey, {
        start,
        limit,
        expand: ['body.storage', 'version', 'space'],
      });

      allPages.push(...response.results);
      
      if (response.size > 0) {
        total = start + response.size;
      }
      
      if (onProgress) {
        onProgress(allPages.length, total);
      }

      // Check if there are more pages
      if (!response._links?.next || response.results.length === 0) {
        break;
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