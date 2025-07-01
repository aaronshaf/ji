import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import type { Issue, Board } from './jira-client.js';
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
    
    // Also clear the backfill limit for this project
    await this.clearBackfillLimit(projectKey);
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

  async getLatestIssueUpdate(projectKey: string): Promise<string | null> {
    const stmt = this.db.prepare(`
      SELECT MAX(updated) as latest_update
      FROM issues
      WHERE project_key = ?
    `);
    const result = stmt.get(projectKey) as { latest_update: string | null };
    return result?.latest_update || null;
  }

  async getOldestIssueUpdate(projectKey: string): Promise<string | null> {
    const stmt = this.db.prepare(`
      SELECT MIN(updated) as oldest_update
      FROM issues
      WHERE project_key = ?
    `);
    const result = stmt.get(projectKey) as { oldest_update: string | null };
    return result?.oldest_update || null;
  }

  async getIssueUpdateRange(projectKey: string): Promise<{ oldest: string | null, newest: string | null }> {
    const stmt = this.db.prepare(`
      SELECT MIN(updated) as oldest_update, MAX(updated) as newest_update
      FROM issues
      WHERE project_key = ?
    `);
    const result = stmt.get(projectKey) as { oldest_update: string | null, newest_update: string | null };
    return {
      oldest: result?.oldest_update || null,
      newest: result?.newest_update || null
    };
  }

  async getBackfillLimit(projectKey: string): Promise<string | null> {
    // Get the timestamp of when we last did a backfill for this project
    const stmt = this.db.prepare(`
      SELECT value FROM config WHERE key = ?
    `);
    const result = stmt.get(`backfill_limit_${projectKey}`) as { value: string } | undefined;
    return result?.value || null;
  }

  async setBackfillLimit(projectKey: string, timestamp: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
    `);
    stmt.run(`backfill_limit_${projectKey}`, timestamp);
  }

  async clearBackfillLimit(projectKey: string): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM config WHERE key = ?
    `);
    stmt.run(`backfill_limit_${projectKey}`);
  }

  async getWorkspaceLastSync(type: string, key: string): Promise<Date | null> {
    const stmt = this.db.prepare(`
      SELECT last_synced
      FROM workspaces
      WHERE type = ? AND key_or_id = ?
    `);
    const result = stmt.get(type, key) as { last_synced: number | null } | undefined;
    return result?.last_synced ? new Date(result.last_synced) : null;
  }

  async updateWorkspaceLastSync(type: string, key: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE workspaces
      SET last_synced = ?
      WHERE type = ? AND key_or_id = ?
    `);
    stmt.run(Date.now(), type, key);
  }

  async getBoardsLastSync(): Promise<number | null> {
    const result = this.db.prepare(
      'SELECT MAX(synced_at) as last_sync FROM boards'
    ).get() as { last_sync: number | null };
    return result?.last_sync || null;
  }

  async getBoardCount(): Promise<number> {
    const result = this.db.prepare(
      'SELECT COUNT(*) as count FROM boards'
    ).get() as { count: number };
    return result.count;
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

  // Board management methods
  async saveBoards(boards: Board[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO boards (id, name, type, project_key, project_name, self_url, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const now = Date.now();
    for (const board of boards) {
      stmt.run(
        board.id,
        board.name,
        board.type,
        board.location?.projectKey || null,
        board.location?.projectName || null,
        null, // self_url not available in Board schema
        now
      );
    }
  }

  async getMyBoards(userEmail: string): Promise<Board[]> {
    // Get boards for projects where user has recent activity
    const stmt = this.db.prepare(`
      SELECT DISTINCT b.*
      FROM boards b
      JOIN issues i ON b.project_key = i.project_key
      WHERE i.assignee_email = ? 
        AND i.updated > (strftime('%s', 'now', '-30 days') * 1000)
        AND b.synced_at > (strftime('%s', 'now', '-7 days') * 1000)
      ORDER BY b.project_key, b.name
    `);
    
    const rows = stmt.all(userEmail) as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      location: {
        projectKey: row.project_key,
        projectName: row.project_name
      }
    }));
  }

  async getAllCachedBoards(): Promise<Board[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM boards
      WHERE synced_at > (strftime('%s', 'now', '-7 days') * 1000)
      ORDER BY project_key, name
    `);
    
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      location: {
        projectKey: row.project_key,
        projectName: row.project_name
      }
    }));
  }

  // Workspace management methods
  async trackWorkspace(type: 'jira_project' | 'confluence_space', keyOrId: string, name: string): Promise<void> {
    const id = `${type}:${keyOrId}`;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_workspaces (id, type, name, key_or_id, usage_count, last_used, auto_sync)
      VALUES (?, ?, ?, ?, COALESCE((SELECT usage_count FROM user_workspaces WHERE id = ?) + 1, 1), ?, 0)
    `);
    
    stmt.run(id, type, name, keyOrId, id, Date.now());
  }

  async getActiveWorkspaces(): Promise<Array<{id: string; type: string; name: string; keyOrId: string; usageCount: number; lastUsed: number; autoSync: boolean}>> {
    const stmt = this.db.prepare(`
      SELECT id, type, name, key_or_id, usage_count, last_used, auto_sync
      FROM user_workspaces
      WHERE last_used > (strftime('%s', 'now', '-60 days') * 1000)
      ORDER BY usage_count DESC, last_used DESC
      LIMIT 10
    `);
    
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      name: row.name,
      keyOrId: row.key_or_id,
      usageCount: row.usage_count,
      lastUsed: row.last_used,
      autoSync: row.auto_sync === 1
    }));
  }

  async setWorkspaceAutoSync(id: string, autoSync: boolean): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE user_workspaces 
      SET auto_sync = ?, synced_at = CASE WHEN ? THEN ? ELSE synced_at END
      WHERE id = ?
    `);
    
    stmt.run(autoSync ? 1 : 0, autoSync, Date.now(), id);
  }

  // Sprint management methods
  async trackUserSprint(userEmail: string, sprint: {
    id: string;
    name: string;
    boardId: number;
    projectKey: string;
  }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_sprints 
      (user_email, sprint_id, sprint_name, board_id, project_key, last_accessed, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    
    stmt.run(userEmail, sprint.id, sprint.name, sprint.boardId, sprint.projectKey, Date.now());
  }

  async getUserActiveSprints(userEmail: string): Promise<Array<{
    sprintId: string;
    sprintName: string;
    boardId: number;
    projectKey: string;
    lastAccessed: number;
  }>> {
    const stmt = this.db.prepare(`
      SELECT sprint_id, sprint_name, board_id, project_key, last_accessed
      FROM user_sprints
      WHERE user_email = ? AND is_active = 1
      ORDER BY last_accessed DESC
    `);
    
    const rows = stmt.all(userEmail) as any[];
    return rows.map(row => ({
      sprintId: row.sprint_id,
      sprintName: row.sprint_name,
      boardId: row.board_id,
      projectKey: row.project_key,
      lastAccessed: row.last_accessed
    }));
  }

  async getSprintIssues(sprintId: string, options?: { 
    assignee?: string | null 
  }): Promise<any[]> {
    let query = `
      SELECT key, project_key, summary, status, priority, assignee_name, assignee_email, updated, sprint_id, sprint_name
      FROM issues
      WHERE sprint_id = ?
    `;
    
    const params: any[] = [sprintId];
    
    if (options?.assignee === null) {
      // Only unassigned issues
      query += ` AND (assignee_email IS NULL OR assignee_email = '')`;
    } else if (options?.assignee) {
      // Specific assignee
      query += ` AND assignee_email = ?`;
      params.push(options.assignee);
    }
    
    query += ` ORDER BY priority DESC, updated DESC`;
    
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  close() {
    this.db.close();
  }
}