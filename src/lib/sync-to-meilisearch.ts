#!/usr/bin/env bun
import { ContentManager } from './content-manager.js';
import { MeilisearchAdapter } from './meilisearch-adapter.js';
import chalk from 'chalk';
import ora from 'ora';

export async function syncToMeilisearch() {
  const contentManager = new ContentManager();
  const meilisearch = new MeilisearchAdapter();
  
  try {
    console.log(chalk.bold('\n🔍 Syncing data to Meilisearch...\n'));
    
    // Get counts
    const totalCount = contentManager.db.prepare('SELECT COUNT(*) as count FROM searchable_content').get() as {count: number};
    console.log(`Total documents to sync: ${chalk.cyan(totalCount.count.toString())}\n`);
    
    // Initialize Meilisearch
    const spinner = ora('Initializing Meilisearch indexes...').start();
    await meilisearch.initialize();
    spinner.succeed('Meilisearch indexes initialized');
    
    // Clear existing data
    spinner.start('Clearing existing Meilisearch data...');
    await Promise.all([
      meilisearch.clearIndex('jira'),
      meilisearch.clearIndex('confluence')
    ]);
    spinner.succeed('Cleared existing data');
    
    // Sync in batches
    const batchSize = 100;
    let offset = 0;
    let totalSynced = 0;
    
    spinner.start('Syncing documents...');
    
    while (offset < totalCount.count) {
      const items = contentManager.db.prepare(`
        SELECT * FROM searchable_content 
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(batchSize, offset) as any[];
      
      if (items.length === 0) break;
      
      // Convert to SearchableContent format
      const contents = items.map(item => ({
        id: item.id,
        source: item.source,
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
      
      // Index batch
      await meilisearch.indexBatch(contents);
      totalSynced += items.length;
      
      const percent = Math.round((totalSynced / totalCount.count) * 100);
      spinner.text = `Syncing documents... ${percent}% (${totalSynced}/${totalCount.count})`;
      
      offset += batchSize;
    }
    
    spinner.succeed(`Synced ${totalSynced} documents to Meilisearch`);
    
    // Wait for indexing to complete
    spinner.start('Waiting for indexing to complete...');
    await meilisearch.waitForIndexing();
    spinner.succeed('Indexing complete');
    
    // Show stats
    const stats = await meilisearch.getStats();
    console.log(chalk.green('\n✅ Sync complete!\n'));
    console.log('📊 Meilisearch Statistics:');
    console.log(`   Jira issues: ${chalk.cyan(stats.jira.numberOfDocuments.toString())}`);
    console.log(`   Confluence pages: ${chalk.cyan(stats.confluence.numberOfDocuments.toString())}`);
    
  } catch (error) {
    console.error(chalk.red('\n❌ Sync failed:'), error);
    process.exit(1);
  } finally {
    contentManager.close();
  }
}

// Run if called directly
if (import.meta.main) {
  syncToMeilisearch();
}