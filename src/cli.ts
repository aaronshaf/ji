#!/usr/bin/env bun
import { parseArgs } from "util";
import { ConfigManager } from './lib/config.js';
import { JiraClient } from './lib/jira-client.js';
import { CacheManager } from './lib/cache.js';
import { ContentManager } from './lib/content-manager.js';
import { EmbeddingManager } from './lib/embeddings.js';
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
      console.log(chalk.bold(content.title));
      console.log(chalk.dim(`  Source: ${content.source} | Type: ${content.type}`));
      if (content.source === 'jira' && content.metadata?.status) {
        console.log(chalk.dim(`  Status: ${content.metadata.status} | Priority: ${content.metadata.priority || 'None'}`));
      }
      console.log(chalk.dim(`  Score: ${score.toFixed(3)}`));
      console.log(`  ${snippet}`);
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
    console.log('  ji auth                     - Set up authentication');
    console.log('  ji issue view <key>         - View an issue');
    console.log('  ji search <query>           - Search across all content');
    console.log('  ji search --semantic <query> - Semantic search only');
    console.log('\nOptions:');
    console.log('  --json, -j                  - Output as JSON');
    console.log('  --sync, -s                  - Force sync from API');
    console.log('  --source [jira|confluence]  - Filter by source');
    console.log('  --limit <n>                 - Limit results (default: 20)');
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