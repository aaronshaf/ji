import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const ConfigSchema = z.object({
  jiraUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigManager {
  private db: Database;
  private configDir: string;

  constructor() {
    this.configDir = join(homedir(), '.ji');
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }

    const dbPath = join(this.configDir, 'config.db');
    this.db = new Database(dbPath);
    this.initDB();
  }

  private initDB() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    
    // Create projects table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `);
    
    // Create issues table with proper relations
    this.db.run(`
      CREATE TABLE IF NOT EXISTS issues (
        key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT,
        assignee_name TEXT,
        assignee_email TEXT,
        reporter_name TEXT NOT NULL,
        reporter_email TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        description TEXT,
        raw_data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        FOREIGN KEY (project_key) REFERENCES projects(key)
      )
    `);
    
    // Create unified searchable content table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS searchable_content (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('jira', 'confluence')),
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT NOT NULL,
        space_key TEXT,
        project_key TEXT,
        metadata TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        synced_at INTEGER NOT NULL
      )
    `);
    
    // Create embeddings table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS content_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        embedding BLOB,
        chunk_index INTEGER DEFAULT 0,
        chunk_text TEXT,
        model TEXT DEFAULT 'all-MiniLM-L6-v2',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (content_id) REFERENCES searchable_content(id) ON DELETE CASCADE
      )
    `);
    
    // Create FTS5 virtual table for full-text search
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
        id,
        title,
        content
      )
    `);
    
    // Create indexes
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_key)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_email)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_content_source ON searchable_content(source)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_content_type ON searchable_content(source, type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_content_space ON searchable_content(space_key)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_content_project ON searchable_content(project_key)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_embeddings_content ON content_embeddings(content_id, chunk_index)`);
  }

  async getConfig(): Promise<Config | null> {
    const stmt = this.db.prepare('SELECT key, value FROM config');
    const rows = stmt.all() as { key: string; value: string }[];
    
    if (rows.length === 0) return null;

    const config: Record<string, string> = {};
    rows.forEach(row => {
      config[row.key] = row.value;
    });

    try {
      return ConfigSchema.parse(config);
    } catch {
      return null;
    }
  }

  async setConfig(config: Config): Promise<void> {
    const validated = ConfigSchema.parse(config);
    
    const stmt = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    
    this.db.transaction(() => {
      stmt.run('jiraUrl', validated.jiraUrl);
      stmt.run('email', validated.email);
      stmt.run('apiToken', validated.apiToken);
    })();
  }

  close() {
    this.db.close();
  }
}