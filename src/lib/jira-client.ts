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
    // Common sprint custom fields - these will be present when we fetch with custom fields
    customfield_10020: z.any().optional(), // Most common sprint field
    customfield_10021: z.any().optional(), // Alternative sprint field
    customfield_10016: z.any().optional(), // Another common sprint field
  }).catchall(z.any()), // Allow other custom fields to pass through
});

const SearchResultSchema = z.object({
  issues: z.array(IssueSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

const BoardSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  location: z.object({
    projectKey: z.string().optional(),
    projectName: z.string().optional(),
  }).optional(),
});

const BoardsResponseSchema = z.object({
  values: z.array(BoardSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

const SprintSchema = z.object({
  id: z.number(),
  self: z.string(),
  state: z.string(),
  name: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  originBoardId: z.number(),
  goal: z.string().optional(),
});

const SprintsResponseSchema = z.object({
  values: z.array(SprintSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

export type Issue = z.infer<typeof IssueSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Sprint = z.infer<typeof SprintSchema>;

// Standard fields to fetch for issues including sprint information
export const ISSUE_FIELDS = [
  'summary',
  'description', 
  'status',
  'assignee',
  'reporter',
  'priority',
  'created',
  'updated',
  // Common sprint custom fields
  'customfield_10020', // Most common sprint field
  'customfield_10021', // Alternative sprint field
  'customfield_10016', // Another common sprint field
  'customfield_10018', // Sometimes used
  'customfield_10019', // Sometimes used
];

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
    const params = new URLSearchParams({
      fields: ISSUE_FIELDS.join(',')
    });
    const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}?${params}`;
    
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

  async getCurrentUser(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
    const url = `${this.config.jiraUrl}/rest/api/3/myself`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get current user: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      accountId: string;
      displayName: string;
      emailAddress?: string;
    };
    return {
      accountId: data.accountId,
      displayName: data.displayName,
      emailAddress: data.emailAddress,
    };
  }

  async assignIssue(issueKey: string, accountId: string): Promise<void> {
    const url = `${this.config.jiraUrl}/rest/api/3/issue/${issueKey}/assignee`;
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ accountId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to assign issue: ${response.status} - ${errorText}`);
    }
  }

  async getBoards(options?: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' }): Promise<Board[]> {
    let url = `${this.config.jiraUrl}/rest/agile/1.0/board`;
    const params = new URLSearchParams();
    
    if (options?.projectKeyOrId) {
      params.append('projectKeyOrId', options.projectKeyOrId);
    }
    if (options?.type) {
      params.append('type', options.type);
    }
    
    if (params.toString()) {
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch boards: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as unknown;
    const parsed = BoardsResponseSchema.parse(data);
    return parsed.values;
  }

  async getBoardsForProject(projectKey: string): Promise<Board[]> {
    return this.getBoards({ projectKeyOrId: projectKey });
  }

  async getUserActiveProjects(userEmail: string): Promise<string[]> {
    // Get recent issues assigned to user to determine active projects
    const jql = `assignee = "${userEmail}" AND updated >= -30d ORDER BY updated DESC`;
    
    try {
      const result = await this.searchIssues(jql, { maxResults: 100 });
      const projectKeys = new Set<string>();
      
      result.issues.forEach(issue => {
        const projectKey = issue.key.split('-')[0];
        projectKeys.add(projectKey);
      });
      
      return Array.from(projectKeys);
    } catch (error) {
      console.warn('Failed to get user active projects:', error);
      return [];
    }
  }

  async getUserBoards(userEmail: string): Promise<Board[]> {
    const activeProjects = await this.getUserActiveProjects(userEmail);
    const allBoards: Board[] = [];
    
    // Get boards for each active project
    for (const projectKey of activeProjects) {
      try {
        const projectBoards = await this.getBoardsForProject(projectKey);
        allBoards.push(...projectBoards);
      } catch (error) {
        console.warn(`Failed to get boards for project ${projectKey}:`, error);
      }
    }
    
    // Remove duplicates and sort by name
    const uniqueBoards = allBoards.filter((board, index, array) => 
      array.findIndex(b => b.id === board.id) === index
    );
    
    return uniqueBoards.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getBoardConfiguration(boardId: number): Promise<{ columns: Array<{ name: string; statuses: Array<{ id: string; name: string }> }> }> {
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/configuration`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch board configuration: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    return {
      columns: data.columnConfig?.columns || []
    };
  }

  async getBoardIssues(boardId: number): Promise<Issue[]> {
    // Simple version - just get first 50 issues to avoid timeout
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/issue?maxResults=50`;

    const response = await fetch(url, {
      method: 'GET', 
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch board issues: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    
    // Map the agile API response to our Issue type
    return (data.issues || []).map((issue: any) => ({
      key: issue.key,
      self: issue.self,
      fields: {
        summary: issue.fields.summary,
        description: issue.fields.description,
        status: issue.fields.status,
        assignee: issue.fields.assignee,
        reporter: issue.fields.reporter,
        priority: issue.fields.priority,
        created: issue.fields.created,
        updated: issue.fields.updated
      }
    }));
  }

  async getActiveSprints(boardId: number): Promise<Sprint[]> {
    const url = `${this.config.jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch active sprints: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const parsed = SprintsResponseSchema.parse(data);
    return parsed.values;
  }

  async getSprintIssues(sprintId: number, options?: {
    startAt?: number;
    maxResults?: number;
  }): Promise<{ issues: Issue[]; total: number }> {
    const params = new URLSearchParams({
      startAt: (options?.startAt || 0).toString(),
      maxResults: (options?.maxResults || 50).toString(),
    });

    const url = `${this.config.jiraUrl}/rest/agile/1.0/sprint/${sprintId}/issue?${params}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch sprint issues: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    return {
      issues: data.issues.map((issue: any) => IssueSchema.parse(issue)),
      total: data.total
    };
  }

  async getUserActiveSprints(userEmail: string): Promise<Sprint[]> {
    // First, get all boards the user has access to
    const boards = await this.getUserBoards(userEmail);
    const allSprints: Sprint[] = [];
    
    // For each board, get active sprints
    for (const board of boards) {
      try {
        const sprints = await this.getActiveSprints(board.id);
        allSprints.push(...sprints);
      } catch (error) {
        // Skip boards that might not have sprint support
        continue;
      }
    }
    
    // Remove duplicates
    const uniqueSprints = Array.from(
      new Map(allSprints.map(s => [s.id, s])).values()
    );
    
    return uniqueSprints;
  }
}