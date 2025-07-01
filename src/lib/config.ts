import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';

const ConfigSchema = z.object({
  jiraUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

// Settings that can be configured via CLI
export interface Settings {
  askModel?: string;
  embeddingModel?: string;
  analysisModel?: string;  // Smaller, faster model for source selection and query generation
}

export class ConfigManager {
  private db: Database;
  private configDir: string;
  private authFile: string;

  constructor() {
    this.configDir = join(homedir(), '.ji');
    this.authFile = join(this.configDir, 'auth.json');
    
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }

    const dbPath = join(this.configDir, 'data.db');
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
        reporter_email TEXT,
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
    
    // Create ask memory table for progressive learning
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ask_memory (
        id TEXT PRIMARY KEY,
        question_hash TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        relevant_doc_ids TEXT,
        confidence REAL DEFAULT 0.8,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER DEFAULT 1
      )
    `);
    
    // Run migrations for existing databases
    this.runMigrations();
    
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
    // Try to read from auth file first
    if (existsSync(this.authFile)) {
      try {
        const authData = readFileSync(this.authFile, 'utf-8');
        const config = JSON.parse(authData);
        return ConfigSchema.parse(config);
      } catch (error) {
        console.error('Failed to read auth file:', error);
      }
    }
    
    // Fall back to database (for backward compatibility)
    const stmt = this.db.prepare('SELECT key, value FROM config');
    const rows = stmt.all() as { key: string; value: string }[];
    
    if (rows.length === 0) return null;

    const config: Record<string, string> = {};
    rows.forEach(row => {
      config[row.key] = row.value;
    });

    try {
      const parsed = ConfigSchema.parse(config);
      // Migrate to auth file
      await this.setConfig(parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async setConfig(config: Config): Promise<void> {
    const validated = ConfigSchema.parse(config);
    
    // Save to auth file with restrictive permissions
    writeFileSync(this.authFile, JSON.stringify(validated, null, 2), 'utf-8');
    
    // Set file permissions to 600 (read/write for owner only)
    chmodSync(this.authFile, 0o600);
  }

  private runMigrations() {
    try {
      // Add content_hash columns if they don't exist
      const contentTableInfo = this.db.prepare(`PRAGMA table_info(searchable_content)`).all() as any[];
      const hasContentHash = contentTableInfo.some((col: any) => col.name === 'content_hash');
      
      if (!hasContentHash) {
        console.log('Migrating database: Adding content hash tracking...');
        this.db.run(`ALTER TABLE searchable_content ADD COLUMN content_hash TEXT`);
      }
      
      // Add embedding tracking columns to embeddings table
      const embeddingTableInfo = this.db.prepare(`PRAGMA table_info(content_embeddings)`).all() as any[];
      const hasEmbeddingHash = embeddingTableInfo.some((col: any) => col.name === 'embedding_hash');
      
      if (!hasEmbeddingHash) {
        this.db.run(`ALTER TABLE content_embeddings ADD COLUMN embedding_hash TEXT`);
        this.db.run(`ALTER TABLE content_embeddings ADD COLUMN generated_at INTEGER`);
      }
      
      // Check if reporter_email has NOT NULL constraint
      const tableInfo = this.db.prepare(`PRAGMA table_info(issues)`).all() as any[];
      const reporterEmailCol = tableInfo.find((col: any) => col.name === 'reporter_email');
      
      if (reporterEmailCol && reporterEmailCol.notnull === 1) {
        console.log('Migrating database: Making reporter_email nullable...');
        
        // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS issues_new (
            key TEXT PRIMARY KEY,
            project_key TEXT NOT NULL,
            summary TEXT NOT NULL,
            status TEXT NOT NULL,
            priority TEXT,
            assignee_name TEXT,
            assignee_email TEXT,
            reporter_name TEXT NOT NULL,
            reporter_email TEXT,
            created INTEGER NOT NULL,
            updated INTEGER NOT NULL,
            description TEXT,
            raw_data TEXT NOT NULL,
            synced_at INTEGER NOT NULL,
            FOREIGN KEY (project_key) REFERENCES projects(key)
          )
        `);
        
        // Copy data
        this.db.run(`INSERT INTO issues_new SELECT * FROM issues`);
        
        // Drop old table and rename new one
        this.db.run(`DROP TABLE issues`);
        this.db.run(`ALTER TABLE issues_new RENAME TO issues`);
        
        console.log('Migration complete!');
      }
    } catch (error) {
      // If any error occurs during migration, just continue
      // The table creation will handle it
    }
  }

  // Settings management (stored in SQLite)
  async getSetting(key: string): Promise<string | null> {
    try {
      const stmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
      const row = stmt.get(key) as { value: string } | undefined;
      return row?.value || null;
    } catch {
      return null;
    }
  }

  async setSetting(key: string, value: string): Promise<void> {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    stmt.run(key, value);
  }

  async getSettings(): Promise<Settings> {
    const askModel = await this.getSetting('askModel');
    const embeddingModel = await this.getSetting('embeddingModel');
    const analysisModel = await this.getSetting('analysisModel');
    
    return {
      askModel: askModel || undefined,
      embeddingModel: embeddingModel || undefined,
      analysisModel: analysisModel || undefined
    };
  }

  close() {
    this.db.close();
  }
}