import { z } from 'zod';
import type { Config } from './config.js';

const IssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.any().nullable(),
    status: z.object({
      name: z.string(),
    }),
    assignee: z.object({
      displayName: z.string(),
      emailAddress: z.string().email(),
    }).nullable(),
    reporter: z.object({
      displayName: z.string(),
      emailAddress: z.string().email(),
    }),
    priority: z.object({
      name: z.string(),
    }).nullable(),
    created: z.string(),
    updated: z.string(),
  }),
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
}