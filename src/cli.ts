#!/usr/bin/env bun
import { parseArgs } from "util";
import { ConfigManager } from './lib/config.js';
import { JiraClient } from './lib/jira-client.js';
import { CacheManager } from './lib/cache.js';
import { ContentManager } from './lib/content-manager.js';
import { type SearchResult } from './lib/content-manager.js';
import { ConfluenceClient } from './lib/confluence-client.js';
import { confluenceToText, confluenceToMarkdown } from './lib/confluence-converter.js';
import { OllamaClient } from './lib/ollama.js';
import { MemoryManager } from './lib/memory.js';
import { SearchAnalytics } from './lib/search-analytics.js';
import { MeilisearchAdapter } from './lib/meilisearch-adapter.js';
import { MeilisearchFast } from './lib/meilisearch-fast.js';
import { syncToMeilisearch } from './lib/sync-meilisearch.js';
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
      console.log(chalk.cyan(`${config.jiraUrl}/browse/${issue.key}`));
      console.log(`\n${chalk.dim('Status:')} ${issue.fields.status.name}`);
      if (issue.fields.priority) {
        console.log(`${chalk.dim('Priority:')} ${issue.fields.priority.name}`);
      }
      console.log(`${chalk.dim('Assignee:')} ${issue.fields.assignee ? issue.fields.assignee.displayName : chalk.yellow('Unassigned')}`);
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

async function takeIssue(issueKey: string) {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found. Please run "ji auth" first.');
    process.exit(1);
  }

  const jiraClient = new JiraClient(config);
  const spinner = ora(`Taking ownership of ${issueKey}...`).start();

  try {
    // Get current user info
    const currentUser = await jiraClient.getCurrentUser();
    
    // Get the issue to verify it exists and show current assignee
    const issue = await jiraClient.getIssue(issueKey);
    
    if (issue.fields.assignee?.displayName === currentUser.displayName) {
      spinner.warn(`You already own ${issueKey}`);
      return;
    }
    
    // Assign the issue
    await jiraClient.assignIssue(issueKey, currentUser.accountId);
    
    spinner.succeed(`Successfully assigned ${issueKey} to ${currentUser.displayName}`);
    
    // Show issue details
    console.log(`\n${chalk.bold(issue.key)}: ${issue.fields.summary}`);
    console.log(`${chalk.dim('Status:')} ${issue.fields.status.name}`);
    if (issue.fields.assignee) {
      console.log(`${chalk.dim('Previous assignee:')} ${issue.fields.assignee.displayName}`);
    }
    console.log(`${chalk.dim('Now assigned to:')} ${chalk.green(currentUser.displayName)}`);
    
    // Sync the issue to update local cache, search index, and embeddings
    spinner.start('Updating local cache...');
    try {
      const cacheManager = new CacheManager();
      
      // Get fresh issue data
      const updatedIssue = await jiraClient.getIssue(issueKey);
      
      // Save to cache - this automatically:
      // 1. Updates the issues table
      // 2. Updates searchable_content table
      // 3. Updates FTS index
      // 4. Updates Meilisearch index
      // 5. Spawns background embedding generation
      await cacheManager.saveIssue(updatedIssue);
      
      cacheManager.close();
      spinner.succeed('Local cache, search index, and embeddings updated');
    } catch (syncError) {
      spinner.warn('Failed to update local cache (will sync on next view)');
    }
    
  } catch (error) {
    spinner.fail(`Failed to take issue: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
  }
}

// Technical synonyms for query expansion
const TECHNICAL_SYNONYMS: Record<string, string[]> = {
  'auth': ['authentication', 'authorization', 'SSO', 'SAML', 'OAuth', 'login', 'token', 'credentials'],
  'deploy': ['deployment', 'release', 'ship', 'publish', 'CI/CD', 'pipeline', 'rollout'],
  'error': ['exception', 'failure', 'bug', 'issue', 'problem', 'troubleshoot', 'debug'],
  'API': ['endpoint', 'REST', 'GraphQL', 'service', 'integration', 'webhook', 'microservice'],
  'db': ['database', 'SQL', 'NoSQL', 'schema', 'migration', 'query'],
  'k8s': ['kubernetes', 'container', 'pod', 'cluster', 'helm', 'kubectl'],
  'config': ['configuration', 'settings', 'environment', 'variables', 'properties'],
  'test': ['testing', 'spec', 'unit test', 'integration test', 'e2e', 'TDD']
};

const TECHNICAL_ABBREVIATIONS: Record<string, string> = {
  'k8s': 'kubernetes',
  'db': 'database',
  'env': 'environment',
  'config': 'configuration',
  'auth': 'authentication',
  'creds': 'credentials',
  'repo': 'repository',
  'docs': 'documentation'
};

function expandQueryWithSynonyms(query: string): string {
  let expandedQuery = query;
  
  // Expand abbreviations
  Object.entries(TECHNICAL_ABBREVIATIONS).forEach(([abbrev, full]) => {
    const regex = new RegExp(`\\b${abbrev}\\b`, 'gi');
    expandedQuery = expandedQuery.replace(regex, `${abbrev} ${full}`);
  });
  
  // Add synonyms for known technical terms
  Object.entries(TECHNICAL_SYNONYMS).forEach(([term, synonyms]) => {
    if (query.toLowerCase().includes(term.toLowerCase())) {
      expandedQuery += ' ' + synonyms.slice(0, 3).join(' '); // Add top 3 synonyms
    }
  });
  
  return expandedQuery;
}

function detectSearchIntent(query: string): 'troubleshooting' | 'howto' | 'conceptual' | 'general' {
  const lowerQuery = query.toLowerCase();
  
  if (lowerQuery.includes('error') || lowerQuery.includes('broken') || lowerQuery.includes('issue') || 
      lowerQuery.includes('problem') || lowerQuery.includes('fix') || lowerQuery.includes('debug')) {
    return 'troubleshooting';
  }
  
  if (lowerQuery.includes('how to') || lowerQuery.includes('tutorial') || lowerQuery.includes('guide') ||
      lowerQuery.includes('setup') || lowerQuery.includes('install') || lowerQuery.includes('configure')) {
    return 'howto';
  }
  
  if (lowerQuery.includes('what is') || lowerQuery.includes('explain') || lowerQuery.includes('overview') ||
      lowerQuery.includes('introduction') || lowerQuery.includes('concept')) {
    return 'conceptual';
  }
  
  return 'general';
}

function assessContentQuality(content: any): number {
  let qualityScore = 1.0;
  const text = content.content.toLowerCase();
  
  // Positive quality signals
  if (text.includes('```') || text.includes('code>') || text.includes('curl ') || text.includes('npm ') || text.includes('kubectl ')) {
    qualityScore += 0.2; // Has code examples
  }
  
  if (text.match(/^\s*\d+\.\s/m) || text.includes('step 1') || text.includes('first,') || text.includes('then,')) {
    qualityScore += 0.2; // Has step-by-step instructions
  }
  
  if (text.includes('screenshot') || text.includes('image') || text.includes('diagram')) {
    qualityScore += 0.1; // Has visual aids
  }
  
  if (content.content.length > 500) {
    qualityScore += 0.1; // Substantial content
  }
  
  // Negative quality signals
  if (content.content.length < 100) {
    qualityScore -= 0.3; // Too short/stub
  }
  
  if (text.includes('todo') || text.includes('tbd') || text.includes('coming soon')) {
    qualityScore -= 0.2; // Incomplete content
  }
  
  if (text.includes('see other') || text.includes('refer to') || text.includes('check elsewhere')) {
    qualityScore -= 0.1; // Lacks self-contained information
  }
  
  return Math.max(0.1, Math.min(2.0, qualityScore));
}

