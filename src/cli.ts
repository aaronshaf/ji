#!/usr/bin/env bun
import { parseArgs } from "util";
import { ConfigManager } from './lib/config.js';
import { JiraClient } from './lib/jira-client.js';
import { CacheManager } from './lib/cache.js';
import { ContentManager } from './lib/content-manager.js';
import { EmbeddingManager, type SearchResult } from './lib/embeddings.js';
import { ConfluenceClient } from './lib/confluence-client.js';
import { confluenceToText } from './lib/confluence-converter.js';
import { OllamaClient } from './lib/ollama.js';
import { MemoryManager } from './lib/memory.js';
import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

async function auth() {
  const rl = readline.createInterface({ input, output });

  try {
    const jiraUrl = await rl.question('Jira URL (e.g., https://company.atlassian.net): ');
    const email = await rl.question('Email: ');
    const apiToken = await rl.question('API Token: ');

    const config = {
      jiraUrl: jiraUrl.endsWith('/') ? jiraUrl.slice(0, -1) : jiraUrl,
      email,
      apiToken,
    };

    // Test the authentication
    console.log('\nVerifying credentials...');
    const client = new JiraClient(config);
    
    try {
      // Test API call - get current user
      const response = await fetch(`${config.jiraUrl}/rest/api/3/myself`, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      const user = await response.json();
      // Type guard for the user object
      if (typeof user === 'object' && user !== null && 'displayName' in user && 'emailAddress' in user) {
        console.log(chalk.green(`Successfully authenticated as ${user.displayName} (${user.emailAddress})`));
      } else {
        console.log(chalk.green('Successfully authenticated'));
      }

      // Save config after successful verification
      const configManager = new ConfigManager();
      await configManager.setConfig(config);
      configManager.close();

      console.log(chalk.green('\nAuthentication saved successfully!'));
      console.log('You can now use "ji issue view <issue-key>" to view issues.');
    } catch (error) {
      console.error(`\nAuthentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('Please check your credentials and try again.');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function viewIssue(issueKey: string, options: { json?: boolean, sync?: boolean }) {
  const configManager = new ConfigManager();
  const cacheManager = new CacheManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  try {
    let issue = null;
    let fromCache = false;
    
    // Try cache first unless --sync is specified
    if (!options.sync) {
      issue = await cacheManager.getIssue(issueKey);
      if (issue) {
        fromCache = true;
      }
    }
    
    // If no cached data or --sync, fetch from API
    if (!issue) {
      const client = new JiraClient(config);
      issue = await client.getIssue(issueKey);
      await cacheManager.saveIssue(issue);
      fromCache = false;
    }

    // Display the issue
    if (options.json) {
      console.log(JSON.stringify(issue, null, 2));
    } else {
      console.log(`\n${chalk.bold(issue.key)}: ${issue.fields.summary}`);
      console.log(`\n${chalk.dim('Status:')} ${issue.fields.status.name}`);
      if (issue.fields.priority) {
        console.log(`${chalk.dim('Priority:')} ${issue.fields.priority.name}`);
      }
      if (issue.fields.assignee) {
        console.log(`${chalk.dim('Assignee:')} ${issue.fields.assignee.displayName}`);
      }
      console.log(`${chalk.dim('Reporter:')} ${issue.fields.reporter.displayName}`);
      console.log(`${chalk.dim('Created:')} ${new Date(issue.fields.created).toLocaleString()}`);
      console.log(`${chalk.dim('Updated:')} ${new Date(issue.fields.updated).toLocaleString()}`);
      
      if (issue.fields.description) {
        console.log(`\n${chalk.dim('Description:')}`);
        console.log(formatDescription(issue.fields.description));
      }
    }

    // Background refresh if we showed cached data
    if (fromCache && !options.sync) {
      // Spawn a detached process for background refresh
      const proc = Bun.spawn(['bun', 'run', process.argv[1], 'internal-refresh', issueKey], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          JI_CONFIG: JSON.stringify(config)
        }
      });
      proc.unref();
    }
  } catch (error) {
    console.error(`Failed to fetch issue: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    cacheManager.close();
  }
}

async function refreshInBackground(issueKey: string, config: any) {
  const cacheManager = new CacheManager();
  try {
    const client = new JiraClient(config);
    const freshIssue = await client.getIssue(issueKey);
    await cacheManager.saveIssue(freshIssue);
  } catch (error) {
    // Silently fail - this is a background refresh
    // Don't log to console since we're in a detached process
  } finally {
    cacheManager.close();
  }
}

function formatDescription(description: any): string {
  if (typeof description === 'string') {
    return description;
  }
  
  // Handle Atlassian Document Format (ADF)
  if (description?.content) {
    return parseADF(description);
  }
  
  return 'No description available';
}

function parseADF(doc: any): string {
  let text = '';
  
  const parseNode = (node: any): string => {
    if (node.type === 'text') {
      return node.text || '';
    }
    
    if (node.content) {
      return node.content.map((n: any) => parseNode(n)).join('');
    }
    
    if (node.type === 'paragraph') {
      return '\n' + (node.content?.map((n: any) => parseNode(n)).join('') || '') + '\n';
    }
    
    return '';
  };
  
  if (doc.content) {
    text = doc.content.map((node: any) => parseNode(node)).join('');
  }
  
  return text.trim();
}

function getJiraStatusIcon(status: string): string {
  const lowerStatus = status.toLowerCase();
  if (lowerStatus === 'done' || lowerStatus === 'closed' || lowerStatus === 'resolved') return '✅';
  if (lowerStatus === 'in progress' || lowerStatus === 'in development') return '🔄';
  if (lowerStatus === 'blocked') return '🚫';
  if (lowerStatus === 'feedback' || lowerStatus === 'review') return '👀';
  if (lowerStatus === 'todo' || lowerStatus === 'open' || lowerStatus === 'new') return '📋';
  return '🔵';
}

async function saveIssuesBatch(
  issues: any[], 
  cacheManager: CacheManager, 
  contentManager: ContentManager
): Promise<void> {
  const startTime = Date.now();
  let lastUpdateTime = Date.now();
  const updateInterval = 100;
  
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    
    // Update progress UI at intervals
    const now = Date.now();
    if (now - lastUpdateTime >= updateInterval || i === issues.length - 1) {
      const percent = Math.round(((i + 1) / issues.length) * 100);
      const progressBar = createProgressBar(percent, 20); // Smaller progress bar
      
      // Keep output under 80 chars
      const statusLine = `💾 ${progressBar} ${percent}% | ${issue.key}`;
      
      // Clear the line and write new status
      process.stdout.write('\r' + ' '.repeat(80) + '\r' + statusLine);
      lastUpdateTime = now;
    }
    
    try {
      await cacheManager.saveIssue(issue);
      await contentManager.saveJiraIssue(issue);
    } catch (error: any) {
      if (error.message?.includes('database is locked')) {
        // Wait and retry
        await new Promise(resolve => setTimeout(resolve, 200));
        try {
          await cacheManager.saveIssue(issue);
          await contentManager.saveJiraIssue(issue);
        } catch (retryError: any) {
          console.error(`\n❌ Failed to save ${issue.key} after retry: ${retryError.message}`);
          throw retryError;
        }
      } else {
        console.error(`\n❌ Failed to save ${issue.key}: ${error.message}`);
        throw error;
      }
    }
  }
  
  console.log(''); // New line after progress
}

async function showMyIssues() {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const cacheManager = new CacheManager();
  
  try {
    const issues = await cacheManager.listMyOpenIssues(config.email);
    
    if (issues.length === 0) {
      console.log('No open issues assigned to you.');
      return;
    }
    
    // Group by project
    const byProject: Record<string, typeof issues> = {};
    issues.forEach(issue => {
      if (!byProject[issue.project_key]) {
        byProject[issue.project_key] = [];
      }
      byProject[issue.project_key].push(issue);
    });
    
    // Display by project
    const projectEntries = Object.entries(byProject);
    projectEntries.forEach(([projectKey, projectIssues], index) => {
      console.log(chalk.bold.blue(`${projectKey} (${projectIssues.length} issues):`));
      
      projectIssues.forEach(issue => {
        const statusIcon = getJiraStatusIcon(issue.status);
        const updated = new Date(issue.updated);
        const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
        const timeStr = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;
        
        console.log(`  ${statusIcon} ${chalk.bold(issue.key)}: ${issue.summary}`);
        console.log(`     ${chalk.dim(`Updated ${timeStr} • Priority: ${issue.priority || 'None'}`)}`);
      });
      
      // Only add blank line between projects, not after the last one
      if (index < projectEntries.length - 1) {
        console.log();
      }
    });
    
  } catch (error) {
    console.error(`Failed to retrieve issues: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    cacheManager.close();
    configManager.close();
  }
}

async function search(query: string, options: { 
  semantic?: boolean, 
  source?: 'jira' | 'confluence',
  limit?: number,
  includeAll?: boolean
}) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  try {
    const embeddingManager = new EmbeddingManager();
    
    let results;
    if (options.semantic) {
      results = await embeddingManager.searchSemantic(query, {
        source: options.source,
        limit: options.limit,
        includeAll: options.includeAll
      });
    } else {
      results = await embeddingManager.hybridSearch(query, {
        source: options.source,
        limit: options.limit,
        includeAll: options.includeAll
      });
    }

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`\nFound ${results.length} results:\n`);

    for (const result of results) {
      const { content, score, snippet } = result;
      
      // Add visual indicator for type
      const scorePercent = Math.round(score * 100);
      const scoreDisplay = chalk.gray(`[${scorePercent}%]`);
      
      if (content.source === 'jira') {
        const statusIcon = getJiraStatusIcon(content.metadata?.status || '');
        console.log(statusIcon + ' ' + chalk.bold(content.title) + ' ' + scoreDisplay);
      } else if (content.source === 'confluence') {
        console.log('📄 ' + chalk.bold(content.title) + ' ' + scoreDisplay);
      } else {
        console.log(chalk.bold(content.title) + ' ' + scoreDisplay);
      }
      
      // Build metadata line based on content source
      if (content.source === 'jira') {
        const parts = [];
        if (content.metadata?.status) parts.push(`Status: ${content.metadata.status}`);
        if (content.metadata?.priority && content.metadata.priority !== 'None') parts.push(`Priority: ${content.metadata.priority}`);
        if (content.metadata?.assignee) parts.push(`Assignee: ${content.metadata.assignee}`);
        if (parts.length > 0) {
          console.log(chalk.dim(`  ${parts.join(' | ')}`));
        }
      } else if (content.source === 'confluence') {
        const parts = [];
        if (content.metadata?.spaceName) parts.push(`Space: ${content.metadata.spaceName}`);
        if (content.metadata?.lastModified) {
          const date = new Date(content.metadata.lastModified);
          parts.push(`Modified: ${date.toLocaleDateString()}`);
        }
        if (parts.length > 0) {
          console.log(chalk.dim(`  ${parts.join(' | ')}`));
        }
      }
      
      // Show content preview
      if (content.source === 'jira') {
        // The content is structured with metadata first, then description
        const contentLines = content.content.split('\n');
        let inDescription = false;
        let descriptionLine = '';
        
        for (const line of contentLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          // Skip metadata lines
          if (trimmed.startsWith('Status:') || 
              trimmed.startsWith('Priority:') || 
              trimmed.startsWith('Assignee:') || 
              trimmed.startsWith('Reporter:')) {
            continue;
          }
          
          // Skip the summary line (which is the title without the issue key)
          const summaryPart = content.title.split(': ')[1]; // Get part after "ISSUE-123: "
          if (summaryPart && trimmed === summaryPart) {
            continue;
          }
          
          // This should be the description
          descriptionLine = trimmed;
          break;
        }
        
        if (descriptionLine && descriptionLine.length > 0) {
          if (descriptionLine.length > 80) {
            console.log(`  ${descriptionLine.substring(0, 80)}...`);
          } else {
            console.log(`  ${descriptionLine}`);
          }
        }
      } else if (content.source === 'confluence') {
        // For Confluence, show first non-empty line of content
        const firstLine = content.content.split('\n').find(line => line.trim().length > 0);
        if (firstLine && firstLine.trim().length > 0) {
          const preview = firstLine.trim();
          if (preview.length > 80) {
            console.log(chalk.dim(`  ${preview.substring(0, 80)}...`));
          } else {
            console.log(chalk.dim(`  ${preview}`));
          }
        }
      }
      console.log('');
    }

    embeddingManager.close();
  } catch (error) {
    console.error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
  }
}

async function embedContent(contentId: string) {
  const contentManager = new ContentManager();
  const embeddingManager = new EmbeddingManager();
  
  try {
    // Get content from database
    const results = await contentManager.searchContent(`id:${contentId}`, { limit: 1 });
    if (results.length === 0) {
      console.error(`Content not found: ${contentId}`);
      return;
    }

    const content = results[0];
    await embeddingManager.embedContent(content);
  } catch (error) {
    // Silent fail for background process
  } finally {
    contentManager.close();
    embeddingManager.close();
  }
}

async function generateEmbeddingsInBackground() {
  const contentManager = new ContentManager();
  const ollama = new OllamaClient();
  
  try {
    // Check if Ollama is available
    if (!await ollama.isAvailable()) {
      return;
    }
    
    // Get content needing embeddings
    const items = await contentManager.getContentNeedingEmbeddings(50);
    
    if (items.length === 0) {
      return;
    }
    
    console.log(`\n🧠 Updating embeddings in background...`);
    
    // Spawn a background process to generate embeddings
    const proc = Bun.spawn(['bun', 'run', process.argv[1], 'internal-embed-batch'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env }
    });
    
    proc.unref();
  } finally {
    contentManager.close();
  }
}

async function generateEmbeddingsBatch() {
  const contentManager = new ContentManager();
  const ollama = new OllamaClient();
  
  try {
    const items = await contentManager.getContentNeedingEmbeddings(100);
    
    let processed = 0;
    for (const item of items) {
      const embedding = await ollama.generateEmbedding(item.content);
      if (embedding) {
        await contentManager.saveEmbedding(item.id, embedding, item.content_hash);
        processed++;
      }
    }
  } finally {
    contentManager.close();
  }
}

async function regenerateAllEmbeddings() {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const contentManager = new ContentManager();
  const ollama = new OllamaClient();
  
  try {
    // Check if Ollama is available
    if (!await ollama.isAvailable()) {
      console.error('❌ Ollama is not available. Please start Ollama and install mxbai-embed-large.');
      process.exit(1);
    }
    
    // Get total count
    const totalCount = contentManager.db.prepare('SELECT COUNT(*) as count FROM searchable_content').get() as {count: number};
    console.log(`\n🧠 Regenerating embeddings for ${totalCount.count} items...\n`);
    
    // Clear existing embeddings
    contentManager.db.run('DELETE FROM content_embeddings');
    console.log('🧹 Cleared old embeddings\n');
    
    // Process in batches
    let offset = 0;
    const batchSize = 50;
    let totalProcessed = 0;
    
    while (offset < totalCount.count) {
      const items = contentManager.db.prepare(`
        SELECT id, content, content_hash 
        FROM searchable_content 
        LIMIT ? OFFSET ?
      `).all(batchSize, offset) as Array<{id: string, content: string, content_hash: string}>;
      
      if (items.length === 0) break;
      
      const batchNum = Math.floor(offset / batchSize) + 1;
      
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const embedding = await ollama.generateEmbedding(item.content);
        
        if (embedding) {
          await contentManager.saveEmbedding(item.id, embedding, item.content_hash || '');
          totalProcessed++;
        }
        
        // Update progress
        const percent = Math.round(((offset + i + 1) / totalCount.count) * 100);
        const progressBar = createProgressBar(percent, 20);
        const statusLine = `🧠 ${progressBar} ${percent}% | ${offset + i + 1}/${totalCount.count} | Batch ${batchNum}`;
        process.stdout.write('\r' + ' '.repeat(80) + '\r' + statusLine);
      }
      
      offset += batchSize;
    }
    
    console.log(); // New line after progress
    console.log(chalk.green(`\n✅ Successfully generated ${totalProcessed} embeddings!\n`));
    console.log(`💡 You can now use semantic search:`);
    console.log(`   ${chalk.cyan('ji search --semantic "your query"')}\n`);
    
  } catch (error) {
    console.error(`\n❌ Failed to generate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    contentManager.close();
  }
}

async function syncJiraProject(projectKey: string, options: { fresh?: boolean } = {}) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const jiraClient = new JiraClient(config);
  const cacheManager = new CacheManager();
  const contentManager = new ContentManager();

  try {
    console.log(`\n🔍 Syncing Jira project ${chalk.bold.blue(projectKey)}...\n`);
    
    // If --clean flag is set, delete existing issues first
    if (options.fresh) {
      console.log(chalk.yellow('🧹 Clearing existing issues for clean sync...\n'));
      await cacheManager.deleteProjectIssues(projectKey);
    }
    
    // Get our current sync state
    const existingIssues = await cacheManager.listIssuesByProject(projectKey);
    const existingCount = existingIssues.length;
    
    if (existingCount === 0) {
      console.log(`📋 First sync - fetching newest issues first...\n`);
    } else {
      console.log(`📊 Issues in database: ${chalk.dim(existingCount.toString())}`);
      
      // Find newest and oldest modified dates
      let newestModified = new Date(0);
      let oldestModified = new Date();
      
      existingIssues.forEach(issue => {
        const updated = new Date(issue.updated);
        if (updated > newestModified) newestModified = updated;
        if (updated < oldestModified) oldestModified = updated;
      });
      
      console.log(`📅 Newest: ${chalk.dim(newestModified.toLocaleString())}`);
      console.log(`📅 Oldest: ${chalk.dim(oldestModified.toLocaleString())}\n`);
    }
    
    const startTime = Date.now();
    const batchSize = 100;
    let totalSynced = 0;
    
    // Helper to format JQL date
    const formatJqlDate = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}/${month}/${day} ${hours}:${minutes}`;
    };
    
    // If we have existing issues, check for newer ones first
    if (existingCount > 0) {
      const newestModified = existingIssues.reduce((max, issue) => {
        const updated = new Date(issue.updated);
        return updated > max ? updated : max;
      }, new Date(0));
      
      const newerJql = `project = ${projectKey} AND updated > "${formatJqlDate(newestModified)}" ORDER BY updated DESC`;
      
      // Check how many newer issues exist
      const newerCount = await jiraClient.searchIssues(newerJql, { maxResults: 0 });
      
      if (newerCount.total > 0) {
        console.log(`🆕 Found ${newerCount.total} newer issues to sync...\n`);
        
        // Fetch all newer issues (they're recent, so shouldn't be too many)
        let startAt = 0;
        while (startAt < newerCount.total) {
          const batch = await jiraClient.searchIssues(newerJql, { startAt, maxResults: batchSize });
          
          if (batch.issues.length > 0) {
            await saveIssuesBatch(batch.issues, cacheManager, contentManager);
            totalSynced += batch.issues.length;
          }
          
          startAt += batchSize;
        }
      }
    }
    
    // Now work backwards from either the oldest we have, or from newest if first sync
    let continueSync = true;
    let currentOldest = existingCount > 0 
      ? existingIssues.reduce((min, issue) => {
          const updated = new Date(issue.updated);
          return updated < min ? updated : min;
        }, new Date())
      : new Date(); // Start from now if first sync
    
    while (continueSync) {
      // Get batch of issues older than our current oldest
      const olderJql = `project = ${projectKey} AND updated < "${formatJqlDate(currentOldest)}" ORDER BY updated DESC`;
      
      const batch = await jiraClient.searchIssues(olderJql, { startAt: 0, maxResults: batchSize });
      
      if (batch.issues.length === 0) {
        // No more older issues
        continueSync = false;
        break;
      }
      
      console.log(`📦 Fetching batch: ${batch.issues.length} issues older than ${currentOldest.toLocaleDateString()}...`);
      
      await saveIssuesBatch(batch.issues, cacheManager, contentManager);
      totalSynced += batch.issues.length;
      
      // Update our oldest date for next iteration
      const batchOldest = batch.issues.reduce((min, issue) => {
        const updated = new Date(issue.fields.updated);
        return updated < min ? updated : min;
      }, currentOldest);
      
      currentOldest = batchOldest;
      
      // If we got less than a full batch, we're probably near the end
      if (batch.issues.length < batchSize) {
        console.log(`\n📍 Reached older issues (got ${batch.issues.length} in last batch)\n`);
        continueSync = false;
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.green(`\n✅ Sync complete! Added/updated ${totalSynced} issues in ${totalTime}s\n`));
    
    // Get final count
    const finalCount = await cacheManager.listIssuesByProject(projectKey);
    console.log(chalk.dim(`   Total issues in local database: ${finalCount.length}\n`));
    
    console.log(`💡 Next steps:`);
    console.log(`   • Search all issues: ${chalk.cyan('ji search <query>')}`);
    console.log(`   • View an issue: ${chalk.cyan('ji issue view <issue-key>')}\n`);
    
    // Generate embeddings in background after sync
    await generateEmbeddingsInBackground();

  } catch (error) {
    console.error(`\n❌ Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    cacheManager.close();
    contentManager.close();
  }
}

function createProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}


