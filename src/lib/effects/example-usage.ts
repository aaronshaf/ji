#!/usr/bin/env bun
/**
 * Example demonstrating the boundary pattern for incremental Effect adoption
 * This shows how to use Effect wrappers alongside existing code
 */

import { Effect, pipe, Option } from 'effect';
import { CacheManager } from '../cache';
import { CacheEffect } from './cache-effect';
import { ConfigManager } from '../config';
import { JiraClient } from '../jira-client';

async function main() {
  console.log('=== Effect Boundary Pattern Example ===\n');

  // Initialize existing services
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();
  
  if (!config) {
    console.error('No configuration found');
    return;
  }

  const cacheManager = new CacheManager();
  const jiraClient = new JiraClient(config);
  
  // Create Effect wrapper
  const cacheEffect = new CacheEffect(cacheManager);

  // Example 1: Using Effect wrapper alongside existing code
  console.log('1. Fetching issue using both approaches:\n');
  
  const issueKey = 'TEST-123';
  
  // Traditional approach
  console.log('Traditional approach:');
  try {
    const issue = await cacheManager.getIssue(issueKey);
    if (issue) {
      console.log(`Found: ${issue.key} - ${issue.fields.summary}`);
    } else {
      console.log('Issue not found');
    }
  } catch (error) {
    console.log('Error:', error);
  }

  // Effect approach
  console.log('\nEffect approach:');
  const result = await pipe(
    cacheEffect.getIssue(issueKey),
    Effect.matchEffect({
      onFailure: (error) => Effect.sync(() => {
        switch (error._tag) {
          case 'NotFoundError':
            console.log('Issue not found (handled gracefully)');
            break;
          case 'ParseError':
            console.log('Failed to parse issue data:', error.message);
            break;
          case 'QueryError':
            console.log('Database error:', error.message);
            break;
        }
      }),
      onSuccess: (issue) => Effect.sync(() => {
        console.log(`Found: ${issue.key} - ${issue.fields.summary}`);
      })
    }),
    Effect.runPromise
  );

  // Example 2: Batch operations with Effect
  console.log('\n2. Batch fetching issues:\n');
  
  const issueKeys = ['EVAL-1', 'EVAL-2', 'EVAL-3', 'CFA-1', 'CFA-2'];
  
  const batchResult = await pipe(
    cacheEffect.getIssues(issueKeys),
    Effect.tap(issues => 
      Effect.sync(() => console.log(`Found ${issues.length} issues in cache`))
    ),
    Effect.map(issues => issues.map(i => `${i.key}: ${i.fields.summary}`)),
    Effect.runPromise
  );

  batchResult.forEach(summary => console.log(`  - ${summary}`));

  // Example 3: Composing operations
  console.log('\n3. Composing operations:\n');

  const updateIssueCache = (projectKey: string) => pipe(
    // Get update range
    cacheEffect.getIssueUpdateRange(projectKey),
    Effect.tap(range => 
      Effect.sync(() => console.log(`Update range: ${range.oldest || 'none'} to ${range.newest || 'none'}`))
    ),
    // Fetch new issues from Jira (simulated)
    Effect.flatMap(range => 
      Effect.tryPromise({
        try: async () => {
          if (!range.newest) {
            // First sync
            return await jiraClient.searchIssues(`project = "${projectKey}" ORDER BY updated DESC`, {
              maxResults: 10
            });
          } else {
            // Incremental sync
            return await jiraClient.searchIssues(
              `project = "${projectKey}" AND updated > "${range.newest}" ORDER BY updated DESC`
            );
          }
        },
        catch: (error) => new Error(`Failed to fetch from Jira: ${error}`)
      })
    ),
    // Save issues to cache
    Effect.flatMap(result => 
      pipe(
        result.issues,
        Effect.forEach(issue => 
          cacheEffect.saveIssue(issue),
          { concurrency: 5 }
        )
      )
    ),
    Effect.tap(saved => 
      Effect.sync(() => console.log(`Saved ${saved.length} issues to cache`))
    )
  );

  // Run the composed operation
  await pipe(
    updateIssueCache('EVAL'),
    Effect.catchAll(error => 
      Effect.sync(() => console.log(`Update failed: ${error.message}`))
    ),
    Effect.runPromise
  );

  // Example 4: Using Option for nullable values
  console.log('\n4. Using Option for nullable values:\n');

  const checkAndDisplayIssue = (key: string) => pipe(
    cacheEffect.getIssueOption(key),
    Effect.map(optionIssue => 
      Option.match(optionIssue, {
        onNone: () => `${key}: Not in cache`,
        onSome: (issue) => `${key}: ${issue.fields.summary} (${issue.fields.status.name})`
      })
    ),
    Effect.tap(message => Effect.sync(() => console.log(message)))
  );

  await pipe(
    ['EVAL-1', 'EVAL-999', 'CFA-1', 'NOTEXIST-1'],
    Effect.forEach(checkAndDisplayIssue, { concurrency: 4 }),
    Effect.runPromise
  );

  // Cleanup
  cacheManager.close();
  configManager.close();
}

// Run the example
main().catch(console.error);