function getFreshnessBoost(updatedAt: number | undefined): number {
  if (!updatedAt) return 0.8;
  
  const daysSinceUpdate = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);
  
  if (daysSinceUpdate < 7) return 1.5;      // Very fresh
  if (daysSinceUpdate < 30) return 1.2;     // Recent
  if (daysSinceUpdate < 90) return 1.0;     // Acceptable
  if (daysSinceUpdate < 365) return 0.9;    // Getting old
  return 0.7;                               // Stale
}

function highlightQueryInText(text: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let highlightedText = text;
  
  words.forEach(word => {
    const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    highlightedText = highlightedText.replace(regex, chalk.cyan('$1'));
  });
  
  return highlightedText;
}

function formatTimeAgo(timestamp: number | undefined): string {
  if (!timestamp) return 'unknown';
  
  const now = Date.now();
  const diff = now - timestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor(diff / (1000 * 60));
  
  if (days > 365) return `${Math.floor(days / 365)} year${Math.floor(days / 365) !== 1 ? 's' : ''} ago`;
  if (days > 30) return `${Math.floor(days / 30)} month${Math.floor(days / 30) !== 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  return 'just now';
}

function getScoreColor(score: number): (text: string) => string {
  if (score >= 90) return chalk.green;
  if (score >= 75) return chalk.yellow;
  if (score >= 60) return chalk.dim.yellow;
  return chalk.dim;
}

function getTeamFromMetadata(content: any): string {
  // Try to extract team from metadata
  if (content.metadata?.spaceName) {
    return content.metadata.spaceName;
  }
  if (content.metadata?.assignee) {
    return content.metadata.assignee.split('@')[0]; // Simple team extraction
  }
  if (content.spaceKey) {
    return content.spaceKey;
  }
  return 'Unknown';
}

async function search(query: string, options: { 
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
    // Use fast singleton Meilisearch instance
    const meilisearch = MeilisearchFast.getInstance();
    
    // Use hybrid search by default for better results
    const results = await meilisearch.hybridSearch(query, {
      source: options.source,
      limit: options.limit || 5,
      includeAll: options.includeAll
    });

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    // Process results - Meilisearch already handles ranking
    const limitedResults = results.map(result => ({
      ...result,
      team: getTeamFromMetadata(result.content)
    }));

    // Display results with enhanced formatting
    console.log(chalk.dim(`Found ${results.length} results:\n`));

    // Track search results being viewed
    const searchAnalytics = new SearchAnalytics();
    limitedResults.forEach(result => {
      searchAnalytics.recordInteraction({
        query,
        resultId: result.content.id,
        resultTitle: result.content.title,
        resultScore: result.score,
        interactionType: 'view',
        timestamp: Date.now()
      });
    });
    searchAnalytics.close();

    limitedResults.forEach((result, index) => {
      const { content, score, team } = result;
      const scorePercent = Math.round(score * 100);
      const scoreColor = getScoreColor(scorePercent);
      
      // Clean title formatting
      const title = chalk.bold(content.title);
      const scoreDisplay = scoreColor(`${scorePercent}%`);
      const paddedTitle = title.length > 60 ? title.substring(0, 57) + '...' : title;
      const padding = ' '.repeat(Math.max(0, 65 - title.length));
      
      console.log(`${paddedTitle}${padding}${scoreDisplay}`);
      
      // Display snippet from Meilisearch (already highlighted)
      if (result.snippet) {
        // Clean up the snippet: decode HTML entities and excessive whitespace
        let cleanSnippet = result.snippet
          .replace(/&rsquo;/g, "'") // Replace right single quote
          .replace(/&quot;/g, '"') // Replace quotes
          .replace(/&amp;/g, '&') // Replace ampersand
          .replace(/&lt;/g, '<') // Replace less than
          .replace(/&gt;/g, '>') // Replace greater than
          .replace(/&hellip;/g, '...') // Replace ellipsis
          .replace(/<mark>/g, chalk.yellow.bold('')) // Highlight marks
          .replace(/<\/mark>/g, chalk.reset(''))
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim();
        
        // Truncate to reasonable length
        const maxSnippetLength = 150;
        if (cleanSnippet.length > maxSnippetLength) {
          cleanSnippet = cleanSnippet.substring(0, maxSnippetLength) + '...';
        }
        
        console.log(chalk.dim(`  ${cleanSnippet}`));
      }
      
      // Show metadata for Jira issues with visual indicators
      if (content.source === 'jira' && content.metadata) {
        const meta = content.metadata as any;
        const status = meta.status || 'Unknown';
        const priority = meta.priority || 'Unassigned';
        const assignee = meta.assignee || 'Unassigned';
        
        // Status with visual indicators
        const getStatusIndicator = (status: string): string => {
          const statusLower = status.toLowerCase();
          if (['done', 'closed', 'resolved'].includes(statusLower)) {
            return chalk.green('✓'); // Green checkmark for completed
          } else if (['in progress', 'in review', 'testing'].includes(statusLower)) {
            return chalk.yellow('●'); // Yellow dot for in progress
          } else if (['open', 'to do', 'new', 'reopened'].includes(statusLower)) {
            return chalk.red('○'); // Red circle for open
          } else if (['cancelled', 'rejected', "won't do"].includes(statusLower)) {
            return chalk.gray('✗'); // Gray X for cancelled
          } else {
            return chalk.blue('?'); // Blue question mark for unknown
          }
        };
        
        // Priority with visual indicators
        const getPriorityColor = (priority: string): any => {
          const priorityLower = priority.toLowerCase();
          if (['highest', 'critical', 'blocker'].includes(priorityLower)) {
            return chalk.red.bold;
          } else if (['high', 'major'].includes(priorityLower)) {
            return chalk.red;
          } else if (['medium', 'normal'].includes(priorityLower)) {
            return chalk.yellow;
          } else if (['low', 'minor', 'trivial'].includes(priorityLower)) {
            return chalk.green;
          } else {
            return chalk.dim;
          }
        };
        
        const statusIndicator = getStatusIndicator(status);
        const priorityDisplay = getPriorityColor(priority)(priority);
        const statusDisplay = chalk.white(status);
        
        console.log(`  ${statusIndicator} ${statusDisplay} • ${priorityDisplay} • ${chalk.dim(assignee)}`);
      }
      
      // Minimal metadata line with clickable URL
      // For Jira issues, check if updatedAt is actually the sync time (within last day)
      let displayTime = content.updatedAt;
      if (content.source === 'jira' && content.updatedAt) {
        const hoursSinceUpdate = (Date.now() - content.updatedAt) / (1000 * 60 * 60);
        if (hoursSinceUpdate < 24) {
          // This is likely sync time, not real update time
          // Don't show misleading recent time
          displayTime = undefined;
        }
      }
      
      const timeAgo = displayTime ? formatTimeAgo(displayTime) : 'Unknown';
      const isRecent = displayTime && (Date.now() - displayTime) < (7 * 24 * 60 * 60 * 1000);
      const timeColor = isRecent ? chalk.green : chalk.dim;
      
      // Build full URL for clicking
      let fullUrl = content.url;
      if (config && !content.url.startsWith('http')) {
        if (content.source === 'confluence') {
          fullUrl = `${config.jiraUrl}/wiki${content.url}`;
        } else if (content.source === 'jira') {
          fullUrl = `${config.jiraUrl}${content.url}`;
        }
      } else if (config && content.url.includes('/rest/api/')) {
        // Convert API URLs to browse URLs for Jira issues
        if (content.source === 'jira' && content.id.startsWith('jira:')) {
          const issueKey = content.id.replace('jira:', '');
          fullUrl = `${config.jiraUrl}/browse/${issueKey}`;
        }
      }
      
      console.log(chalk.dim(`  ${team} • `) + timeColor(timeAgo) + chalk.cyan(` → ${fullUrl}`));
      
      // Only add blank line between results, not after the last one
      if (index < limitedResults.length - 1) {
        console.log('');
      }
    });
  } catch (error) {
    console.error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
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

      // Convert storage format to markdown for better LLM understanding
      const plainText = confluenceToMarkdown(page.body?.storage?.value || '');
      
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

  } catch (error) {
    console.error(`\n❌ Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    configManager.close();
    contentManager.close();
  }
}

