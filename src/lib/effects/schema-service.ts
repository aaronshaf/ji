/**
 * Effect-based Database Schema Management Service
 * Handles database initialization, migrations, and schema validation
 */

import { Context, Effect, Layer, pipe } from 'effect';
import { DatabaseError, DataIntegrityError, type QueryError, ValidationError } from './errors.js';
import { type DatabaseService, DatabaseServiceTag, type LoggerService, LoggerServiceTag } from './layers.js';

// ============= Schema Service Types =============
export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: TableColumn[];
  indexes: string[];
  foreignKeys: ForeignKey[];
}

export interface ForeignKey {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface Migration {
  version: string;
  description: string;
  up: string[];
  down?: string[];
  checkCondition?: (db: DatabaseService) => Effect.Effect<boolean, QueryError>;
}

export interface SchemaVersion {
  version: string;
  appliedAt: Date;
  description: string;
}

export interface DatabaseStats {
  totalTables: number;
  totalRecords: number;
  databaseSize: number;
  lastVacuum: Date | null;
  indexCount: number;
  foreignKeyCount: number;
}

// ============= Schema Service Interface =============
export interface SchemaService {
  // Core schema operations
  readonly initializeDatabase: () => Effect.Effect<void, DatabaseError | QueryError>;
  readonly validateSchema: () => Effect.Effect<boolean, QueryError | ValidationError>;
  readonly getSchemaVersion: () => Effect.Effect<string | null, QueryError>;
  readonly setSchemaVersion: (version: string, description: string) => Effect.Effect<void, QueryError>;

  // Migration management
  readonly runMigrations: () => Effect.Effect<SchemaVersion[], DatabaseError | QueryError>;
  readonly rollbackMigration: (version: string) => Effect.Effect<void, DatabaseError | QueryError>;
  readonly getMigrationHistory: () => Effect.Effect<SchemaVersion[], QueryError>;
  readonly checkPendingMigrations: () => Effect.Effect<Migration[], QueryError>;

  // Table operations
  readonly createTable: (tableName: string, schema: string) => Effect.Effect<void, QueryError | ValidationError>;
  readonly dropTable: (tableName: string) => Effect.Effect<void, QueryError | ValidationError>;
  readonly tableExists: (tableName: string) => Effect.Effect<boolean, QueryError>;
  readonly getTableInfo: (tableName: string) => Effect.Effect<TableInfo | null, QueryError>;
  readonly getAllTables: () => Effect.Effect<string[], QueryError>;

  // Index management
  readonly createIndex: (
    indexName: string,
    tableName: string,
    columns: string[],
  ) => Effect.Effect<void, QueryError | ValidationError>;
  readonly dropIndex: (indexName: string) => Effect.Effect<void, QueryError>;
  readonly indexExists: (indexName: string) => Effect.Effect<boolean, QueryError>;
  readonly getAllIndexes: () => Effect.Effect<string[], QueryError>;

  // Database maintenance
  readonly vacuum: () => Effect.Effect<void, QueryError>;
  readonly analyze: () => Effect.Effect<void, QueryError>;
  readonly reindex: () => Effect.Effect<void, QueryError>;
  readonly checkIntegrity: () => Effect.Effect<boolean, QueryError | DataIntegrityError>;
  readonly getDatabaseStats: () => Effect.Effect<DatabaseStats, QueryError>;

