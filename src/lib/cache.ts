import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import type { Issue, Board } from './jira-client.js';
import { ContentManager } from './content-manager.js';
import { Effect, Option, pipe } from 'effect';
import { 
  QueryError, 
  ParseError, 
  ValidationError
} from './effects/errors.js';

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

  /**
   * Effect-based version of getIssue with better error handling
   * Returns Option.none() for not found, throws specific errors for other failures
   */
  getIssueEffect(key: string): Effect.Effect<Option.Option<Issue>, ValidationError | QueryError | ParseError> {
    return pipe(
      // Validate input
      Effect.sync(() => {
        if (!key || !key.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format', 'key', key);
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          const stmt = this.db.prepare('SELECT raw_data FROM issues WHERE key = ?');
          const row = stmt.get(key) as { raw_data: string } | undefined;
          return row;
        }).pipe(
          Effect.mapError(error => new QueryError(`Failed to query issue ${key}: ${error}`))
        )
      ),
      Effect.flatMap(row => {
        if (!row) {
          return Effect.succeed(Option.none());
        }
        return pipe(
          Effect.try(() => JSON.parse(row.raw_data) as Issue),
          Effect.mapError(error => new ParseError(`Failed to parse issue ${key}`, 'raw_data', row.raw_data, error)),
          Effect.map(Option.some)
        );
      })
    );
  }

  /**
   * Effect-based delete project issues with transaction support
   */
  deleteProjectIssuesEffect(projectKey: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      // Validate input
      Effect.sync(() => {
        if (!projectKey || projectKey.length === 0) {
          throw new ValidationError('Project key cannot be empty', 'projectKey', projectKey);
        }
      }),
      Effect.flatMap(() =>
        Effect.try(() => {
          // Use transaction for atomicity
          this.db.transaction(() => {
            const deleteIssuesStmt = this.db.prepare('DELETE FROM issues WHERE project_key = ?');
            const deleteContentStmt = this.db.prepare('DELETE FROM searchable_content WHERE project_key = ? AND source = ?');
            
            deleteIssuesStmt.run(projectKey);
            deleteContentStmt.run(projectKey, 'jira');
          })();
        }).pipe(
          Effect.mapError(error => new QueryError(`Failed to delete project issues: ${error}`))
        )
      ),
      // Clear backfill limit after successful deletion
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () => this.clearBackfillLimit(projectKey),
          catch: error => new QueryError(`Failed to clear backfill limit: ${error}`)
        })
      )
    );
  }

  // Backward compatible version
  async deleteProjectIssues(projectKey: string): Promise<void> {
    // Delete from both issues table and searchable_content table
    const deleteIssuesStmt = this.db.prepare('DELETE FROM issues WHERE project_key = ?');
    const deleteContentStmt = this.db.prepare('DELETE FROM searchable_content WHERE project_key = ? AND source = ?');
    
    deleteIssuesStmt.run(projectKey);
    deleteContentStmt.run(projectKey, 'jira');
    
    // Also clear the backfill limit for this project
    await this.clearBackfillLimit(projectKey);
  }

  async deleteSpacePages(spaceKey: string): Promise<void> {
    // Delete Confluence pages from searchable_content table
    const deleteContentStmt = this.db.prepare('DELETE FROM searchable_content WHERE space_key = ? AND source = ?');
    deleteContentStmt.run(spaceKey, 'confluence');
  }

  /**
   * Effect-based save issue with validation
   */
  saveIssueEffect(issue: Issue): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      // Validate issue structure
      Effect.sync(() => {
        if (!issue || typeof issue !== 'object') {
          throw new ValidationError('Issue must be an object', 'issue', issue);
        }
        if (!issue.key || !issue.key.match(/^[A-Z]+-\d+$/)) {
          throw new ValidationError('Invalid issue key format', 'issue.key', issue.key);
        }
        if (!issue.fields?.summary) {
          throw new ValidationError('Issue must have a summary', 'issue.fields.summary', undefined);
        }
      }),
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () => this.contentManager.saveJiraIssue(issue),
          catch: error => new QueryError(`Failed to save issue ${issue.key}: ${error}`)
        })
      )
    );
  }

  // Backward compatible version
  async saveIssue(issue: Issue): Promise<void> {
    // Save using content manager (handles both tables)
    await this.contentManager.saveJiraIssue(issue);
  }

  async listIssuesByProject(projectKey: string): Promise<Array<{
    key: string;
    summary: string;
    status: string;
    priority: string;
    assignee_name: string | null;
    updated: string;
  }>> {
    const stmt = this.db.prepare(`
      SELECT key, summary, status, priority, assignee_name, updated
      FROM issues
      WHERE project_key = ?
      ORDER BY updated DESC
    `);
    return stmt.all(projectKey) as Array<{
      key: string;
      summary: string;
      status: string;
      priority: string;
      assignee_name: string | null;
      updated: string;
    }>;
  }

  async listRecentIssues(limit: number = 20): Promise<Array<{
    key: string;
    project_key: string;
    summary: string;
    status: string;
    priority: string;
    assignee_name: string | null;
    updated: string;
  }>> {
    const stmt = this.db.prepare(`
      SELECT key, project_key, summary, status, priority, assignee_name, updated
      FROM issues
      ORDER BY updated DESC
      LIMIT ?
    `);
    return stmt.all(limit) as Array<{
      key: string;
      project_key: string;
      summary: string;
      status: string;
      priority: string;
      assignee_name: string | null;
      updated: string;
    }>;
  }

  /**
   * Effect-based batch save issues with transaction
   */
  saveIssuesBatchEffect(issues: Issue[]): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      // Validate all issues first
      Effect.sync(() => {
        if (!Array.isArray(issues)) {
          throw new ValidationError('Issues must be an array', 'issues', issues);
        }
        if (issues.length === 0) {
          return; // Nothing to save
        }
        if (issues.length > 1000) {
          throw new ValidationError('Too many issues in batch (max 1000)', 'issues.length', issues.length);
        }
        
        // Validate each issue
        issues.forEach((issue, index) => {
          if (!issue || typeof issue !== 'object') {
            throw new ValidationError(`Issue at index ${index} must be an object`, `issues[${index}]`, issue);
          }
          if (!issue.key || !issue.key.match(/^[A-Z]+-\d+$/)) {
            throw new ValidationError(`Invalid issue key at index ${index}`, `issues[${index}].key`, issue.key);
          }
        });
      }),
      Effect.flatMap(() => {
        if (issues.length === 0) {
          return Effect.succeed(undefined);
        }
        
        return Effect.try(() => {
          // Use transaction for atomicity and performance
          this.db.transaction(() => {
            issues.forEach(issue => {
              // Save each issue using content manager
              this.contentManager.saveJiraIssue(issue);
            });
          })();
        }).pipe(
          Effect.mapError(error => new QueryError(`Failed to save batch of ${issues.length} issues: ${error}`))
        );
      })
    );
  }

  async listMyOpenIssues(assigneeEmail: string): Promise<Array<{
    key: string;
    project_key: string;
    summary: string;
    status: string;
    priority: string;
    assignee_name: string | null;
    updated: string;
  }>> {
    const stmt = this.db.prepare(`
      SELECT key, project_key, summary, status, priority, assignee_name, updated
      FROM issues
      WHERE assignee_email = ? AND LOWER(status) NOT IN ('closed', 'done', 'resolved', 'cancelled', 'canceled', 'rejected', 'won''t do', 'duplicate', 'invalid')
      ORDER BY updated DESC
    `);
    return stmt.all(assigneeEmail) as Array<{
      key: string;
      project_key: string;
      summary: string;
      status: string;
      priority: string;
      assignee_name: string | null;
      updated: string;
    }>;
  }

  async getProjectLastSync(projectKey: string): Promise<Date | null> {
    const stmt = this.db.prepare(`
      SELECT MAX(synced_at) as last_sync
      FROM issues
      WHERE project_key = ?
    `);
    const result = stmt.get(projectKey) as { last_sync: number | null } | undefined;
    return result?.last_sync ? new Date(result.last_sync) : null;
  }

  async getProjectIssueKeys(projectKey: string): Promise<string[]> {
    const stmt = this.db.prepare(`
      SELECT key
      FROM issues
      WHERE project_key = ?
    `);
    const results = stmt.all(projectKey) as { key: string }[];
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
    
    const rows = stmt.all(userEmail) as Array<{
      id: number;
      name: string;
      type: string;
      project_key: string | null;
      project_name: string | null;
    }>;
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      location: row.project_key || row.project_name ? {
        projectKey: row.project_key || undefined,
        projectName: row.project_name || undefined
      } : undefined
    }));
  }

  async getAllCachedBoards(): Promise<Board[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM boards
      WHERE synced_at > (strftime('%s', 'now', '-7 days') * 1000)
      ORDER BY project_key, name
    `);
    
    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      type: string;
      project_key: string | null;
      project_name: string | null;
    }>;
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      location: row.project_key || row.project_name ? {
        projectKey: row.project_key || undefined,
        projectName: row.project_name || undefined
      } : undefined
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
    
    const rows = stmt.all() as Array<{
      id: string;
      type: string;
      name: string;
      key_or_id: string;
      usage_count: number;
      last_used: number;
      auto_sync: number;
    }>;
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
    
    const rows = stmt.all(userEmail) as Array<{
      sprint_id: string;
      sprint_name: string;
      board_id: number;
      project_key: string;
      last_accessed: number;
    }>;
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
  }): Promise<Array<{
    key: string;
    project_key: string;
    summary: string;
    status: string;
    priority: string;
    assignee_name: string | null;
    assignee_email: string | null;
    updated: string;
    sprint_id: string;
    sprint_name: string;
  }>> {
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
    return stmt.all(...params) as Array<{
      key: string;
      project_key: string;
      summary: string;
      status: string;
      priority: string;
      assignee_name: string | null;
      assignee_email: string | null;
      updated: string;
      sprint_id: string;
      sprint_name: string;
    }>;
  }

  async getCachedSprintIssues(sprintId: string): Promise<Array<{
    sprint_id: string;
    key: string;
    project_key: string;
    summary: string;
    status: string;
    priority: string;
    priority_order: number;
    assignee_name: string | null;
    assignee_email: string | null;
    updated: string;
    cached_at: number;
  }>> {
    const stmt = this.db.prepare(`
      SELECT * FROM sprint_issues_cache
      WHERE sprint_id = ?
      ORDER BY priority_order, updated DESC
    `);
    return stmt.all(sprintId) as Array<{
      sprint_id: string;
      key: string;
      project_key: string;
      summary: string;
      status: string;
      priority: string;
      priority_order: number;
      assignee_name: string | null;
      assignee_email: string | null;
      updated: string;
      cached_at: number;
    }>;
  }

  async setCachedSprintIssues(sprintId: string, issues: Array<{
    key: string;
    project_key: string;
    summary: string;
    status: string;
    priority: string;
    assignee_name?: string | null;
    assignee_email?: string | null;
    updated: string;
  }>): Promise<void> {
    // Delete existing cached issues for this sprint
    const deleteStmt = this.db.prepare('DELETE FROM sprint_issues_cache WHERE sprint_id = ?');
    deleteStmt.run(sprintId);

    if (issues.length === 0) return;

    // Insert new cached issues
    const insertStmt = this.db.prepare(`
      INSERT INTO sprint_issues_cache (
        sprint_id, key, project_key, summary, status, priority, priority_order,
        assignee_name, assignee_email, updated, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const priorityOrder: Record<string, number> = { 'Highest': 1, 'High': 2, 'Medium': 3, 'Low': 4, 'Lowest': 5 };

    for (const issue of issues) {
      insertStmt.run(
        sprintId,
        issue.key,
        issue.project_key,
        issue.summary,
        issue.status,
        issue.priority,
        priorityOrder[issue.priority] || 6,
        issue.assignee_name || null,
        issue.assignee_email || null,
        issue.updated,
        now
      );
    }
  }

  async getSprintCacheAge(sprintId: string): Promise<number | null> {
    const stmt = this.db.prepare(`
      SELECT MIN(cached_at) as oldest_cache 
      FROM sprint_issues_cache 
      WHERE sprint_id = ?
    `);
    const result = stmt.get(sprintId) as { oldest_cache: number | null };
    return result?.oldest_cache || null;
  }

  close() {
    this.db.close();
  }
}