async function syncConfluence(spaceKey: string) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const confluenceClient = new ConfluenceClient(config);
  const contentManager = new ContentManager();

  try {
    console.log(`\n🔍 Syncing Confluence space ${chalk.bold.blue(spaceKey)}...\n`);
    
    // First verify the space exists
    const space = await confluenceClient.getSpace(spaceKey);
    console.log(`📚 Space: ${chalk.bold(space.name)}\n`);

    // Fetch all pages with progress
    const startTime = Date.now();
    let lastProgress = 0;
    const pages = await confluenceClient.getAllSpacePages(spaceKey, (current, total) => {
      if (total === 0) return;
      
      const percent = Math.round((current / total) * 100);
      const progressBar = createProgressBar(percent, 20);
      const statusLine = `📥 ${progressBar} ${percent}% | ${current}/${total} pages`;
      process.stdout.write('\r' + ' '.repeat(80) + '\r' + statusLine);
      lastProgress = percent;
    });
    
    if (lastProgress < 100 && pages.length > 0) {
      const progressBar = createProgressBar(100, 20);
      const statusLine = `📥 ${progressBar} 100% | ${pages.length}/${pages.length} pages`;
      process.stdout.write('\r' + ' '.repeat(80) + '\r' + statusLine);
    }
    console.log(''); // New line after progress

    if (pages.length === 0) {
      console.log(chalk.yellow('⚠️  No pages found in this space.'));
      return;
    }

    console.log(`\n💾 Saving ${pages.length} pages...\n`);
    
    // Save each page to the content manager
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      
      // Update progress
      const percent = Math.round(((i + 1) / pages.length) * 100);
      const progressBar = createProgressBar(percent, 20);
      const title = page.title.length > 40 ? page.title.substring(0, 40) + '...' : page.title;
      const statusLine = `💾 ${progressBar} ${percent}% | ${title}`;
      process.stdout.write('\r' + ' '.repeat(80) + '\r' + statusLine);

      // Convert storage format to plain text
      const plainText = confluenceToText(page.body?.storage?.value || '');
      
      // Extract metadata
      const metadata = {
        spaceKey: page.space.key,
        spaceName: page.space.name,
        version: page.version.number,
        lastModified: page.version.when,
        webUrl: page._links.webui
      };

      // Save to content manager
      await contentManager.saveContent({
        id: `confluence:${page.id}`,
        source: 'confluence',
        type: 'page',
        title: page.title,
        content: plainText,
        url: page._links.webui,
        spaceKey: page.space.key,
        metadata,
        updatedAt: new Date(page.version.when).getTime(),
        syncedAt: Date.now()
      });
    }

    console.log(''); // New line after progress
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.green(`\n✅ Successfully synced ${pages.length} pages from ${space.name} in ${totalTime}s\n`));
    
    console.log(`💡 Next steps:`);
    console.log(`   • Search all content: ${chalk.cyan('ji search <query>')}`);
    console.log(`   • Search Confluence only: ${chalk.cyan('ji search --source confluence <query>')}`);
    console.log(`   • View a page: ${chalk.cyan('ji confluence view <page-id>')}\n`);
    
    // Generate embeddings in background after sync
    await generateEmbeddingsInBackground();

  } catch (error) {
    console.error(`\n❌ Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    contentManager.close();
  }
}

async function ask(question: string, options: {
  source?: 'jira' | 'confluence';
  limit?: number;
  verbose?: boolean;
  model?: string;
  includeJira?: boolean;
  includeOld?: boolean;
}) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const embeddingManager = new EmbeddingManager();
  const ollama = new OllamaClient();
  const memoryManager = new MemoryManager();
  
  // Get configured model or detect available model
  const settings = await configManager.getSettings();
  let askModel = settings.askModel || options.model;
  
  if (!askModel) {
    // No model configured, try to find a suitable one
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags');
      const data = await response.json() as { models?: Array<{ name: string }> };
      
      if (data.models && data.models.length > 0) {
        // Try to find common good models, fallback to first available
        const preferredModels = ['llama3.1', 'qwen2.5', 'gemma2', 'llama3', 'mistral'];
        const availableModels = data.models.map(m => m.name);
        
        askModel = preferredModels.find(preferred => 
          availableModels.some(available => available.includes(preferred))
        ) || availableModels[0];
        
        console.log(chalk.yellow(`⚠️  No ask model configured. Using: ${askModel}`));
        console.log(chalk.dim(`   Run 'ji models' to configure your preferred model.\n`));
      } else {
        console.error('No models found in Ollama.');
        console.log('Pull a model first:');
        console.log(chalk.cyan('  ollama pull llama3.1'));
        process.exit(1);
      }
    } catch (error) {
      console.error('Could not connect to Ollama or no models available.');
      console.log('Make sure Ollama is running and has models installed:');
      console.log(chalk.cyan('  ollama pull llama3.1'));
      process.exit(1);
    }
  }
  
  const spinner = ora({
    text: 'Checking memory for relevant facts...',
    spinner: 'dots'
  }).start();
  
  try {
    // Check if Ollama is available
    if (!await ollama.isAvailable()) {
      spinner.stop();
      console.error('❌ Ollama is not available. Please start Ollama.');
      process.exit(1);
    }
    
    // Default to Confluence-only unless explicitly including Jira or source is set to jira
    const effectiveSource = options.source || (options.includeJira ? undefined : 'confluence');
    
    // Round 0: Check memory for relevant facts
    const relevantMemories = memoryManager.getRelevantMemories(question, 2);
    if (options.verbose && relevantMemories.length > 0) {
      console.log(chalk.dim('\ud83e\udde0 Found relevant memories:'));
      relevantMemories.forEach(mem => {
        console.log(chalk.dim(`  • ${mem.keyFacts}`));
      });
    }
    
    // Implement multi-round iterative search for better results
    const allContexts: (SearchResult & { searchRound?: number })[] = [];
    const seenIds = new Set<string>();
    
    // Use memory to boost relevant documents
    const memoryDocIds = new Set(relevantMemories.flatMap(m => m.relevantDocIds));
    
    // Collect relevant memory facts for injection into prompt
    const memoryFacts = relevantMemories.length > 0 
      ? relevantMemories.map(m => m.keyFacts).join(' | ') 
      : '';
    
    // Round 1: Broad Discovery - Generate diverse initial queries
    spinner.text = 'Round 1: Broad discovery - generating search queries...';
    
    // Smart detection for team/project questions
    const isTeamQuestion = /\b(team|who is|what is.*team|eval team)\b/i.test(question);
    const hasProjectCode = /\b[A-Z]{2,6}\b/.test(question); // Detect project codes like EVAL, CFA, etc.
    
    const round1Prompt = `Given this question: "${question}"

Generate 3-4 diverse search queries for finding relevant technical documentation. ${isTeamQuestion ? 'This appears to be a team/organization question, so focus on:' : 'Focus on:'}
- Direct keywords from the question
${hasProjectCode ? '- Project codes and team abbreviations (like EVAL-, CFA-, etc.)' : '- Technical terms and abbreviations'}
${isTeamQuestion ? '- Team structure, ownership, and organization' : '- Related concepts and components'}
${isTeamQuestion ? '- Leadership and responsibility information' : '- Different ways to phrase the same question'}
${isTeamQuestion ? '- Decoder ring, org chart, team directory' : ''}

Return only the queries, one per line:`;

    let round1Queries = [question];
    try {
      const response = await ollama.generate(round1Prompt, { model: askModel });
      if (response) {
        const generated = response.trim().split('\n').filter(q => q.trim().length > 0).slice(0, 4);
        if (generated.length > 0) {
          round1Queries = [question, ...generated];
        }
      }
    } catch (error) {
      if (options.verbose) console.error('Round 1 query generation failed:', error);
    }

    // Execute Round 1 searches
    spinner.text = `Round 1: Searching with ${round1Queries.length} queries...`;
    for (const query of round1Queries) {
      const results = await embeddingManager.hybridSearch(query, {
        source: effectiveSource,
        limit: 8,
        includeAll: true
      });
      
      for (const result of results) {
        if (!seenIds.has(result.content.id)) {
          seenIds.add(result.content.id);
          allContexts.push({ ...result, searchRound: 1 });
        }
      }
    }

    // Round 2: Focused Refinement - Analyze initial results for key concepts
    if (allContexts.length > 0) {
      spinner.text = `Round 2: Focused refinement - found ${allContexts.length} documents...`;
      
      const topResults = allContexts.slice(0, 5);
      const conceptsFound = topResults.map(r => r.content.title).join(', ');
      
      const round2Prompt = `Based on these initial search results: "${conceptsFound}"

For the question "${question}", generate 2-3 more targeted search queries focusing on:
- Specific technical terms or APIs mentioned in the results
- Implementation details or "how-to" aspects
- Configuration or setup information
- Related troubleshooting or best practices

Return only the queries, one per line:`;

      try {
        const response = await ollama.generate(round2Prompt, { model: askModel });
        if (response) {
          const round2Queries = response.trim().split('\n').filter(q => q.trim().length > 0).slice(0, 3);
          
          spinner.text = `Round 2: Searching with ${round2Queries.length} refined queries...`;
          for (const query of round2Queries) {
            const results = await embeddingManager.hybridSearch(query, {
              source: effectiveSource,
              limit: 6,
              includeAll: true
            });
            
            for (const result of results) {
              if (!seenIds.has(result.content.id)) {
                seenIds.add(result.content.id);
                allContexts.push({ ...result, searchRound: 2 });
              }
            }
          }
        }
      } catch (error) {
        if (options.verbose) {
          spinner.stop();
          console.log(chalk.yellow('⚠️  Round 2 query generation failed'));
          spinner.start('Round 3: Gap filling - looking for missing context...');
        }
      }
    }

    // Round 3: Gap Filling - Look for missing context or prerequisites
    if (allContexts.length > 0) {
      spinner.text = 'Round 3: Gap filling - looking for missing context...';
      
      const round3Prompt = `For the question "${question}", and considering we found information about: "${allContexts.slice(0, 3).map(r => r.content.title).join(', ')}"

Generate 1-2 queries to find missing context such as:
- Prerequisites or dependencies
- Overview or getting started information  
- Related tools or integrations
- Common issues or limitations

Return only the queries, one per line:`;

      try {
        const response = await ollama.generate(round3Prompt, { model: askModel });
        if (response) {
          const round3Queries = response.trim().split('\n').filter(q => q.trim().length > 0).slice(0, 2);
          
          spinner.text = `Round 3: Searching with ${round3Queries.length} gap-filling queries...`;
          for (const query of round3Queries) {
            const results = await embeddingManager.hybridSearch(query, {
              source: effectiveSource,
              limit: 4,
              includeAll: true
            });
            
            for (const result of results) {
              if (!seenIds.has(result.content.id)) {
                seenIds.add(result.content.id);
                allContexts.push({ ...result, searchRound: 3 });
              }
            }
          }
        }
      } catch (error) {
        if (options.verbose) {
          spinner.stop();
          console.log(chalk.yellow('⚠️  Round 3 query generation failed'));
          if (isTeamQuestion) {
            spinner.start('Round 4: Team-specific search for organization info...');
          } else {
            spinner.start('Processing documents and generating response...');
          }
        }
      }
    }

    // Round 4: Team-specific targeted search (only for team questions)
    if (isTeamQuestion && allContexts.length > 0) {
      spinner.text = 'Round 4: Team-specific search for organization info...';
      
      // Look for project codes and specific team searches
      const extractedCodes = question.match(/\b[A-Z]{2,6}\b/g) || [];
      const teamSearches = [
        ...extractedCodes.map(code => `${code} team`),
        ...extractedCodes.map(code => `${code} project`),
        ...extractedCodes.map(code => `${code}-` + " issues"), // Project prefix search
        `team structure ${extractedCodes.join(' ')}`,
        'team ownership responsibilities'
      ].filter(q => q.trim().length > 5); // Filter out short queries

      spinner.text = `Round 4: Searching with ${teamSearches.slice(0, 3).length} team-specific queries...`;
      for (const query of teamSearches.slice(0, 3)) {
        const results = await embeddingManager.hybridSearch(query, {
          source: effectiveSource,
          limit: 3,
          includeAll: true
        });
        
        for (const result of results) {
          if (!seenIds.has(result.content.id)) {
            seenIds.add(result.content.id);
            allContexts.push({ ...result, searchRound: 4 });
          }
        }
      }
    }

    spinner.text = `Processing ${allContexts.length} documents and generating response...`;
    
    if (options.verbose) {
      const byRound = [1, 2, 3, 4].map(round => 
        allContexts.filter(c => c.searchRound === round).length
      );
      spinner.stop();
      console.log(chalk.dim(`📊 Search completed: ${allContexts.length} unique documents found`));
      console.log(chalk.dim(`   Round 1: ${byRound[0]}, Round 2: ${byRound[1]}, Round 3: ${byRound[2]}${isTeamQuestion ? `, Round 4: ${byRound[3]}` : ''}`));
      spinner.start('Processing documents and generating response...');
    }
    
    const contexts = allContexts;
    
    // Check if query matches document titles for boosting
    const queryLower = question.toLowerCase();
    const scoreWithBoost = (result: SearchResult & { searchRound?: number }): number => {
      let score = result.score;
      
      // Boost earlier search rounds (higher confidence)
      if (result.searchRound === 1) {
        score *= 1.2; // 20% boost for round 1 results
      } else if (result.searchRound === 2) {
        score *= 1.1; // 10% boost for round 2 results
      }
      // Round 3 gets no boost (gap-filling results)
      
      // Boost title matches significantly
      const titleLower = result.content.title.toLowerCase();
      if (titleLower.includes(queryLower)) {
        score *= 2.0;
      }
      // Partial title word matches
      const queryWords = queryLower.split(/\s+/);
      const titleWords = titleLower.split(/\s+/);
      const wordMatches = queryWords.filter(qw => 
        titleWords.some(tw => tw.includes(qw) || qw.includes(tw))
      ).length;
      if (wordMatches > 0) {
        score *= (1 + wordMatches * 0.3);
      }
      
      // Boost recent documents (within last 30 days)
      if (result.content.updatedAt) {
        const daysSinceUpdate = (Date.now() - result.content.updatedAt) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate < 30) {
          score *= (1 + (30 - daysSinceUpdate) / 60); // Up to 50% boost for very recent docs
        }
      }
      
      // Boost documents that were previously helpful (memory-based)
      if (memoryDocIds.has(result.content.id)) {
        score *= 1.5; // 50% boost for previously helpful documents
      }
      
      return score;
    };
    
    // Sort with enhanced scoring
    contexts.sort((a, b) => {
      // First priority: Confluence over Jira
      if (a.content.source === 'confluence' && b.content.source === 'jira') return -1;
      if (a.content.source === 'jira' && b.content.source === 'confluence') return 1;
      
      // Second priority: Boosted scores (including title matches and recency)
      const scoreA = scoreWithBoost(a);
      const scoreB = scoreWithBoost(b);
      return scoreB - scoreA;
    });
    
    // Filter out old documents unless includeOld is specified
    let filteredContexts = contexts;
    if (!options.includeOld) {
      const threeYearsAgo = Date.now() - (3 * 365 * 24 * 60 * 60 * 1000);
      filteredContexts = contexts.filter(ctx => {
        // Always include Jira issues regardless of age
        if (ctx.content.source === 'jira') return true;
        
        // For Confluence, check if it's been modified within 3 years
        if (ctx.content.updatedAt && ctx.content.updatedAt > threeYearsAgo) {
          return true;
        }
        
        // If no updatedAt date available, exclude it to be safe
        return false;
      });
    }
    
    // Trim to requested limit
    const limitedContexts = filteredContexts.slice(0, options.limit || 10);
    
    if (limitedContexts.length === 0) {
      spinner.stop();
      console.log('No relevant context found. Try syncing more data with:');
      console.log(`  ${chalk.cyan('ji confluence sync <space>')}`);
      if (options.includeJira || options.source === 'jira') {
        console.log(`  ${chalk.cyan('ji issue sync <project>')}`);
      }
      if (!options.includeOld && filteredContexts.length < contexts.length) {
        console.log(`  ${chalk.cyan('ji ask "<question>" --include-old')} to search older documentation`);
      }
      return;
    }
    
    // Build context string for the prompt
    const contextStr = limitedContexts.map((ctx, i) => {
      const { content } = ctx;
      let contextBlock = `[${i + 1}] `;
      
      if (content.source === 'jira') {
        contextBlock += `Issue ${content.id.replace('jira:', '')} - ${content.title}\n`;
        const meta = content.metadata as any;
        contextBlock += `Status: ${meta?.status || 'Unknown'} | `;
        contextBlock += `Assignee: ${meta?.assignee || 'Unassigned'} | `;
        contextBlock += `Priority: ${meta?.priority || 'None'}\n`;
      } else {
        contextBlock += `Page: ${content.title}\n`;
        contextBlock += `Space: ${content.spaceKey || 'Unknown'}\n`;
      }
      
      // Include relevant content snippet - much more for key org docs
      let maxLength = content.source === 'confluence' ? 800 : 300;
      
      // Special handling for key organizational documents
      const isKeyOrgDoc = /decoder ring|team.*structure|org.*chart|leadership|ownership/i.test(content.title);
      if (isKeyOrgDoc && isTeamQuestion) {
        maxLength = 2000; // Much larger context for org docs when asking about teams
      }
      
      const snippet = content.content.substring(0, maxLength).replace(/\n+/g, ' ').trim();
      contextBlock += `Content: ${snippet}...\n`;
      
      return contextBlock;
    }).join('\n');
    
    // Build the prompt
    const hasJira = limitedContexts.some(c => c.content.source === 'jira');
    const systemPrompt = hasJira 
      ? `You are a helpful assistant with access to a software team's Confluence documentation and Jira issues.
Focus primarily on the Confluence documentation when answering questions.
Be thorough but concise. Reference page titles and issue keys when relevant.
If the context doesn't contain enough information to fully answer the question, say so.
Do not include any trailing whitespace or extra line breaks at the end of your response.`
      : `You are a helpful assistant with access to a software team's Confluence documentation.
Answer questions based on the provided documentation. Be thorough but concise.
Reference specific page titles when relevant.
If the documentation doesn't contain enough information to fully answer the question, say so.
Do not include any trailing whitespace or extra line breaks at the end of your response.`;

    const contextLabel = hasJira ? 'Context from Confluence documentation and Jira issues:' : 'Context from Confluence documentation:';
    const memorySection = memoryFacts ? `\nKnown facts from previous conversations:\n${memoryFacts}\n` : '';
    const userPrompt = `${contextLabel}

${contextStr}${memorySection}

Question: ${question}

Based on the context above, please provide a helpful answer:`;

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
    
    if (options.verbose) {
      spinner.stop();
      console.log(chalk.dim('Using context from:'));
      limitedContexts.forEach(ctx => {
        if (ctx.content.source === 'jira') {
          console.log(chalk.dim(`  • ${ctx.content.id.replace('jira:', '')}: ${ctx.content.title}`));
        } else {
          console.log(chalk.dim(`  • ${ctx.content.title} (${ctx.content.spaceKey})`));
        }
      });
      console.log();
    } else {
      spinner.stop();
    }
    
    
    // Generate response with streaming
    spinner.stop();
    
    const stream = await ollama.generateStream(fullPrompt, { model: askModel });
    
    if (!stream) {
      console.error('Failed to generate response');
      return;
    }
    
    // Process the stream
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const json = JSON.parse(line) as { response?: string; done?: boolean };
          if (json.response) {
            process.stdout.write(json.response);
            fullResponse += json.response;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
    
    // Ensure spinner is stopped
    spinner.stop();
    
    // Trim trailing whitespace by removing empty lines at the end
    fullResponse = fullResponse.trimEnd();
    
    // Extract memory from successful session (async, don't wait)
    if (fullResponse.length > 20 && limitedContexts.length > 0) {
      const sourceDocIds = limitedContexts.slice(0, 3).map(ctx => ctx.content.id);
      memoryManager.extractMemory(question, fullResponse, sourceDocIds).catch(() => {
        // Silent fail - memory extraction is optional
      });
    }
    
    // Add source citations with proper spacing
    console.log('\n\nSources:');
    const confluenceSources = limitedContexts.filter(c => c.content.source === 'confluence');
    const jiraSources = limitedContexts.filter(c => c.content.source === 'jira');
    
    if (confluenceSources.length > 0) {
      confluenceSources.slice(0, 3).forEach((ctx, i) => {
        // For Confluence, URLs are relative paths like /spaces/...
        const fullUrl = ctx.content.url.startsWith('http') 
          ? ctx.content.url 
          : `${config.jiraUrl}/wiki${ctx.content.url}`;
        
        // Format the modified date
        let dateStr = '';
        if (ctx.content.updatedAt) {
          const date = new Date(ctx.content.updatedAt);
          dateStr = ` (modified ${date.toLocaleDateString()})`;
        }
        
        console.log(chalk.dim(`${i + 1}. ${ctx.content.title}${dateStr}`) + chalk.cyan(` → ${fullUrl}`));
      });
    }
    
    if (jiraSources.length > 0 && options.includeJira) {
      jiraSources.slice(0, 2).forEach((ctx, i) => {
        const issueKey = ctx.content.id.replace('jira:', '');
        // For Jira, URLs are usually relative like /browse/ISSUE-123
        const fullUrl = ctx.content.url.startsWith('http') 
          ? ctx.content.url 
          : `${config.jiraUrl}${ctx.content.url}`;
        
        // Format the modified date
        let dateStr = '';
        if (ctx.content.updatedAt) {
          const date = new Date(ctx.content.updatedAt);
          dateStr = ` (updated ${date.toLocaleDateString()})`;
        }
        
        console.log(chalk.dim(`${confluenceSources.length + i + 1}. ${issueKey}: ${ctx.content.title}${dateStr}`) + chalk.cyan(` → ${fullUrl}`));
      });
    }
    
  } catch (error) {
    spinner.stop();
    console.error(`❌ Failed to answer: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    embeddingManager.close();
    memoryManager.close();
  }
}

