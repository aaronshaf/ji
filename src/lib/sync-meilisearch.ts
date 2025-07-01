#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { MeilisearchAdapter } from './meilisearch-adapter.js';

export async function syncToMeilisearch(options: { clean?: boolean } = {}) {
  const dbPath = join(homedir(), '.ji', 'data.db');
  const db = new Database(dbPath);
  const meilisearch = new MeilisearchAdapter();
  
  try {
    // Initialize Meilisearch
    await meilisearch.initialize();
    
    // Get counts
    const totalCount = db.prepare('SELECT COUNT(*) as count FROM searchable_content').get() as {count: number};
    
    // Clear existing data if requested
    if (options.clean) {
      process.stdout.write('Clearing index ');
      await meilisearch.clearIndex('jira');
      await meilisearch.clearIndex('confluence');
      console.log('✓');
    }
    
    // Sync in batches
    const batchSize = 1000; // Increased from 100 for much faster syncing
    let offset = 0;
    let totalSynced = 0;
    
    process.stdout.write(`Indexing `);
    
    while (offset < totalCount.count) {
      const items = db.prepare(`
        SELECT * FROM searchable_content 
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(batchSize, offset) as any[];
      
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
  syncToMeilisearch({ clean })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}