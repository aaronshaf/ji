import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import type { Issue } from './jira-client.js';
import { MeilisearchAdapter } from './meilisearch-adapter.js';
import { OllamaClient } from './ollama.js';

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

export interface SearchResult {
  content: SearchableContent;
  score: number;
  snippet: string;
  chunkIndex?: number;
}

export class ContentManager {
  public db: Database;

  constructor() {
    const dbPath = join(homedir(), '.ji', 'data.db');
    this.db = new Database(dbPath);
  }

  async saveJiraIssue(issue: Issue): Promise<void> {
    const projectKey = issue.key.split('-')[0];
    
    // Save to issues table (existing logic)
    const projectStmt = this.db.prepare('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)');
    projectStmt.run(projectKey, projectKey);
    
    // Extract sprint information from custom fields
    const sprintInfo = this.extractSprintInfo(issue);
    
    const issueStmt = this.db.prepare(`
      INSERT OR REPLACE INTO issues (
        key, project_key, summary, status, priority,
        assignee_name, assignee_email, reporter_name, reporter_email,
        created, updated, description, raw_data, synced_at,
        sprint_id, sprint_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      issue.fields.reporter.emailAddress || null,
      new Date(issue.fields.created).getTime(),
      new Date(issue.fields.updated).getTime(),
      this.extractDescription(issue.fields.description),
      JSON.stringify(issue),
      Date.now(),
      sprintInfo?.id || null,
      sprintInfo?.name || null
    );

    // Also save to searchable_content
    const content = this.buildJiraContent(issue);
    await this.saveContent({
      id: `jira:${issue.key}`,
      source: 'jira',
      type: 'issue',
      title: `${issue.key}: ${issue.fields.summary}`,
      content: content,
      url: `/browse/${issue.key}`,
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
    // Calculate content hash
    const contentHash = OllamaClient.contentHash(content.content);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO searchable_content (
        id, source, type, title, content, url,
        space_key, project_key, metadata,
        created_at, updated_at, synced_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      content.syncedAt,
      contentHash
    );

    // Also update FTS table
    // First delete existing entry
    const deleteFtsStmt = this.db.prepare('DELETE FROM content_fts WHERE id = ?');
    deleteFtsStmt.run(content.id);
    
    // Then insert new entry
    const ftsStmt = this.db.prepare(`
      INSERT INTO content_fts (id, title, content)
      VALUES (?, ?, ?)
    `);
    
    ftsStmt.run(content.id, content.title, content.content);
    
    // Also index to Meilisearch
    try {
      const meilisearch = new MeilisearchAdapter();
      await meilisearch.indexContent(content);
    } catch (error) {
      // Log but don't fail if Meilisearch is unavailable
      console.error('Failed to index to Meilisearch:', error);
    }
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



  async getSpacePageVersions(spaceKey: string): Promise<Map<string, { version: number; updatedAt: number; syncedAt: number }>> {
    const stmt = this.db.prepare(`
      SELECT id, updated_at, synced_at, 
             JSON_EXTRACT(metadata, '$.version.number') as version_number
      FROM searchable_content 
      WHERE space_key = ? AND source = 'confluence'
    `);
    
    const rows = stmt.all(spaceKey) as Array<{
      id: string;
      updated_at: number;
      synced_at: number;
      version_number: number;
    }>;
    
    const versionMap = new Map<string, { version: number; updatedAt: number; syncedAt: number }>();
    
    for (const row of rows) {
      const pageId = row.id.replace('confluence:', '');
      versionMap.set(pageId, {
        version: row.version_number || 1,
        updatedAt: row.updated_at,
        syncedAt: row.synced_at
      });
    }
    
    return versionMap;
  }

  async hasContentChanged(pageId: string, newContentHash: string): Promise<boolean> {
    const stmt = this.db.prepare(
      'SELECT content_hash FROM searchable_content WHERE id = ?'
    );
    const existing = stmt.get(`confluence:${pageId}`) as { content_hash?: string } | undefined;
    
    return !existing || existing.content_hash !== newContentHash;
  }

  private extractSprintInfo(issue: Issue): { id: string; name: string } | null {
    // Sprint information is typically stored in customfield_10020 or similar
    // The format is usually an array of sprint strings
    const fields = issue.fields as any;
    
    // Common sprint field names
    const sprintFieldNames = [
      'customfield_10020', // Most common
      'customfield_10021',
      'customfield_10016',
      'sprint',
      'sprints'
    ];
    
    for (const fieldName of sprintFieldNames) {
      const sprintData = fields[fieldName];
      if (!sprintData) continue;
      
      // Handle array of sprints (take the most recent/active one)
      if (Array.isArray(sprintData) && sprintData.length > 0) {
        const sprintString = sprintData[sprintData.length - 1];
        if (typeof sprintString === 'string') {
          // Parse sprint string format: "com.atlassian.greenhopper.service.sprint.Sprint@1234[id=123,name=Sprint 1,...]"  
          const idMatch = sprintString.match(/\[.*?id=(\d+)/i);
          const nameMatch = sprintString.match(/\[.*?name=([^,\]]+)/i);
          
          if (idMatch && nameMatch) {
            return {
              id: idMatch[1],
              name: nameMatch[1]
            };
          }
        } else if (typeof sprintString === 'object' && sprintString.id && sprintString.name) {
          // Sometimes it's already an object
          return {
            id: String(sprintString.id),
            name: sprintString.name
          };
        }
      }
      
      // Handle single sprint object
      if (typeof sprintData === 'object' && sprintData.id && sprintData.name) {
        return {
          id: String(sprintData.id),
          name: sprintData.name
        };
      }
    }
    
    return null;
  }

  close() {
    this.db.close();
  }
}