#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { Schema } from 'effect';

const MEILISEARCH_URL = 'http://localhost:7700';

async function directSync() {
  const dbPath = join(homedir(), '.ji', 'data.db');
  const db = new Database(dbPath);
  
  try {
    console.log(chalk.bold('\n🔍 Testing Meilisearch direct sync...\n'));
    
    // Create indexes
    console.log('Creating indexes...');
    await fetch(`${MEILISEARCH_URL}/indexes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'jira-issues', primaryKey: 'id' })
    }).catch(() => {});
    
    await fetch(`${MEILISEARCH_URL}/indexes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'confluence-pages', primaryKey: 'id' })
    }).catch(() => {});
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Get sample data using Effect Schema for runtime validation
    const SearchableItem = Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      content: Schema.String,
      source: Schema.String,
      updated_at: Schema.Number,
    });
    
    const rawItems = db.prepare(`
      SELECT * FROM searchable_content 
      WHERE content LIKE '%xsslint%' OR title LIKE '%xsslint%'
      LIMIT 10
    `).all();
    
    const items = rawItems.map(item => Schema.decodeUnknownSync(SearchableItem)(item));
    
    console.log(`Found ${items.length} items containing 'xsslint'`);
    
    if (items.length === 0) {
      // Get any sample data
      const rawSampleItems = db.prepare(`
        SELECT * FROM searchable_content 
        ORDER BY updated_at DESC
        LIMIT 10
      `).all();
      
      const sampleItems = rawSampleItems.map(item => Schema.decodeUnknownSync(SearchableItem)(item));
      
      console.log(`No items with 'xsslint' found. Adding ${sampleItems.length} sample documents...`);
      
      for (const item of sampleItems) {
        const doc = {
          id: item.id,
          key: item.id.replace(/^(jira|confluence):/, ''),
          title: item.title,
          content: item.content.substring(0, 10000),
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
        
        const index = item.source === 'jira' ? 'jira-issues' : 'confluence-pages';
        
        const response = await fetch(`${MEILISEARCH_URL}/indexes/${index}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([doc])
        });
        
        if (!response.ok) {
          console.error(`Failed to add document: ${response.status} ${response.statusText}`);
          const text = await response.text();
          console.error(text);
        } else {
          console.log(`Added: ${doc.title.substring(0, 50)}...`);
        }
      }
    }
    
    // Wait for indexing
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test search
    console.log('\nTesting search for "websocket"...');
    const searchResponse = await fetch(`${MEILISEARCH_URL}/indexes/jira-issues/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: 'websocket',
        limit: 5
      })
    });
    
    if (searchResponse.ok) {
      const results = await searchResponse.json() as { hits: Array<{ title: string }> };
      console.log(`Found ${results.hits.length} results:`);
      results.hits.forEach((hit: any) => {
        console.log(`- ${hit.title}`);
      });
    } else {
      console.error('Search failed:', searchResponse.status, searchResponse.statusText);
    }
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error);
  } finally {
    db.close();
  }
}

directSync();