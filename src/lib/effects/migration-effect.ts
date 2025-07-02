import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Layer, pipe } from 'effect';
import { DatabaseError } from './errors';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ask_memory (
        id TEXT PRIMARY KEY NOT NULL,
        question_hash TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        relevant_doc_ids TEXT,
        confidence REAL NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ask_memory_question_hash ON ask_memory (question_hash);
    `,
  },
];

export class MigrationEffect {
  constructor(private db: Database) {}

  runMigrations(): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        this.db.exec('BEGIN');
        try {
          this.db.exec(migrations[0].sql);
          const stmt = this.db.prepare('INSERT INTO migrations (id, name, created_at) VALUES (?, ?, ?)');
          stmt.run(migrations[0].id, migrations[0].name, Date.now());
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
      },
      catch: (error) => new DatabaseError('Migration failed', error),
    });
  }

  validateSchema(): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        const tableNames = tables.map((t) => t.name);
        if (!tableNames.includes('migrations')) {
          throw new Error('migrations table not found');
        }
        if (!tableNames.includes('ask_memory')) {
          throw new Error('ask_memory table not found');
        }
      },
      catch: (error) => new DatabaseError('Schema validation failed', error),
    });
  }

  rollbackMigration(): Effect.Effect<void, DatabaseError> {
    return Effect.tryPromise({
      try: async () => {
        this.db.exec('BEGIN');
        try {
          this.db.exec('DROP TABLE IF EXISTS migrations');
          this.db.exec('DROP TABLE IF EXISTS ask_memory');
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
      },
      catch: (error) => new DatabaseError('Rollback failed', error),
    });
  }

  checkDatabaseHealth(): Effect.Effect<void, DatabaseError> {
    return pipe(
      this.validateSchema(),
      Effect.mapError((error) => new DatabaseError('Database health check failed', error)),
    );
  }
}

export class MigrationEffectTag extends Context.Tag('MigrationEffect')<MigrationEffectTag, MigrationEffect>() {}

export const MigrationEffectLive = Layer.effect(
  MigrationEffectTag,
  Effect.sync(() => {
    const dbPath = join(homedir(), '.ji', 'data.db');
    const db = new Database(dbPath);
    return new MigrationEffect(db);
  }),
);
