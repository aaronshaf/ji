import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import type { Issue } from './jira-client.js';
import { ContentManager } from './content-manager.js';

export class CacheManager {
  private db: Database;
  private contentManager: ContentManager;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
    this.contentManager = new ContentManager();
  }

  async getIssue(key: string): Promise<Issue | null> {
    const stmt = this.db.prepare('SELECT raw_data FROM issues WHERE key = ?');
    const row = stmt.get(key) as { raw_data: string } | undefined;
    
    if (!row) return null;
    
    try {
      return JSON.parse(row.raw_data);
    } catch {
      return null;
    }
  }

  async saveIssue(issue: Issue): Promise<void> {
    // Save using content manager (handles both tables)
    await this.contentManager.saveJiraIssue(issue);
    
    // Generate embeddings in background
    this.generateEmbeddingsInBackground(issue);
  }

  private async generateEmbeddingsInBackground(issue: Issue): Promise<void> {
    // Spawn a detached process for embedding generation
    const proc = Bun.spawn(['bun', 'run', process.argv[1], 'internal-embed', `jira:${issue.key}`], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env
    });
    proc.unref();
  }

  async listIssuesByProject(projectKey: string): Promise<any[]> {
    const stmt = this.db.prepare(`
      SELECT key, summary, status, priority, assignee_name, updated
      FROM issues
      WHERE project_key = ?
      ORDER BY updated DESC
    `);
    return stmt.all(projectKey);
  }

  async listRecentIssues(limit: number = 20): Promise<any[]> {
    const stmt = this.db.prepare(`
      SELECT key, project_key, summary, status, priority, assignee_name, updated
      FROM issues
      ORDER BY updated DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  private extractDescription(description: any): string {
    if (typeof description === 'string') {
      return description;
    }
    
    // Handle Atlassian Document Format (ADF)
    if (description?.content) {
      return this.parseADF(description);
    }
    
    return '';
  }

  private parseADF(doc: any): string {
    let text = '';
    
    const parseNode = (node: any): string => {
      if (node.type === 'text') {
        return node.text || '';
      }
      
      if (node.content) {
        return node.content.map((n: any) => parseNode(n)).join('');
      }
      
      if (node.type === 'paragraph') {
        return '\n' + (node.content?.map((n: any) => parseNode(n)).join('') || '') + '\n';
      }
      
      return '';
    };
    
    if (doc.content) {
      text = doc.content.map((node: any) => parseNode(node)).join('');
    }
    
    return text.trim();
  }

  close() {
    this.db.close();
  }
}