async function configureModels() {
  const configManager = new ConfigManager();
  const ollama = new OllamaClient();
  const rl = readline.createInterface({ input, output });
  
  try {
    // Check if Ollama is available
    if (!await ollama.isAvailable()) {
      console.error('❌ Ollama is not available. Please start Ollama first.');
      process.exit(1);
    }
    
    console.log(chalk.bold('\n🤖 Configure Ollama Models'));
    console.log('Let\'s set up which models to use for different operations.\n');
    
    // Get available models from Ollama
    console.log('Fetching available models from Ollama...');
    const response = await fetch('http://127.0.0.1:11434/api/tags');
    const data = await response.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
    
    if (!data.models || data.models.length === 0) {
      console.log(chalk.yellow('⚠️  No models found in Ollama.'));
      console.log('Pull some models first:');
      console.log(chalk.cyan('  ollama pull llama3.1'));
      console.log(chalk.cyan('  ollama pull qwen2.5'));
      console.log(chalk.cyan('  ollama pull gemma2'));
      process.exit(1);
    }
    
    const models = data.models.map(m => m.name).sort();
    
    console.log(chalk.green(`Found ${models.length} models:\n`));
    models.forEach((model, i) => {
      console.log(`  ${i + 1}. ${model}`);
    });
    
    const currentSettings = await configManager.getSettings();
    
    // Configure ask model
    console.log(chalk.bold('\n💬 Ask Model (for Q&A responses)'));
    if (currentSettings.askModel) {
      console.log(chalk.dim(`Current: ${currentSettings.askModel}`));
    }
    console.log('Choose a model for generating responses to questions:');
    
    const askChoice = await rl.question('Enter model number (or press Enter to keep current): ');
    if (askChoice.trim() && askChoice.trim() !== '0') {
      const modelIndex = parseInt(askChoice) - 1;
      if (modelIndex >= 0 && modelIndex < models.length) {
        await configManager.setSetting('askModel', models[modelIndex]);
        console.log(chalk.green(`✓ Set ask model to: ${models[modelIndex]}`));
      } else {
        console.log(chalk.red('Invalid choice, keeping current setting.'));
      }
    }
    
    // Configure embedding model
    console.log(chalk.bold('\n🔍 Embedding Model (for semantic search)'));
    if (currentSettings.embeddingModel) {
      console.log(chalk.dim(`Current: ${currentSettings.embeddingModel}`));
    }
    console.log('Choose a model for generating embeddings (recommend: mxbai-embed-large):');
    
    const embedChoice = await rl.question('Enter model number (or press Enter to keep current): ');
    if (embedChoice.trim() && embedChoice.trim() !== '0') {
      const modelIndex = parseInt(embedChoice) - 1;
      if (modelIndex >= 0 && modelIndex < models.length) {
        await configManager.setSetting('embeddingModel', models[modelIndex]);
        console.log(chalk.green(`✓ Set embedding model to: ${models[modelIndex]}`));
      } else {
        console.log(chalk.red('Invalid choice, keeping current setting.'));
      }
    }
    
    // Show final configuration
    const finalSettings = await configManager.getSettings();
    console.log(chalk.bold('\n🎉 Configuration Complete!'));
    console.log(`Ask model: ${chalk.cyan(finalSettings.askModel || 'auto-detect')}`);
    console.log(`Embedding model: ${chalk.cyan(finalSettings.embeddingModel || 'mxbai-embed-large (default)')}`);
    console.log('\nYou can run this command again anytime to change these settings.');
    
  } catch (error) {
    console.error(`Failed to configure models: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    rl.close();
    configManager.close();
  }
}

async function viewConfluencePage(pageId: string, options: { json?: boolean }) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const confluenceClient = new ConfluenceClient(config);

  try {
    // Fetch the page
    const page = await confluenceClient.getPage(pageId);

    if (options.json) {
      console.log(JSON.stringify(page, null, 2));
    } else {
      console.log(`\n${chalk.bold(page.title)}`);
      console.log(`\n${chalk.dim('Space:')} ${page.space.name} (${page.space.key})`);
      console.log(`${chalk.dim('Version:')} ${page.version.number}`);
      console.log(`${chalk.dim('Last modified:')} ${new Date(page.version.when).toLocaleString()}`);
      console.log(`${chalk.dim('URL:')} ${page._links.webui}`);
      
      if (page.body?.view?.value) {
        console.log(`\n${chalk.dim('Content (HTML):')}`)
        // Show a preview of the HTML content
        const preview = page.body.view.value.substring(0, 500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(preview + (page.body.view.value.length > 500 ? '...' : ''));
        console.log(chalk.dim('\n(Use --json to see full content)'));
      } else if (page.body?.storage?.value) {
        console.log(`\n${chalk.dim('Content:')}`)
        const plainText = confluenceToText(page.body.storage.value);
        console.log(plainText.substring(0, 500) + (plainText.length > 500 ? '...' : ''));
        console.log(chalk.dim('\n(Use --json to see full content)'));
      }
    }

  } catch (error) {
    console.error(`Failed to fetch page: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  // Handle internal refresh command (hidden from users)
  if (args[0] === 'internal-refresh' && args[1]) {
    const config = JSON.parse(process.env.JI_CONFIG || '{}');
    if (config.jiraUrl) {
      await refreshInBackground(args[1], config);
    }
    process.exit(0);
  }

  // Handle internal embed command (hidden from users)
  if (args[0] === 'internal-embed' && args[1]) {
    await embedContent(args[1]);
    process.exit(0);
  }
  
  // Handle internal batch embedding command (hidden from users)
  if (args[0] === 'internal-embed-batch') {
    await generateEmbeddingsBatch();
    process.exit(0);
  }
  
  function showHelp() {
    console.log('ji - Jira & Confluence CLI\n');
    console.log('Usage:');
    console.log('  ji auth                       - Set up authentication');
    console.log('  ji mine                       - Show your open issues');
    console.log('  ji issue view <key>           - View an issue');
    console.log('  ji issue sync <project>       - Sync all issues from a project');
    console.log('  ji confluence sync <space>    - Sync Confluence space');
    console.log('  ji confluence view <page-id>  - View Confluence page');
    console.log('  ji search <query>             - Search across all content');
    console.log('  ji search --semantic <query>  - Semantic search only');
    console.log('  ji ask "<question>"           - Ask AI about Confluence docs');
    console.log('  ji models                     - Configure Ollama models');
    console.log('  ji embeddings regenerate      - Regenerate all embeddings');
    console.log('\nOptions:');
    console.log('  --help, -h                    - Show this help message');
    console.log('  --json, -j                    - Output as JSON');
    console.log('  --sync, -s                    - Force sync from API');
    console.log('  --clean                       - Clear local data before sync');
    console.log('  --source [jira|confluence]    - Filter by source');
    console.log('  --limit <n>                   - Limit results (default: 10)');
    console.log('  --all                         - Include closed/resolved issues');
    console.log('  --verbose, -v                 - Show additional details');
    console.log('  --model <name>                - LLM model for ask (default: gemma3n)');
    console.log('  --include-jira                - Include Jira issues in ask results');
    console.log('  --include-old                 - Include docs not modified in 3+ years');
  }
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  if (command === 'auth') {
    await auth();
  } else if (command === 'mine') {
    await showMyIssues();
  } else if (command === 'models') {
    await configureModels();
  } else if (command === 'mine_fallback') {
    await showMyIssues();
  } else if (command === 'issue' && args[1] === 'view' && args[2]) {
    const issueKey = args[2];
    const options = {
      json: args.includes('--json') || args.includes('-j'),
      sync: args.includes('--sync') || args.includes('-s')
    };
    await viewIssue(issueKey, options);
  } else if (command === 'issue' && args[1] === 'sync' && args[2]) {
    const projectKey = args[2];
    const options = {
      fresh: args.includes('--clean')
    };
    await syncJiraProject(projectKey, options);
  } else if (command === 'confluence' && args[1] === 'sync' && args[2]) {
    const spaceKey = args[2];
    await syncConfluence(spaceKey);
  } else if (command === 'confluence' && args[1] === 'view' && args[2]) {
    const pageId = args[2];
    const options = {
      json: args.includes('--json') || args.includes('-j')
    };
    await viewConfluencePage(pageId, options);
  } else if (command === 'search' && args[1]) {
    const queryStart = args.includes('--semantic') ? 2 : 1;
    const query = args.slice(queryStart).filter(arg => !arg.startsWith('--')).join(' ');
    
    const sourceIndex = args.indexOf('--source');
    const limitIndex = args.indexOf('--limit');
    
    // Properly type the source option
    let source: 'jira' | 'confluence' | undefined;
    if (sourceIndex !== -1 && args[sourceIndex + 1]) {
      const sourceValue = args[sourceIndex + 1];
      if (sourceValue === 'jira' || sourceValue === 'confluence') {
        source = sourceValue;
      }
    }
    
    const options = {
      semantic: args.includes('--semantic'),
      source,
      limit: limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined,
      includeAll: args.includes('--all')
    };
    
    await search(query, options);
  } else if (command === 'embeddings' && args[1] === 'regenerate') {
    await regenerateAllEmbeddings();
  } else if (command === 'ask' && args[1]) {
    // Extract the question and options
    const questionStart = 1;
    const questionArgs = args.slice(questionStart).filter(arg => !arg.startsWith('--'));
    const question = questionArgs.join(' ');
    
    const sourceIndex = args.indexOf('--source');
    const limitIndex = args.indexOf('--limit');
    const modelIndex = args.indexOf('--model');
    
    // Properly type the source option
    let source: 'jira' | 'confluence' | undefined;
    if (sourceIndex !== -1 && args[sourceIndex + 1]) {
      const sourceValue = args[sourceIndex + 1];
      if (sourceValue === 'jira' || sourceValue === 'confluence') {
        source = sourceValue;
      }
    }
    
    const options = {
      source,
      limit: limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined,
      verbose: args.includes('--verbose') || args.includes('-v'),
      model: modelIndex !== -1 ? args[modelIndex + 1] : undefined,
      includeJira: args.includes('--include-jira'),
      includeOld: args.includes('--include-old')
    };
    
    await ask(question, options);
  } else {
    console.error(`Unknown command: ${args.join(' ')}`);
    process.exit(1);
  }
}

main().catch(console.error);