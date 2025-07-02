import chalk from 'chalk';
import { CacheManager } from '../../lib/cache.js';
import { ContentManager } from '../../lib/content-manager.js';
import { type Issue } from '../../lib/jira-client.js';
import { createProgressBar } from '../formatters/progress.js';

export async function saveIssuesBatch(
  issues: Issue[], 
  cacheManager: CacheManager, 
  contentManager: ContentManager
): Promise<void> {
  let lastUpdateTime = Date.now();
  const updateInterval = 100;
  
  console.log(`\n${chalk.blue('Saving issues to local cache...')}`);
  
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    
    // Save to cache
    await cacheManager.saveIssue(issue);
    
    // Save to content manager for search
    await contentManager.saveJiraIssue(issue);
    
    // Update progress at intervals
    const now = Date.now();
    if (now - lastUpdateTime > updateInterval || i === issues.length - 1) {
      process.stdout.write(`\r${createProgressBar(i + 1, issues.length)} ${i + 1}/${issues.length} issues`);
      lastUpdateTime = now;
    }
  }
  
  console.log(`\n${chalk.green('✓')} Saved ${issues.length} issues to cache\n`);
}