  // Backup and restore
  readonly createBackup: (backupPath: string) => Effect.Effect<void, QueryError | ValidationError>;
  readonly restoreBackup: (backupPath: string) => Effect.Effect<void, QueryError | ValidationError>;
  readonly getBackupInfo: (backupPath: string) => Effect.Effect<{ size: number; createdAt: Date } | null, QueryError>;
}

export class SchemaServiceTag extends Context.Tag('SchemaService')<SchemaServiceTag, SchemaService>() {}

// ============= Migration Definitions =============
const MIGRATIONS: Migration[] = [
  {
    version: '1.0.0',
    description: 'Initial schema creation',
    up: [
      `CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS projects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS issues (
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
      )`,
      `CREATE TABLE IF NOT EXISTS searchable_content (
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
      )`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
        id,
        title,
        content
      )`,
      `CREATE TABLE IF NOT EXISTS boards (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        project_key TEXT,
        project_name TEXT,
        self_url TEXT,
        synced_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: '1.1.0',
    description: 'Add user workspace and sprint tracking',
    up: [
      `CREATE TABLE IF NOT EXISTS user_workspaces (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('jira_project', 'confluence_space')),
        name TEXT NOT NULL,
        key_or_id TEXT NOT NULL,
        usage_count INTEGER DEFAULT 1,
        last_used INTEGER NOT NULL,
        auto_sync INTEGER DEFAULT 0,
        synced_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS user_sprints (
        id INTEGER PRIMARY KEY,
        user_email TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        sprint_name TEXT,
        board_id INTEGER,
        project_key TEXT,
        last_accessed INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1,
        UNIQUE(user_email, sprint_id)
      )`,
    ],
  },
  {
    version: '1.2.0',
    description: 'Add AI memory and content hash tracking',
    up: [
      `CREATE TABLE IF NOT EXISTS ask_memory (
        id TEXT PRIMARY KEY,
        question_hash TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        relevant_doc_ids TEXT,
        confidence REAL DEFAULT 0.8,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER DEFAULT 1
      )`,
      `ALTER TABLE searchable_content ADD COLUMN content_hash TEXT`,
      `ALTER TABLE issues ADD COLUMN sprint_id TEXT`,
      `ALTER TABLE issues ADD COLUMN sprint_name TEXT`,
    ],
    checkCondition: (db) =>
      pipe(
        db.query<{ name: string }>(`PRAGMA table_info(searchable_content)`),
        Effect.map((columns) => !columns.some((col) => col.name === 'content_hash')),
      ),
  },
  {
    version: '1.3.0',
    description: 'Add sprint issues cache for performance',
    up: [
      `CREATE TABLE IF NOT EXISTS sprint_issues_cache (
        id INTEGER PRIMARY KEY,
        sprint_id TEXT NOT NULL,
        key TEXT NOT NULL,
        project_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        priority_order INTEGER DEFAULT 6,
        assignee_name TEXT,
        assignee_email TEXT,
        updated TEXT NOT NULL,
        cached_at INTEGER NOT NULL,
        UNIQUE(sprint_id, key)
      )`,
    ],
  },
  {
    version: '1.4.0',
    description: 'Add schema versioning table',
    up: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: '1.5.0',
    description: 'Create performance indexes',
    up: [
      `CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_key)`,
      `CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_email)`,
      `CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`,
      `CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id)`,
      `CREATE INDEX IF NOT EXISTS idx_content_source ON searchable_content(source)`,
      `CREATE INDEX IF NOT EXISTS idx_content_type ON searchable_content(source, type)`,
      `CREATE INDEX IF NOT EXISTS idx_content_space ON searchable_content(space_key)`,
      `CREATE INDEX IF NOT EXISTS idx_content_project ON searchable_content(project_key)`,
      `CREATE INDEX IF NOT EXISTS idx_content_synced ON searchable_content(synced_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_key)`,
      `CREATE INDEX IF NOT EXISTS idx_workspaces_type ON user_workspaces(type)`,
      `CREATE INDEX IF NOT EXISTS idx_workspaces_usage ON user_workspaces(usage_count DESC, last_used DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_sprints_user ON user_sprints(user_email, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_sprint_cache_sprint ON sprint_issues_cache(sprint_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ask_memory_hash ON ask_memory(question_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_ask_memory_accessed ON ask_memory(last_accessed DESC)`,
    ],
  },
];

// ============= Schema Service Implementation =============
class SchemaServiceImpl implements SchemaService {
  constructor(
    private db: DatabaseService,
    private logger: LoggerService,
  ) {}

  // ============= Core Schema Operations =============
  initializeDatabase(): Effect.Effect<void, DatabaseError | QueryError> {
    return pipe(
      this.logger.info('Initializing database schema'),
      Effect.flatMap(() => this.runMigrations()),
      Effect.flatMap(() => this.validateSchema() as Effect.Effect<boolean, QueryError | DatabaseError>),
      Effect.flatMap((isValid) => {
        if (!isValid) {
          return Effect.fail(new DatabaseError('Schema validation failed after initialization'));
        }
        return Effect.succeed(undefined);
      }),
      Effect.tap(() => this.logger.info('Database schema initialized successfully')),
      Effect.asVoid,
    );
  }

  validateSchema(): Effect.Effect<boolean, QueryError | ValidationError> {
    return pipe(
      this.logger.debug('Validating database schema'),
      Effect.flatMap(() => this.getAllTables()),
      Effect.flatMap((tables) => {
        const requiredTables = [
          'config',
          'projects',
          'issues',
          'searchable_content',
          'content_fts',
          'boards',
          'user_workspaces',
          'user_sprints',
          'ask_memory',
          'sprint_issues_cache',
          'schema_migrations',
        ];

        const missingTables = requiredTables.filter((table) => !tables.includes(table));

        if (missingTables.length > 0) {
          return Effect.fail(
            new ValidationError(`Missing required tables: ${missingTables.join(', ')}`, 'tables', tables),
          );
        }

        return Effect.succeed(true);
      }),
      Effect.tap(() => this.logger.debug('Schema validation completed successfully')),
    );
  }

  getSchemaVersion(): Effect.Effect<string | null, QueryError> {
    return pipe(
      this.tableExists('schema_migrations'),
      Effect.flatMap((exists) => {
        if (!exists) {
          return Effect.succeed(null);
        }

        return pipe(
          this.db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1'),
          Effect.map((rows) => rows[0]?.version || null),
        );
      }),
    );
  }

  setSchemaVersion(version: string, description: string): Effect.Effect<void, QueryError> {
    return pipe(
      this.db.execute('INSERT OR REPLACE INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)', [
        version,
        description,
        Date.now(),
      ]),
      Effect.asVoid,
    );
  }

  // ============= Migration Management =============
  runMigrations(): Effect.Effect<SchemaVersion[], DatabaseError | QueryError> {
    return pipe(
      this.logger.info('Starting database migrations'),
      Effect.flatMap(() => this.getSchemaVersion()),
      Effect.flatMap((currentVersion) => {
        const pendingMigrations = this.getPendingMigrations(currentVersion);

        if (pendingMigrations.length === 0) {
          return pipe(
            this.logger.debug('No pending migrations'),
            Effect.map(() => []),
          );
        }

        return pipe(
          this.logger.info('Applying migrations', { count: pendingMigrations.length }),
          Effect.flatMap(() => this.applyMigrations(pendingMigrations)),
        );
      }),
      Effect.tap((applied) => {
        if (applied.length > 0) {
          return this.logger.info('Migrations completed', { appliedCount: applied.length });
        }
        return Effect.succeed(undefined);
      }),
    );
  }

  rollbackMigration(version: string): Effect.Effect<void, DatabaseError | QueryError> {
    return pipe(
      this.logger.warn('Rolling back migration', { version }),
      Effect.flatMap(() => {
        const migration = MIGRATIONS.find((m) => m.version === version);
        if (!migration || !migration.down) {
          return Effect.fail(new DatabaseError(`No rollback available for migration ${version}`));
        }

        return this.db.transaction(
          pipe(
            Effect.forEach(migration.down, (sql) => this.db.execute(sql)),
            Effect.flatMap(() => this.db.execute('DELETE FROM schema_migrations WHERE version = ?', [version])),
            Effect.tap(() => this.logger.info('Migration rolled back', { version })),
          ),
        );
      }),
      Effect.asVoid,
    );
  }

  getMigrationHistory(): Effect.Effect<SchemaVersion[], QueryError> {
    return pipe(
      this.tableExists('schema_migrations'),
      Effect.flatMap((exists) => {
        if (!exists) {
          return Effect.succeed([]);
        }

        return pipe(
          this.db.query<{ version: string; description: string; applied_at: number }>(
            'SELECT version, description, applied_at FROM schema_migrations ORDER BY applied_at DESC',
          ),
          Effect.map((rows) =>
            rows.map((row) => ({
              version: row.version,
              description: row.description,
              appliedAt: new Date(row.applied_at),
            })),
          ),
        );
      }),
    );
  }

  checkPendingMigrations(): Effect.Effect<Migration[], QueryError> {
    return pipe(
      this.getSchemaVersion(),
      Effect.map((currentVersion) => this.getPendingMigrations(currentVersion)),
    );
  }

  // ============= Table Operations =============
  createTable(tableName: string, schema: string): Effect.Effect<void, QueryError | ValidationError> {
    return pipe(
      this.validateTableName(tableName),
      Effect.flatMap(() => this.validateSQL(schema)),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.debug('Creating table', { tableName }),
            Effect.flatMap(() => this.db.execute(schema)),
            Effect.tap(() => this.logger.info('Table created', { tableName })),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  dropTable(tableName: string): Effect.Effect<void, QueryError | ValidationError> {
    return pipe(
      this.validateTableName(tableName),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.warn('Dropping table', { tableName }),
            Effect.flatMap(() => this.db.execute(`DROP TABLE IF EXISTS ${tableName}`)),
            Effect.tap(() => this.logger.info('Table dropped', { tableName })),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  tableExists(tableName: string): Effect.Effect<boolean, QueryError> {
    return pipe(
      this.db.query<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', [
        'table',
        tableName,
      ]),
      Effect.map((rows) => rows.length > 0),
    );
  }

  getTableInfo(tableName: string): Effect.Effect<TableInfo | null, QueryError> {
    return pipe(
      this.tableExists(tableName),
      Effect.flatMap((exists) => {
        if (!exists) {
          return Effect.succeed(null);
        }

        return Effect.all({
          columns: this.getTableColumns(tableName),
          indexes: this.getTableIndexes(tableName),
          foreignKeys: this.getTableForeignKeys(tableName),
        }).pipe(
          Effect.map(({ columns, indexes, foreignKeys }) => ({
            name: tableName,
            columns,
            indexes,
            foreignKeys,
          })),
        );
      }),
    );
  }

  getAllTables(): Effect.Effect<string[], QueryError> {
    return pipe(
      this.db.query<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', ['table']),
      Effect.map((rows) => rows.map((row) => row.name)),
    );
  }

  // ============= Index Management =============
  createIndex(
    indexName: string,
    tableName: string,
    columns: string[],
  ): Effect.Effect<void, QueryError | ValidationError> {
    return pipe(
      this.validateIndexName(indexName),
      Effect.flatMap(() => this.validateTableName(tableName)),
      Effect.flatMap(() => {
        if (columns.length === 0) {
          return Effect.fail(new ValidationError('Index must have at least one column', 'columns', columns));
        }

        const sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columns.join(', ')})`;
        return pipe(
          this.db.execute(sql),
          Effect.mapError(() => new ValidationError('Failed to create index', 'sql', sql)),
        );
      }),
      Effect.tap(() => this.logger.debug('Index created', { indexName, tableName, columns })),
      Effect.asVoid,
    );
  }

  dropIndex(indexName: string): Effect.Effect<void, QueryError> {
    return pipe(
      this.db.execute(`DROP INDEX IF EXISTS ${indexName}`),
      Effect.tap(() => this.logger.debug('Index dropped', { indexName })),
      Effect.asVoid,
    );
  }

  indexExists(indexName: string): Effect.Effect<boolean, QueryError> {
    return pipe(
      this.db.query<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', [
        'index',
        indexName,
      ]),
      Effect.map((rows) => rows.length > 0),
    );
  }

  getAllIndexes(): Effect.Effect<string[], QueryError> {
    return pipe(
      this.db.query<{ name: string }>(
        'SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name',
        ['index', 'sqlite_%'],
      ),
      Effect.map((rows) => rows.map((row) => row.name)),
    );
  }

  // ============= Database Maintenance =============
  vacuum(): Effect.Effect<void, QueryError> {
    return pipe(
      this.logger.info('Starting database vacuum'),
      Effect.flatMap(() => this.db.execute('VACUUM')),
      Effect.tap(() => this.logger.info('Database vacuum completed')),
      Effect.asVoid,
    );
  }

  analyze(): Effect.Effect<void, QueryError> {
    return pipe(
      this.logger.debug('Analyzing database statistics'),
      Effect.flatMap(() => this.db.execute('ANALYZE')),
      Effect.tap(() => this.logger.debug('Database analysis completed')),
      Effect.asVoid,
    );
  }

  reindex(): Effect.Effect<void, QueryError> {
    return pipe(
      this.logger.info('Reindexing database'),
      Effect.flatMap(() => this.db.execute('REINDEX')),
      Effect.tap(() => this.logger.info('Database reindex completed')),
      Effect.asVoid,
    );
  }

  checkIntegrity(): Effect.Effect<boolean, QueryError | DataIntegrityError> {
    return pipe(
      this.logger.debug('Checking database integrity'),
      Effect.flatMap(() => this.db.query<{ integrity_check: string }>('PRAGMA integrity_check')),
      Effect.flatMap((rows) => {
        const result = rows[0]?.integrity_check;
        if (result === 'ok') {
          return pipe(
            this.logger.debug('Database integrity check passed'),
            Effect.map(() => true),
          );
        }

        return Effect.fail(
          new DataIntegrityError('Database integrity check failed', 'integrity_check', result || 'Unknown error'),
        );
      }),
    );
  }

  getDatabaseStats(): Effect.Effect<DatabaseStats, QueryError> {
    return Effect.all({
      totalTables: pipe(
        this.getAllTables(),
        Effect.map((tables) => tables.length),
      ),
      totalRecords: this.getTotalRecordCount(),
      databaseSize: this.getDatabaseSize(),
      lastVacuum: this.getLastVacuumTime(),
      indexCount: pipe(
        this.getAllIndexes(),
        Effect.map((indexes) => indexes.length),
      ),
      foreignKeyCount: this.getForeignKeyCount(),
    });
  }

  createBackup(backupPath: string): Effect.Effect<void, QueryError | ValidationError> {
    return pipe(
      this.validateBackupPath(backupPath),
      Effect.flatMap(() =>
        pipe(
          this.logger.info('Creating database backup', { backupPath }),
          Effect.flatMap(() => this.db.execute(`VACUUM INTO '${backupPath}'`)),
          Effect.tap(() => this.logger.info('Database backup created', { backupPath })),
        ),
      ),
      Effect.asVoid,
    );
  }

  restoreBackup(backupPath: string): Effect.Effect<void, QueryError | ValidationError> {
    return pipe(
      this.validateBackupPath(backupPath),
      Effect.flatMap(() =>
        Effect.fail(
          new ValidationError('Backup restore not supported in current implementation', 'backupPath', backupPath),
        ),
      ),
    );
  }

  getBackupInfo(_backupPath: string): Effect.Effect<{ size: number; createdAt: Date } | null, QueryError> {
    // This would require file system access, which we don't have in the database service
    return Effect.succeed(null);
  }

  // ============= Private Helper Methods =============
  private getPendingMigrations(currentVersion: string | null): Migration[] {
    if (!currentVersion) {
      return MIGRATIONS;
    }

    const currentIndex = MIGRATIONS.findIndex((m) => m.version === currentVersion);
    if (currentIndex === -1) {
      return MIGRATIONS; // All migrations if current version not found
    }

    return MIGRATIONS.slice(currentIndex + 1);
  }

  private applyMigrations(migrations: Migration[]): Effect.Effect<SchemaVersion[], DatabaseError | QueryError> {
    return pipe(
      Effect.forEach(migrations, (migration) =>
        pipe(
          this.checkMigrationCondition(migration),
          Effect.flatMap((shouldApply) => {
            if (!shouldApply) {
              return pipe(
                this.logger.debug('Skipping migration (condition not met)', { version: migration.version }),
                Effect.map((): SchemaVersion | null => null),
              );
            }

            return this.applyMigration(migration);
          }),
        ),
      ),
      Effect.map((results) => results.filter((result): result is SchemaVersion => result !== null)),
    );
  }

  private checkMigrationCondition(migration: Migration): Effect.Effect<boolean, QueryError> {
    if (!migration.checkCondition) {
      return Effect.succeed(true);
    }

    return migration.checkCondition(this.db);
  }

  private applyMigration(migration: Migration): Effect.Effect<SchemaVersion, DatabaseError | QueryError> {
    return this.db.transaction(
      pipe(
        this.logger.info('Applying migration', { version: migration.version, description: migration.description }),
        Effect.flatMap(() => Effect.forEach(migration.up, (sql) => this.db.execute(sql))),
        Effect.flatMap(() => this.setSchemaVersion(migration.version, migration.description)),
        Effect.map(
          (): SchemaVersion => ({
            version: migration.version,
            description: migration.description,
            appliedAt: new Date(),
          }),
        ),
        Effect.tap(() => this.logger.info('Migration applied', { version: migration.version })),
      ),
    );
  }

  private getTableColumns(tableName: string): Effect.Effect<TableColumn[], QueryError> {
    return pipe(
      this.db.query<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(`PRAGMA table_info(${tableName})`),
      Effect.map((rows) =>
        rows.map((row) => ({
          name: row.name,
          type: row.type,
          nullable: row.notnull === 0,
          defaultValue: row.dflt_value,
          primaryKey: row.pk === 1,
        })),
      ),
    );
  }

  private getTableIndexes(tableName: string): Effect.Effect<string[], QueryError> {
    return pipe(
      this.db.query<{ name: string }>(`PRAGMA index_list(${tableName})`),
      Effect.map((rows) => rows.map((row) => row.name)),
    );
  }

  private getTableForeignKeys(tableName: string): Effect.Effect<ForeignKey[], QueryError> {
    return pipe(
      this.db.query<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>(`PRAGMA foreign_key_list(${tableName})`),
      Effect.map((rows) =>
        rows.map((row) => ({
          column: row.from,
          referencedTable: row.table,
          referencedColumn: row.to,
        })),
      ),
    );
  }

  private getTotalRecordCount(): Effect.Effect<number, QueryError> {
    return pipe(
      this.getAllTables(),
      Effect.flatMap((tables) => {
        // Filter out virtual tables and system tables
        const dataTables = tables.filter(
          (table) => !table.startsWith('sqlite_') && !table.includes('_fts') && table !== 'schema_migrations',
        );

        return Effect.forEach(dataTables, (table) =>
          pipe(
            this.db.query<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`),
            Effect.map((rows) => rows[0]?.count || 0),
          ),
        );
      }),
      Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)),
    );
  }

  private getDatabaseSize(): Effect.Effect<number, QueryError> {
    return pipe(
      this.db.query<{ size: number }>(
        'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()',
      ),
      Effect.map((rows) => rows[0]?.size || 0),
    );
  }

  private getLastVacuumTime(): Effect.Effect<Date | null, QueryError> {
    // SQLite doesn't track vacuum time, so we return null
    return Effect.succeed(null);
  }

  private getForeignKeyCount(): Effect.Effect<number, QueryError> {
    return pipe(
      this.getAllTables(),
      Effect.flatMap((tables) => Effect.forEach(tables, (table) => this.getTableForeignKeys(table))),
      Effect.map((foreignKeyLists) => foreignKeyLists.reduce((sum, fks) => sum + fks.length, 0)),
    );
  }

  private validateTableName(tableName: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!tableName || tableName.length === 0) {
        throw new ValidationError('Table name cannot be empty', 'tableName', tableName);
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
        throw new ValidationError('Invalid table name format', 'tableName', tableName);
      }
    });
  }

  private validateIndexName(indexName: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!indexName || indexName.length === 0) {
        throw new ValidationError('Index name cannot be empty', 'indexName', indexName);
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(indexName)) {
        throw new ValidationError('Invalid index name format', 'indexName', indexName);
      }
    });
  }

  private validateSQL(sql: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!sql || sql.trim().length === 0) {
        throw new ValidationError('SQL cannot be empty', 'sql', sql);
      }
      // Basic SQL injection protection - in production, use a proper SQL parser
      const dangerous = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER'].some(
        (keyword) => sql.toUpperCase().includes(keyword) && !sql.toUpperCase().startsWith('CREATE'),
      );
      if (dangerous) {
        throw new ValidationError('SQL contains potentially dangerous operations', 'sql', sql);
      }
    });
  }

  private validateBackupPath(backupPath: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!backupPath || backupPath.length === 0) {
        throw new ValidationError('Backup path cannot be empty', 'backupPath', backupPath);
      }
      if (!backupPath.endsWith('.db') && !backupPath.endsWith('.sqlite')) {
        throw new ValidationError('Backup path must end with .db or .sqlite', 'backupPath', backupPath);
      }
    });
  }
}

