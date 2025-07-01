#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { MeilisearchAdapter } from './meilisearch-adapter.js';
import chalk from 'chalk';
import ora from 'ora';

export async function syncToMeilisearch(options: { clean?: boolean } = {}) {
  const dbPath = join(homedir(), '.ji', 'data.db');
  const db = new Database(dbPath);
  const meilisearch = new MeilisearchAdapter();
  
  try {
    console.log(chalk.bold('\n🔍 Syncing data to Meilisearch...\n'));
    
    // Initialize Meilisearch
    await meilisearch.initialize();
    
    // Get counts
    const totalCount = db.prepare('SELECT COUNT(*) as count FROM searchable_content').get() as {count: number};
    console.log(`Total documents to sync: ${chalk.cyan(totalCount.count.toString())}\n`);
    
    // Clear existing data if requested
    if (options.clean) {
      const spinner = ora('Clearing existing data...').start();
      await meilisearch.clearIndex('jira');
      await meilisearch.clearIndex('confluence');
      spinner.succeed('Cleared existing data');
    }
    
    // Check current stats
    const statsBefore = await meilisearch.getStats();
    console.log('Current Meilisearch documents:');
    console.log(`  Jira: ${chalk.yellow(statsBefore.jira.numberOfDocuments.toString())}`);
    console.log(`  Confluence: ${chalk.yellow(statsBefore.confluence.numberOfDocuments.toString())}\n`);
    
    // Sync in batches
    const batchSize = 1000; // Increased from 100 for much faster syncing
    let offset = 0;
    let totalSynced = 0;
    
    const spinner = ora('Syncing documents...').start();
    
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
      
      const percent = Math.round((totalSynced / totalCount.count) * 100);
      spinner.text = `Syncing documents... ${percent}% (${totalSynced}/${totalCount.count})`;
      
      offset += batchSize;
    }
    
    spinner.succeed(`Synced ${totalSynced} documents to Meilisearch`);
    
    // Wait for indexing to complete
    spinner.start('Finalizing search index...');
    await meilisearch.waitForIndexing();
    spinner.succeed('Search index ready!');
    
    // Show final stats
    const statsAfter = await meilisearch.getStats();
    console.log(chalk.green('\n✅ Sync complete!\n'));
    console.log('📊 Meilisearch Statistics:');
    console.log(`   Jira issues: ${chalk.cyan(statsAfter.jira.numberOfDocuments.toString())}`);
    console.log(`   Confluence pages: ${chalk.cyan(statsAfter.confluence.numberOfDocuments.toString())}`)
    
  } catch (error) {
    console.error(chalk.red('\n❌ Sync failed:'), error);
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