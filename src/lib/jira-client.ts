import { z } from 'zod';
import type { Config } from './config.js';

const IssueSchema = z.object({
  key: z.string(),
  self: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.any().nullable(),
    status: z.object({
      name: z.string(),
    }),
    assignee: z.object({
      displayName: z.string(),
      emailAddress: z.string().email().optional(),
    }).nullable(),
    reporter: z.object({
      displayName: z.string(),
      emailAddress: z.string().email().optional(),
    }),
    priority: z.object({
      name: z.string(),
    }).nullable(),
    created: z.string(),
    updated: z.string(),
  }),
});

const SearchResultSchema = z.object({
  issues: z.array(IssueSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

export type Issue = z.infer<typeof IssueSchema>;

export class JiraClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async getIssue(issueKey: string): Promise<Issue> {
    const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch issue: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return IssueSchema.parse(data);
  }

  async searchIssues(jql: string, options?: {
    startAt?: number;
    maxResults?: number;
    fields?: string[];
  }): Promise<{ issues: Issue[]; total: number; startAt: number }> {
    const params = new URLSearchParams({
      jql,
      startAt: (options?.startAt || 0).toString(),
      maxResults: (options?.maxResults || 50).toString(),
    });

    if (options?.fields) {
      params.append('fields', options.fields.join(','));
    }

    const url = `${this.config.jiraUrl}/rest/api/3/search?${params}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to search issues: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const result = SearchResultSchema.parse(data);
    
    return {
      issues: result.issues,
      total: result.total,
      startAt: result.startAt,
    };
  }

  async getAllProjectIssues(projectKey: string, onProgress?: (current: number, total: number) => void, jql?: string): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let startAt = 0;
    const maxResults = 100; // Max allowed by Jira API
    let total = 0;

    // Use provided JQL or default to all project issues
    const searchJql = jql || `project = ${projectKey} ORDER BY updated DESC`;

    while (true) {
      const result = await this.searchIssues(searchJql, {
        startAt,
        maxResults,
      });

      allIssues.push(...result.issues);
      total = result.total;

      if (onProgress) {
        onProgress(allIssues.length, total);
      }

      // Check if we've fetched all issues
      if (allIssues.length >= total || result.issues.length === 0) {
        break;
      }

      startAt += maxResults;
    }

    return allIssues;
  }
}