// ============= Service Layer =============
export const SchemaServiceLive = Layer.effect(
  SchemaServiceTag,
  pipe(
    Effect.all({
      db: DatabaseServiceTag,
      logger: LoggerServiceTag,
    }),
    Effect.map(({ db, logger }) => new SchemaServiceImpl(db, logger)),
  ),
);

// ============= Helper Functions =============
// Use SchemaServiceLive directly with Effect.provide() when needed

// ============= Utility Functions =============
// These utility functions are meant to be used with a provided SchemaServiceLive
// Example: Effect.provide(SchemaServiceLive)(initializeJiDatabase())
export const initializeJiDatabase = () =>
  pipe(
    SchemaServiceTag,
    Effect.flatMap((schema: SchemaService) => schema.initializeDatabase()),
  );

export const runDatabaseMaintenance = () =>
  pipe(
    SchemaServiceTag,
    Effect.flatMap((schema: SchemaService) =>
      pipe(
        schema.checkIntegrity(),
        Effect.flatMap((isValid) => {
          if (!isValid) {
            return Effect.fail(new DataIntegrityError('Database integrity check failed', 'integrity', 'failed'));
          }
          return Effect.succeed(undefined);
        }),
        Effect.flatMap(() => schema.analyze()),
        Effect.flatMap(() => schema.vacuum()),
      ),
    ),
  );
