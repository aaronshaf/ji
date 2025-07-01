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

  async deleteProjectIssues(projectKey: string): Promise<void> {
    // Delete from both issues table and searchable_content table
    const deleteIssuesStmt = this.db.prepare('DELETE FROM issues WHERE project_key = ?');
    const deleteContentStmt = this.db.prepare('DELETE FROM searchable_content WHERE project_key = ? AND source = ?');
    
    deleteIssuesStmt.run(projectKey);
    deleteContentStmt.run(projectKey, 'jira');
  }

  async saveIssue(issue: Issue): Promise<void> {
    // Save using content manager (handles both tables)
    await this.contentManager.saveJiraIssue(issue);
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

  async listMyOpenIssues(assigneeEmail: string): Promise<any[]> {
    const stmt = this.db.prepare(`
      SELECT key, project_key, summary, status, priority, assignee_name, updated
      FROM issues
      WHERE assignee_email = ? AND LOWER(status) NOT IN ('closed', 'done', 'resolved', 'cancelled', 'canceled', 'rejected', 'won''t do', 'duplicate', 'invalid')
      ORDER BY updated DESC
    `);
    return stmt.all(assigneeEmail);
  }

  async getProjectLastSync(projectKey: string): Promise<Date | null> {
    const stmt = this.db.prepare(`
      SELECT MAX(synced_at) as last_sync
      FROM issues
      WHERE project_key = ?
    `);
    const result = stmt.get(projectKey) as any;
    return result?.last_sync ? new Date(result.last_sync) : null;
  }

  async getProjectIssueKeys(projectKey: string): Promise<string[]> {
    const stmt = this.db.prepare(`
      SELECT key
      FROM issues
      WHERE project_key = ?
    `);
    const results = stmt.all(projectKey) as any[];
    return results.map(r => r.key);
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