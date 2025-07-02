#!/usr/bin/env bun
/**
 * Simple demonstration of the Effect boundary pattern
 * Shows how to wrap existing code with Effect for better error handling
 */

import { Effect, pipe } from 'effect';
import { CacheManager } from '../cache';
import { CacheEffect } from './cache-effect';

async function main() {
  console.log('=== Effect Boundary Pattern Demo ===\n');

  const cacheManager = new CacheManager();
  const cacheEffect = new CacheEffect(cacheManager);

  // Example 1: Traditional vs Effect approach
  console.log('1. Comparing approaches for issue fetching:\n');

  const testKey = 'EVAL-100';

  // Traditional approach
  console.log('Traditional approach:');
  const traditionalIssue = await cacheManager.getIssue(testKey);
  if (traditionalIssue) {
    console.log(`  Found: ${traditionalIssue.key}`);
  } else {
    console.log('  Not found');
  }

  // Effect approach with explicit error handling
  console.log('\nEffect approach:');
  await pipe(
    cacheEffect.getIssue(testKey),
    Effect.match({
      onFailure: (error) => {
        switch (error._tag) {
          case 'NotFoundError':
            return '  Not found (explicit)';
          case 'ParseError':
            return `  Parse error: ${error.message}`;
          case 'QueryError':
            return `  Database error: ${error.message}`;
          default:
            return `  Unknown error: ${error}`;
        }
      },
      onSuccess: (issue) => `  Found: ${issue.key}`,
    }),
    Effect.tap((result) => Effect.sync(() => console.log(result))),
    Effect.runPromise,
  );

  // Example 2: Batch operations
  console.log('\n2. Batch operations with Effect:\n');

  const keys = ['EVAL-1', 'EVAL-2', 'NONEXISTENT-1'];

  await pipe(
    cacheEffect.getIssues(keys),
    Effect.tap((issues) =>
      Effect.sync(() => {
        console.log(`  Requested ${keys.length} issues`);
        console.log(`  Found ${issues.length} in cache`);
        issues.forEach((issue) => console.log(`    - ${issue.key}: ${issue.fields.summary}`));
      }),
    ),
    Effect.catchAll((error) => Effect.sync(() => console.log(`  Error: ${error.message}`))),
    Effect.runPromise,
  );

  // Example 3: Checking existence
  console.log('\n3. Checking issue existence:\n');

  for (const key of ['EVAL-1', 'NOTEXIST-1']) {
    await pipe(
      cacheEffect.hasIssue(key),
      Effect.tap((exists) => Effect.sync(() => console.log(`  ${key}: ${exists ? 'exists' : 'not found'}`))),
      Effect.runPromise,
    );
  }

  // Example 4: Effect composition
  console.log('\n4. Composing multiple operations:\n');

  const getIssueSummary = (key: string) =>
    pipe(
      cacheEffect.getIssue(key),
      Effect.map((issue) => issue.fields.summary),
      Effect.catchTag('NotFoundError', () => Effect.succeed('(not found)')),
    );

  const summaries = await pipe(
    ['EVAL-1', 'EVAL-2', 'EVAL-3'],
    Effect.forEach((key) =>
      pipe(
        getIssueSummary(key),
        Effect.map((summary) => `${key}: ${summary}`),
      ),
    ),
    Effect.runPromise,
  );

  summaries.forEach((s) => console.log(`  ${s}`));

  // Cleanup
  cacheManager.close();

  console.log('\n✓ Demo complete');
}

main().catch(console.error);
