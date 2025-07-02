#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { MeilisearchAdapter } from './meilisearch-adapter.js';
import { Effect } from 'effect';

export async function syncToMeilisearch(options: { clean?: boolean } = {}): Promise<{ indexedItems: number }> {
  const dbPath = join(homedir(), '.ji', 'data.db');
  const db = new Database(dbPath);
  const meilisearch = new MeilisearchAdapter();
  
  try {
    // Initialize Meilisearch
    await meilisearch.initialize();
    
    // Get last index sync time
    const lastSyncResult = db.prepare('SELECT value FROM config WHERE key = ?').get('last_meilisearch_sync') as { value: string } | undefined;
    const lastSyncTime = lastSyncResult ? parseInt(lastSyncResult.value) : 0;
    
    // Clear existing data if requested
    if (options.clean) {
      process.stdout.write('Clearing index ');
      await meilisearch.clearIndex('jira');
      await meilisearch.clearIndex('confluence');
      console.log('✓');
    }
    
    // Get items that need indexing
    let query: string;
    let params: any[];
    
    if (options.clean || lastSyncTime === 0) {
      // Full sync
      query = 'SELECT COUNT(*) as count FROM searchable_content';
      params = [];
    } else {
      // Incremental sync - only items updated since last index sync
      query = 'SELECT COUNT(*) as count FROM searchable_content WHERE synced_at > ?';
      params = [lastSyncTime];
    }
    
    const totalCount = db.prepare(query).get(...params) as {count: number};
    
    if (totalCount.count === 0) {
      console.log('Index: up to date');
      return { indexedItems: 0 };
    }
    
    // Sync in batches
    const batchSize = 1000;
    let offset = 0;
    let totalSynced = 0;
    
    process.stdout.write(`Indexing `);
    
    const selectQuery = options.clean || lastSyncTime === 0
      ? 'SELECT * FROM searchable_content ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM searchable_content WHERE synced_at > ? ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    
    while (offset < totalCount.count) {
      const queryParams = options.clean || lastSyncTime === 0
        ? [batchSize, offset]
        : [lastSyncTime, batchSize, offset];
        
      const items = db.prepare(selectQuery).all(...queryParams) as any[];
      
      if (items.length === 0) break;
      
      const contents = items.map(item => ({
        id: item.id,
        source: item.source as 'jira' | 'confluence',
        type: item.type,
        title: item.title,
        content: item.content,
        url: item.url,
        spaceKey: item.space_key,
        projectKey: item.project_key,
        metadata: JSON.parse(item.metadata || '{}'),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        syncedAt: item.synced_at
      }));
      
      await meilisearch.indexBatch(contents);
      
      totalSynced += items.length;
      process.stdout.write('.');
      
      offset += batchSize;
    }
    
    // Wait for indexing to complete
    await meilisearch.waitForIndexing();
    console.log(` ${totalSynced}`);
    
    // Update last sync time
    const now = Date.now();
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('last_meilisearch_sync', now.toString());
    
    return { indexedItems: totalSynced };
  } catch (error) {
    console.error(` ❌`);
    throw error;
  } finally {
    db.close();
  }
}

// If running directly
if (import.meta.main) {
  const clean = process.argv.includes('--clean');
  Effect.runPromise(
    Effect.tryPromise({
      try: () => syncToMeilisearch({ clean }),
      catch: () => 1,
    })
  ).then((exitCode: unknown) => process.exit(exitCode as number));
}