async function addMemory(fact: string) {
  const memoryManager = new MemoryManager();
  
  try {
    const success = memoryManager.addManualMemory(fact);
    
    if (success) {
      console.log(chalk.green('✅ Memory added successfully!'));
      console.log(chalk.dim(`   "${fact}"`));
    } else {
      console.log(chalk.yellow('⚠️  Similar memory already exists - updated instead'));
    }
  } catch (error) {
    console.error(`Failed to add memory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    memoryManager.close();
  }
}

async function listMemories(options: { limit?: number; search?: string } = {}) {
  const memoryManager = new MemoryManager();
  
  try {
    let memories;
    
    if (options.search) {
      memories = memoryManager.searchMemories(options.search);
    } else {
      memories = memoryManager.listAllMemories(options.limit || 20);
    }
    
    if (memories.length === 0) {
      console.log(options.search 
        ? `No memories found matching "${options.search}"`
        : 'No memories stored yet'
      );
      return;
    }
    
    console.log(chalk.bold(`\n📚 Stored Memories (${memories.length})\n`));
    
    memories.forEach((memory, i) => {
      const date = new Date(memory.createdAt).toLocaleDateString();
      const accessCount = memory.accessCount > 1 ? chalk.dim(` (used ${memory.accessCount}x)`) : '';
      
      console.log(`${chalk.cyan((i + 1).toString().padStart(2))}. ${memory.keyFacts}`);
      console.log(`    ${chalk.dim(`Added ${date}${accessCount} • ID: ${memory.id}`)}\n`);
    });
  } catch (error) {
    console.error(`Failed to list memories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    memoryManager.close();
  }
}

async function deleteMemory(memoryId: string) {
  const memoryManager = new MemoryManager();
  
  try {
    const success = memoryManager.deleteMemory(memoryId);
    
    if (success) {
      console.log(chalk.green('✅ Memory deleted successfully'));
    } else {
      console.log(chalk.yellow('⚠️  Memory not found'));
    }
  } catch (error) {
    console.error(`Failed to delete memory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    memoryManager.close();
  }
}

async function showMemoryStats() {
  const memoryManager = new MemoryManager();
  
  try {
    const stats = memoryManager.getMemoryStats();
    
    console.log(chalk.bold('\n📊 Memory Statistics\n'));
    console.log(`Total memories: ${chalk.cyan(stats.total.toString())}`);
    console.log(`Used this week: ${chalk.cyan(stats.recent.toString())}`);
    
    if (stats.total > 0) {
      const percentage = Math.round((stats.recent / stats.total) * 100);
      console.log(`Activity rate: ${chalk.cyan(percentage + '%')}`);
    }
    
    console.log(chalk.dim('\nUse `ji memories list` to view all memories'));
  } catch (error) {
    console.error(`Failed to get memory stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    memoryManager.close();
  }
}

async function clearMemories(options: { all?: boolean } = {}) {
  const memoryManager = new MemoryManager();
  
  try {
    if (options.all) {
      // Dangerous operation - require confirmation
      console.log(chalk.yellow('⚠️  This will delete ALL memories (including auto-extracted ones)'));
      console.log(chalk.yellow('   This action cannot be undone!'));
      
      const rl = readline.createInterface({ input, output });
      const answer = await rl.question('Are you sure? Type "yes" to confirm: ');
      rl.close();
      
      if (answer.toLowerCase() !== 'yes') {
        console.log('Operation cancelled');
        return;
      }
      
      const count = memoryManager.clearAllMemories();
      
      if (count >= 0) {
        console.log(chalk.green(`✅ Cleared ${count} memories`));
      } else {
        console.log(chalk.red('❌ Failed to clear memories'));
      }
    } else {
      // Clear only manual memories
      const count = memoryManager.clearManualMemories();
      
      if (count >= 0) {
        console.log(chalk.green(`✅ Cleared ${count} manually added memories`));
        if (count === 0) {
          console.log(chalk.dim('   (No manual memories found)'));
        }
      } else {
        console.log(chalk.red('❌ Failed to clear memories'));
      }
    }
  } catch (error) {
    console.error(`Failed to clear memories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    memoryManager.close();
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

  const meilisearch = MeilisearchFast.getInstance();
  const ollama = new OllamaClient();
  const memoryManager = new MemoryManager();
  
  // Get configured models or detect available models
  const settings = await configManager.getSettings();
  let askModel = settings.askModel || options.model;
  let analysisModel = settings.analysisModel; // Smaller model for analysis tasks
  
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
  
  // Default analysis model to ask model if not set
  if (!analysisModel) {
    analysisModel = askModel;
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
    
    // Smart source selection based on question analysis
    spinner.text = 'Analyzing your question...';
    
    let effectiveSource = options.source; // Use explicit source if provided
    
    if (!options.source) {
      // Analyze the question to determine best sources
      try {
        const analysisPrompt = `Analyze this question and determine the best sources to search.

Question: "${question}"

Consider:
1. Is this about current status, bugs, or issues? → Search Jira
2. Is this about recent work, tasks, or activities (lately, recently, current work)? → Search Jira
3. Is this about how something works, documentation, or teams? → Search Confluence
4. Is this about troubleshooting or errors? → Search both
5. Is this asking who owns/works on something? → Search Confluence
6. Does it mention time-related terms (lately, recently, current, this week, today)? → Search Jira

Respond with ONLY one of: "jira", "confluence", or "both"`;
        
        const sourceAnalysis = await ollama.generate(analysisPrompt, { model: analysisModel });
        const suggestedSource = sourceAnalysis.trim().toLowerCase();
        
        if (suggestedSource === 'jira') {
          effectiveSource = 'jira';
        } else if (suggestedSource === 'confluence') {
          effectiveSource = 'confluence';
        } else if (suggestedSource === 'both') {
          effectiveSource = undefined; // undefined means search both
        } else {
          // Default to Confluence if analysis is unclear
          effectiveSource = 'confluence';
        }
        
        if (options.verbose) {
          console.log(chalk.dim(`\n📊 Question analysis:`));
          console.log(chalk.dim(`   Searching: ${effectiveSource || 'both Jira and Confluence'}\n`));
        }
      } catch (error) {
        // If analysis fails, fall back to old behavior
        effectiveSource = options.includeJira ? undefined : 'confluence';
      }
    }
    
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
    spinner.text = 'Searching for relevant information...';
    
    const round1Prompt = `Given this question: "${question}"

Generate 3-4 diverse search queries for finding relevant documentation. Focus on:
- Direct keywords from the question
- Technical terms and related concepts
- Different ways to phrase the same question
- Related components or systems
- If asking "who" questions, also search for team directories or organizational docs

Return only the queries, one per line:`;

    let round1Queries = [question];
    
    try {
      const response = await ollama.generate(round1Prompt, { model: analysisModel });
      if (response) {
        const generated = response.trim().split('\n').filter(q => q.trim().length > 0).slice(0, 4);
        if (generated.length > 0) {
          round1Queries = [...round1Queries, ...generated];
        }
      }
    } catch (error) {
      if (options.verbose) console.error('Round 1 query generation failed:', error);
    }
    
    if (options.verbose) {
      console.log(chalk.dim('\n🔍 Round 1 queries:'));
      round1Queries.forEach((q, i) => console.log(chalk.dim(`   ${i + 1}. ${q}`)));
    }

    // Execute Round 1 searches in parallel for better performance
    spinner.text = 'Gathering documentation...';
    const round1StartTime = Date.now();
    
    // Execute all Round 1 queries in parallel
    const round1Promises = round1Queries.map(query => 
      meilisearch.search(query, {
        source: effectiveSource,
        limit: 8,
        includeAll: true
      })
    );
    
    const round1Results = await Promise.all(round1Promises);
    
    // Process all results
    for (const results of round1Results) {
      for (const result of results) {
        if (!seenIds.has(result.content.id)) {
          seenIds.add(result.content.id);
          allContexts.push({ ...result, searchRound: 1 });
        }
      }
    }
    
    const round1Time = Date.now() - round1StartTime;
    if (options.verbose) {
      console.log(chalk.dim(`\n⏱️  Round 1: ${round1Time}ms for ${round1Queries.length} queries`));
    }

    // Calculate average relevance score of Round 1 results
    const avgRound1Score = allContexts.length > 0 
      ? allContexts.reduce((sum, ctx) => sum + ctx.score, 0) / allContexts.length
      : 0;
    
    // High confidence threshold - skip additional rounds if we have excellent matches
    const highConfidenceThreshold = 85;
    const skipAdditionalRounds = avgRound1Score > highConfidenceThreshold && allContexts.length >= 3;
    
    if (options.verbose && skipAdditionalRounds) {
      console.log(chalk.dim(`\n🎯 High confidence results (avg score: ${avgRound1Score.toFixed(1)}), skipping additional rounds`));
    }
    
    // Round 2: Focused Refinement - Analyze initial results for key concepts
    if (allContexts.length > 0 && !skipAdditionalRounds) {
      spinner.text = 'Refining search results...';
      const round2StartTime = Date.now();
      
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
        const response = await ollama.generate(round2Prompt, { model: analysisModel });
        if (response) {
          const round2Queries = response.trim().split('\n').filter(q => q.trim().length > 0).slice(0, 3);
          
          spinner.text = 'Looking for more specific information...';
          
          // Parallel execution for Round 2
          const round2Promises = round2Queries.map(query =>
            meilisearch.search(query, {
              source: effectiveSource,
              limit: 6,
              includeAll: true
            })
          );
          
          const round2Results = await Promise.all(round2Promises);
          
          for (const results of round2Results) {
            for (const result of results) {
              if (!seenIds.has(result.content.id)) {
                seenIds.add(result.content.id);
                allContexts.push({ ...result, searchRound: 2 });
              }
            }
          }
          
          const round2Time = Date.now() - round2StartTime;
          if (options.verbose) {
            console.log(chalk.dim(`⏱️  Round 2: ${round2Time}ms for ${round2Queries.length} queries`));
          }
        }
      } catch (error) {
        if (options.verbose) {
          spinner.stop();
          console.log(chalk.yellow('⚠️  Round 2 query generation failed'));
          spinner.start('Checking for additional context...');
        }
      }
    }

    // Round 3: Gap Filling - Look for missing context or prerequisites
    if (allContexts.length > 0 && !skipAdditionalRounds && allContexts.length < 15) {
      spinner.text = 'Checking for additional context...';
      const round3StartTime = Date.now();
      
      const round3Prompt = `For the question "${question}", and considering we found information about: "${allContexts.slice(0, 3).map(r => r.content.title).join(', ')}"

Generate 1-2 queries to find missing context such as:
- Prerequisites or dependencies
- Overview or getting started information  
- Related tools or integrations
- Common issues or limitations

Return only the queries, one per line:`;

      try {
        const response = await ollama.generate(round3Prompt, { model: analysisModel });
        if (response) {
          const round3Queries = response.trim().split('\n').filter(q => q.trim().length > 0).slice(0, 2);
          
          spinner.text = 'Finding related information...';
          
          // Parallel execution for Round 3
          const round3Promises = round3Queries.map(query =>
            meilisearch.search(query, {
              source: effectiveSource,
              limit: 4,
              includeAll: true
            })
          );
          
          const round3Results = await Promise.all(round3Promises);
          
          for (const results of round3Results) {
            for (const result of results) {
              if (!seenIds.has(result.content.id)) {
                seenIds.add(result.content.id);
                allContexts.push({ ...result, searchRound: 3 });
              }
            }
          }
          
          const round3Time = Date.now() - round3StartTime;
          if (options.verbose) {
            console.log(chalk.dim(`⏱️  Round 3: ${round3Time}ms for ${round3Queries.length} queries`));
          }
        }
      } catch (error) {
        if (options.verbose) {
          spinner.stop();
          console.log(chalk.yellow('⚠️  Round 3 query generation failed'));
          spinner.start('Preparing answer...');
        }
      }
    }


    spinner.text = 'Analyzing information...';
    
    // Deduplication: Remove near-duplicate content
    const deduplicatedContexts: typeof allContexts = [];
    const contentHashes = new Set<string>();
    
    for (const context of allContexts) {
      // Create a simple hash based on title and first 200 chars of content
      const contentPreview = context.content.content.substring(0, 200).toLowerCase().replace(/\s+/g, ' ');
      const hash = `${context.content.title.toLowerCase()}::${contentPreview}`;
      
      // Also check for same document ID with different versions
      const baseId = context.content.id.replace(/:v\d+$/, ''); // Remove version suffix if present
      
      if (!contentHashes.has(hash) && !deduplicatedContexts.some(c => c.content.id.startsWith(baseId))) {
        contentHashes.add(hash);
        deduplicatedContexts.push(context);
      }
    }
    
    if (options.verbose) {
      const byRound = [1, 2, 3].map(round => 
        deduplicatedContexts.filter(c => c.searchRound === round).length
      );
      spinner.stop();
      console.log(chalk.dim(`📊 Found ${allContexts.length} documents, ${deduplicatedContexts.length} after deduplication`));
      const totalSearchTime = Date.now() - round1StartTime;
      console.log(chalk.dim(`⏱️  Total search time: ${totalSearchTime}ms`));
      spinner.start('Preparing answer...');
    }
    
    const contexts = deduplicatedContexts;
    
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
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
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
      // Building context for each document
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
      
      // Extract relevant content based on the question
      let snippet = '';
      
      // For very large documents, try to find relevant sections
      if (content.content.length > 5000) {
        // Extract keywords from the question
        const questionLower = question.toLowerCase();
        const keywords = questionLower
          .replace(/[?!.,;:'"]/g, '') // Remove punctuation
          .split(/\s+/)
          .filter(word => 
            word.length > 3 && !['what', 'which', 'who', 'works', 'owns', 'team', 'responsible', 'does', 'that', 'this', 'with', 'from'].includes(word)
          );
        
        // Try to find sections containing these keywords
        let bestSection = '';
        let bestScore = 0;
        
        // Check chunks of the content
        const chunkSize = 1500;
        const overlap = 500;
        
        for (let i = 0; i < content.content.length - chunkSize; i += (chunkSize - overlap)) {
          const chunk = content.content.substring(i, i + chunkSize);
          const chunkLower = chunk.toLowerCase();
          
          // Score based on keyword matches
          let score = 0;
          for (const keyword of keywords) {
            if (chunkLower.includes(keyword)) {
              score += 10;
              // Extra points if the keyword appears multiple times
              const matches = (chunkLower.match(new RegExp(keyword, 'g')) || []).length;
              score += matches * 2;
            }
          }
          
          
          if (score > bestScore) {
            bestScore = score;
            bestSection = chunk;
          }
        }
        
        // Use the best section if we found relevant content
        if (bestScore > 10) {
          snippet = bestSection;
          // Found relevant section
        } else {
          // Fallback to beginning of document
          snippet = content.content.substring(0, 2000);
          // Using beginning of document
        }
      } else {
        // For smaller documents, include more content
        const maxLength = content.source === 'confluence' ? 1500 : 500;
        snippet = content.content.substring(0, maxLength);
      }
      
      // Clean up and structure the snippet
      snippet = snippet.trim();
      
      // Process table structures for better clarity
      // Look for markdown table patterns and convert to more readable format
      if (snippet.includes('|')) {
        snippet = snippet.replace(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g, (match, col1, col2) => {
          // Simple two-column table conversion
          return `\n${col1.trim()}: ${col2.trim()}\n`;
        });
      }
      
      // General cleanup
      snippet = snippet.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
      contextBlock += `Content: ${snippet}...\n`;
      
      return contextBlock;
    }).join('\n');
    
    // Build the prompt
    const hasJira = limitedContexts.some(c => c.content.source === 'jira');
    
    // Build appropriate system prompt
    let systemPrompt = '';
    if (hasJira) {
      systemPrompt = `You are a helpful assistant with access to a software team's Confluence documentation and Jira issues.
Focus primarily on the Confluence documentation when answering questions.
Be thorough but concise. Reference page titles and issue keys when relevant.
If the context doesn't contain enough information to fully answer the question, say so.
Do not include any trailing whitespace or extra line breaks at the end of your response.`;
    } else {
      systemPrompt = `You are a helpful assistant with access to a software team's Confluence documentation.
Answer questions based on the provided documentation. Be thorough but concise.
Reference specific page titles when relevant.
If the documentation doesn't contain enough information to fully answer the question, say so.
Do not include any trailing whitespace or extra line breaks at the end of your response.`;
    }

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
      
      // Show which documents are being used
      
      limitedContexts.forEach(ctx => {
        if (ctx.content.source === 'jira') {
          console.log(chalk.dim(`  • ${ctx.content.id.replace('jira:', '')}: ${ctx.content.title}`));
        } else {
          console.log(chalk.dim(`  • ${ctx.content.title} (${ctx.content.spaceKey})`));
        }
      });
      console.log();
    }
    
    // Start spinner for response generation
    spinner.text = 'Preparing answer...';
    spinner.start();
    
    const stream = await ollama.generateStream(fullPrompt, { model: askModel });
    
    if (!stream) {
      spinner.stop();
      console.error('Failed to generate response');
      return;
    }
    
    // Stop spinner once we start receiving the actual response
    spinner.stop();
    
    // Process the stream
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let firstChunkReceived = false;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const json = JSON.parse(line) as { response?: string; done?: boolean };
          if (json.response) {
            // Stop spinner on first actual response content
            if (!firstChunkReceived && json.response.trim()) {
              firstChunkReceived = true;
              // Spinner is already stopped above, but ensure it's stopped
            }
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
    console.log(chalk.bold('\n🧠 Embedding Model (for hybrid search)'));
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
    
    // Configure analysis model
    console.log(chalk.bold('\n⚡ Analysis Model (for query generation & source selection)'));
    if (currentSettings.analysisModel) {
      console.log(chalk.dim(`Current: ${currentSettings.analysisModel}`));
    }
    console.log('Choose a fast model for quick analysis tasks (recommend: gemma3n:latest):');
    
    const analysisChoice = await rl.question('Enter model number (or press Enter to keep current): ');
    if (analysisChoice.trim() && analysisChoice.trim() !== '0') {
      const modelIndex = parseInt(analysisChoice) - 1;
      if (modelIndex >= 0 && modelIndex < models.length) {
        await configManager.setSetting('analysisModel', models[modelIndex]);
        console.log(chalk.green(`✓ Set analysis model to: ${models[modelIndex]}`));
      } else {
        console.log(chalk.red('Invalid choice, keeping current setting.'));
      }
    }
    
    // Show final configuration
    const finalSettings = await configManager.getSettings();
    console.log(chalk.bold('\n🎉 Configuration Complete!'));
    console.log(`Ask model: ${chalk.cyan(finalSettings.askModel || 'auto-detect')}`);
    console.log(`Embedding model: ${chalk.cyan(finalSettings.embeddingModel || 'mxbai-embed-large (default)')}`);
    console.log(`Analysis model: ${chalk.cyan(finalSettings.analysisModel || 'same as ask model')}`);
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

  
  function showHelp() {
    console.log('ji - Jira & Confluence CLI\n');
    console.log('Usage:');
    console.log('  ji auth                       - Set up authentication');
    console.log('  ji mine                       - Show your open issues');
    console.log('  ji issue view <key>           - View an issue');
    console.log('  ji issue sync <project>       - Sync all issues from a project');
    console.log('  ji take <key>                 - Assign issue to yourself');
    console.log('  ji confluence sync <space>    - Sync Confluence space');
    console.log('  ji confluence view <page-id>  - View Confluence page');
    console.log('  ji search <query>             - Hybrid semantic + keyword search');
    console.log('  ji ask "<question>"           - Ask AI about Confluence docs');
    console.log('  ji remember "<fact>"          - Add fact to memory manually');
    console.log('  ji memories list              - List stored memories');
    console.log('  ji memories search <term>     - Search stored memories');
    console.log('  ji memories delete <id>       - Delete a memory by ID');
    console.log('  ji memories clear             - Clear manually added memories');
    console.log('  ji memories clear --all       - Clear ALL memories (dangerous)');
    console.log('  ji memories stats             - Show memory statistics');
    console.log('  ji models                     - Configure Ollama models');
    console.log('  ji index                      - Index all documents to Meilisearch');
    console.log('\nOptions:');
    console.log('  --help, -h                    - Show this help message');
    console.log('  --json, -j                    - Output as JSON');
    console.log('  --sync, -s                    - Force sync from API');
    console.log('  --clean                       - Clear local data before sync');
    console.log('  --source [jira|confluence]    - Filter by source');
    console.log('  --limit <n>                   - Limit results (default: 5)');
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
  } else if (command === 'take' && args[1]) {
    const issueKey = args[1];
    await takeIssue(issueKey);
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
    const query = args.slice(1).filter(arg => !arg.startsWith('--')).join(' ');
    
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
      source,
      limit: limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined,
      includeAll: args.includes('--all')
    };
    
    await search(query, options);
  } else if (command === 'index') {
    const spinner = ora('Checking Meilisearch connection...').start();
    
    try {
      // Check if Meilisearch is running
      const response = await fetch('http://localhost:7700/health');
      if (!response.ok) {
        throw new Error('Meilisearch is not responding');
      }
      spinner.succeed('Meilisearch is running');
      
      // Run sync
      const clean = args.includes('--clean');
      await syncToMeilisearch({ clean });
      
    } catch (error: any) {
      spinner.fail('Failed to index documents');
      
      if (error.message.includes('ECONNREFUSED') || error.message.includes('not responding')) {
        console.error(chalk.red('\n❌ Meilisearch is not running!'));
        console.error('\nTo start Meilisearch:');
        console.error(chalk.cyan('  brew services start meilisearch'));
        console.error('\nOr run it manually:');
        console.error(chalk.cyan('  meilisearch'));
      } else {
        console.error(chalk.red('Error:'), error.message);
      }
      
      process.exit(1);
    }
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
  } else if (command === 'remember' && args[1]) {
    // Extract the fact from all remaining arguments
    const fact = args.slice(1).join(' ');
    await addMemory(fact);
  } else if (command === 'memories' && (args[1] === '--help' || args[1] === '-h' || !args[1])) {
    console.log('\nMemory Management Commands:\n');
    console.log('  ji memories list                  - List stored memories');
    console.log('  ji memories search <term>         - Search memories');
    console.log('  ji memories delete <id>           - Delete a memory by ID');
    console.log('  ji memories clear                 - Clear manually added memories');
    console.log('  ji memories clear --all           - Clear ALL memories');
    console.log('  ji memories stats                 - Show memory statistics');
    console.log('\nOptions:');
    console.log('  --limit <n>                       - Limit results (for list/search)');
    console.log('  --help, -h                        - Show this help message\n');
  } else if (command === 'memories' && args[1] === 'list') {
    const limitIndex = args.indexOf('--limit');
    const options = {
      limit: limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined
    };
    await listMemories(options);
  } else if (command === 'memories' && args[1] === 'search' && args[2]) {
    const searchTerm = args.slice(2).filter(arg => !arg.startsWith('--')).join(' ');
    const limitIndex = args.indexOf('--limit');
    const options = {
      search: searchTerm,
      limit: limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined
    };
    await listMemories(options);
  } else if (command === 'memories' && args[1] === 'delete' && args[2]) {
    const memoryId = args[2];
    await deleteMemory(memoryId);
  } else if (command === 'memories' && args[1] === 'clear') {
    const options = {
      all: args.includes('--all')
    };
    await clearMemories(options);
  } else if (command === 'memories' && args[1] === 'stats') {
    await showMemoryStats();
  } else if (command === 'memories') {
    console.error('Unknown memories subcommand. Use "ji memories --help" for usage.');
    process.exit(1);
  } else {
    console.error(`Unknown command: ${args.join(' ')}`);
    process.exit(1);
  }
}

main().catch(console.error);