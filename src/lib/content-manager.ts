import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import type { Issue } from './jira-client.js';

export interface SearchableContent {
  id: string;
  source: 'jira' | 'confluence';
  type: string;
  title: string;
  content: string;
  url: string;
  spaceKey?: string;
  projectKey?: string;
  metadata?: any;
  createdAt?: number;
  updatedAt?: number;
  syncedAt: number;
}

export class ContentManager {
  private db: Database;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
  }

  async saveJiraIssue(issue: Issue): Promise<void> {
    const projectKey = issue.key.split('-')[0];
    
    // Save to issues table (existing logic)
    const projectStmt = this.db.prepare('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)');
    projectStmt.run(projectKey, projectKey);
    
    const issueStmt = this.db.prepare(`
      INSERT OR REPLACE INTO issues (
        key, project_key, summary, status, priority,
        assignee_name, assignee_email, reporter_name, reporter_email,
        created, updated, description, raw_data, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    issueStmt.run(
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

    // Also save to searchable_content
    const content = this.buildJiraContent(issue);
    await this.saveContent({
      id: `jira:${issue.key}`,
      source: 'jira',
      type: 'issue',
      title: `${issue.key}: ${issue.fields.summary}`,
      content: content,
      url: `${issue.self}`,
      projectKey: projectKey,
      metadata: {
        status: issue.fields.status.name,
        priority: issue.fields.priority?.name,
        assignee: issue.fields.assignee?.displayName,
        reporter: issue.fields.reporter.displayName
      },
      createdAt: new Date(issue.fields.created).getTime(),
      updatedAt: new Date(issue.fields.updated).getTime(),
      syncedAt: Date.now()
    });
  }

  async saveContent(content: SearchableContent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO searchable_content (
        id, source, type, title, content, url,
        space_key, project_key, metadata,
        created_at, updated_at, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      content.id,
      content.source,
      content.type,
      content.title,
      content.content,
      content.url,
      content.spaceKey || null,
      content.projectKey || null,
      JSON.stringify(content.metadata || {}),
      content.createdAt || null,
      content.updatedAt || null,
      content.syncedAt
    );

    // Also insert into FTS table
    const ftsStmt = this.db.prepare(`
      INSERT OR REPLACE INTO content_fts (id, title, content)
      VALUES (?, ?, ?)
    `);
    
    ftsStmt.run(content.id, content.title, content.content);
  }

  async searchContent(query: string, options?: {
    source?: 'jira' | 'confluence';
    type?: string;
    limit?: number;
  }): Promise<SearchableContent[]> {
    // Handle special case for ID search
    if (query.startsWith('id:')) {
      const id = query.substring(3);
      const stmt = this.db.prepare('SELECT * FROM searchable_content WHERE id = ?');
      const row = stmt.get(id) as any;
      
      if (!row) return [];
      
      return [{
        id: row.id,
        source: row.source,
        type: row.type,
        title: row.title,
        content: row.content,
        url: row.url,
        spaceKey: row.space_key,
        projectKey: row.project_key,
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        syncedAt: row.synced_at
      }];
    }

    let sql = `
      SELECT sc.*,
        snippet(content_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM searchable_content sc
      JOIN content_fts ON content_fts.id = sc.id
      WHERE content_fts MATCH ?
    `;

    const params: any[] = [query];

    if (options?.source) {
      sql += ' AND sc.source = ?';
      params.push(options.source);
    }

    if (options?.type) {
      sql += ' AND sc.type = ?';
      params.push(options.type);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(options?.limit || 20);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      source: row.source,
      type: row.type,
      title: row.title,
      content: row.content,
      url: row.url,
      spaceKey: row.space_key,
      projectKey: row.project_key,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      syncedAt: row.synced_at,
      snippet: row.snippet
    }));
  }

  private buildJiraContent(issue: Issue): string {
    const parts = [
      issue.fields.summary,
      `Status: ${issue.fields.status.name}`,
      issue.fields.priority ? `Priority: ${issue.fields.priority.name}` : '',
      issue.fields.assignee ? `Assignee: ${issue.fields.assignee.displayName}` : '',
      `Reporter: ${issue.fields.reporter.displayName}`,
      this.extractDescription(issue.fields.description)
    ];

    return parts.filter(Boolean).join('\n');
  }

  private extractDescription(description: any): string {
    if (typeof description === 'string') {
      return description;
    }
    
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