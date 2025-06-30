#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { MeiliSearch } from 'meilisearch';
import chalk from 'chalk';
import ora from 'ora';

async function syncSimple() {
  const dbPath = join(homedir(), '.ji', 'data.db');
  const db = new Database(dbPath);
  const client = new MeiliSearch({ host: 'http://localhost:7700' });
  
  try {
    console.log(chalk.bold('\n🔍 Syncing data to Meilisearch...\n'));
    
    // Get counts
    const totalCount = db.prepare('SELECT COUNT(*) as count FROM searchable_content').get() as {count: number};
    console.log(`Total documents to sync: ${chalk.cyan(totalCount.count.toString())}\n`);
    
    // Get indexes
    const jiraIndex = client.index('jira-issues');
    const confluenceIndex = client.index('confluence-pages');
    
    // Clear existing data
    const spinner = ora('Clearing existing data...').start();
    await jiraIndex.deleteAllDocuments();
    await confluenceIndex.deleteAllDocuments();
    spinner.succeed('Cleared existing data');
    
    // Sync in batches
    const batchSize = 100;
    let offset = 0;
    let totalSynced = 0;
    
    spinner.start('Syncing documents...');
    
    while (offset < totalCount.count) {
      const items = db.prepare(`
        SELECT * FROM searchable_content 
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(batchSize, offset) as any[];
      
      if (items.length === 0) break;
      
      const jiraDocs: any[] = [];
      const confluenceDocs: any[] = [];
      
      for (const item of items) {
        const doc = {
          id: item.id,
          key: item.id.replace(/^(jira|confluence):/, ''),
          title: item.title,
          content: item.content.substring(0, 50000),
          source: item.source,
          url: item.url,
          spaceKey: item.space_key,
          projectKey: item.project_key,
          updatedAt: item.updated_at || Date.now(),
          createdAt: item.created_at || Date.now(),
          syncedAt: item.synced_at,
          type: item.type,
          ...JSON.parse(item.metadata || '{}')
        };
        
        if (item.source === 'jira') {
          jiraDocs.push(doc);
        } else {
          confluenceDocs.push(doc);
        }
      }
      
      // Add documents
      if (jiraDocs.length > 0) {
        await jiraIndex.addDocuments(jiraDocs, { primaryKey: 'id' });
      }
      if (confluenceDocs.length > 0) {
        await confluenceIndex.addDocuments(confluenceDocs, { primaryKey: 'id' });
      }
      
      totalSynced += items.length;
      
      const percent = Math.round((totalSynced / totalCount.count) * 100);
      spinner.text = `Syncing documents... ${percent}% (${totalSynced}/${totalCount.count})`;
      
      offset += batchSize;
    }
    
    spinner.succeed(`Synced ${totalSynced} documents to Meilisearch`);
    
    // Update settings after documents are added
    spinner.start('Configuring search settings...');
    
    await jiraIndex.updateSettings({
      searchableAttributes: ['key', 'title', 'content', 'summary', 'description'],
      filterableAttributes: ['status', 'priority', 'assignee', 'projectKey', 'source', 'reporter'],
      sortableAttributes: ['updatedAt', 'createdAt'],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 3,
          twoTypos: 6
        }
      }
    });
    
    await confluenceIndex.updateSettings({
      searchableAttributes: ['title', 'content', 'spaceKey'],
      filterableAttributes: ['spaceKey', 'source', 'type'],
      sortableAttributes: ['updatedAt', 'createdAt'],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 3,
          twoTypos: 6
        }
      }
    });
    
    spinner.succeed('Search settings configured');
    
    // Show stats
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for indexing
    
    const jiraStats = await jiraIndex.getStats();
    const confluenceStats = await confluenceIndex.getStats();
    
    console.log(chalk.green('\n✅ Sync complete!\n'));
    console.log('📊 Meilisearch Statistics:');
    console.log(`   Jira issues: ${chalk.cyan(jiraStats.numberOfDocuments.toString())}`);
    console.log(`   Confluence pages: ${chalk.cyan(confluenceStats.numberOfDocuments.toString())}`);
    
  } catch (error) {
    console.error(chalk.red('\n❌ Sync failed:'), error);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run
syncSimple();