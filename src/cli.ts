#!/usr/bin/env bun
import { parseArgs } from "util";
import { ConfigManager } from './lib/config.js';
import { JiraClient } from './lib/jira-client.js';
import { CacheManager } from './lib/cache.js';
import { ContentManager } from './lib/content-manager.js';
import { EmbeddingManager } from './lib/embeddings.js';
import { ConfluenceClient } from './lib/confluence-client.js';
import { confluenceToText } from './lib/confluence-converter.js';
import chalk from 'chalk';
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
      console.log(chalk.green(`Successfully authenticated as ${user.displayName} (${user.emailAddress})`));

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
        detached: true,
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

async function search(query: string, options: { 
  semantic?: boolean, 
  source?: 'jira' | 'confluence',
  limit?: number 
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
        limit: options.limit
      });
    } else {
      results = await embeddingManager.hybridSearch(query, {
        source: options.source,
        limit: options.limit
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
      if (content.source === 'jira') {
        // Get status emoji based on status
        let statusIcon = '🔵'; // default
        const status = content.metadata?.status?.toLowerCase();
        if (status === 'done' || status === 'closed' || status === 'resolved') {
          statusIcon = '✅';
        } else if (status === 'in progress' || status === 'in development') {
          statusIcon = '🔄';
        } else if (status === 'blocked') {
          statusIcon = '🚫';
        } else if (status === 'feedback' || status === 'review') {
          statusIcon = '👀';
        } else if (status === 'todo' || status === 'open' || status === 'new') {
          statusIcon = '📋';
        }
        
        console.log(statusIcon + ' ' + chalk.bold(content.title));
      } else if (content.source === 'confluence') {
        console.log('📄 ' + chalk.bold(content.title));
      } else {
        console.log(chalk.bold(content.title));
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
    // First verify the space exists
    console.log(`Fetching space information for ${chalk.bold(spaceKey)}...`);
    const space = await confluenceClient.getSpace(spaceKey);
    console.log(`Found space: ${chalk.bold(space.name)}`);

    // Fetch all pages with progress
    console.log('\nSyncing pages...');
    const pages = await confluenceClient.getAllSpacePages(spaceKey, (current, total) => {
      process.stdout.write(`\rProgress: ${current}/${total} pages`);
    });
    console.log(''); // New line after progress

    if (pages.length === 0) {
      console.log('No pages found in this space.');
      return;
    }

    console.log(`\nProcessing ${pages.length} pages...`);
    
    // Save each page to the content manager
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      process.stdout.write(`\rProcessing: ${i + 1}/${pages.length} - ${page.title.substring(0, 50)}${page.title.length > 50 ? '...' : ''}`);

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
    console.log(chalk.green(`\n✓ Successfully synced ${pages.length} pages from ${space.name}`));
    console.log(`\nYou can now search these pages with: ${chalk.dim('ji search <query>')}`);
    console.log(`Or filter by source: ${chalk.dim('ji search --source confluence <query>')}`);

  } catch (error) {
    console.error(`\nSync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    contentManager.close();
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
  
  if (args.length === 0) {
    console.log('ji - Jira & Confluence CLI\n');
    console.log('Usage:');
    console.log('  ji auth                       - Set up authentication');
    console.log('  ji issue view <key>           - View an issue');
    console.log('  ji confluence sync <space>    - Sync Confluence space');
    console.log('  ji confluence view <page-id>  - View Confluence page');
    console.log('  ji search <query>             - Search across all content');
    console.log('  ji search --semantic <query>  - Semantic search only');
    console.log('\nOptions:');
    console.log('  --json, -j                    - Output as JSON');
    console.log('  --sync, -s                    - Force sync from API');
    console.log('  --source [jira|confluence]    - Filter by source');
    console.log('  --limit <n>                   - Limit results (default: 20)');
    process.exit(0);
  }

  const command = args[0];

  if (command === 'auth') {
    await auth();
  } else if (command === 'issue' && args[1] === 'view' && args[2]) {
    const issueKey = args[2];
    const options = {
      json: args.includes('--json') || args.includes('-j'),
      sync: args.includes('--sync') || args.includes('-s')
    };
    await viewIssue(issueKey, options);
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
    
    const options = {
      semantic: args.includes('--semantic'),
      source: sourceIndex !== -1 && args[sourceIndex + 1] as 'jira' | 'confluence' | undefined,
      limit: limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined
    };
    
    await search(query, options);
  } else {
    console.error(`Unknown command: ${args.join(' ')}`);
    process.exit(1);
  }
}

main().catch(console.error);