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