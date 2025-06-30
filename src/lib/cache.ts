import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import type { Issue } from './jira-client.js';

export class CacheManager {
  private db: Database;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'config.db');
    this.db = new Database(dbPath);
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
    // Extract project key from issue key (e.g., PROJ-123 -> PROJ)
    const projectKey = issue.key.split('-')[0];
    
    // Ensure project exists
    const projectStmt = this.db.prepare('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)');
    projectStmt.run(projectKey, projectKey); // We'll update with proper name later
    
    // Save issue with all fields
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO issues (
        key, project_key, summary, status, priority,
        assignee_name, assignee_email, reporter_name, reporter_email,
        created, updated, description, raw_data, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      issue.key,
      projectKey,
      issue.fields.summary,
      issue.fields.status.name,
      issue.fields.priority?.name || null,
      issue.fields.assignee?.displayName || null,
      issue.fields.assignee?.emailAddress || null,
      issue.fields.reporter.displayName,
      issue.fields.reporter.emailAddress,
      new Date(issue.fields.created).getTime(),
      new Date(issue.fields.updated).getTime(),
      this.extractDescription(issue.fields.description),
      JSON.stringify(issue),
      Date.now()
    );
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