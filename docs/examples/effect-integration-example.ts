#!/usr/bin/env bun
import { Effect, pipe } from 'effect';
import { OllamaClient } from './src/lib/ollama';

/**
 * Example showing how to gradually integrate Effect into existing code
 *
 * This demonstrates the progression from:
 * 1. Current implementation (no error handling)
 * 2. Effect-enhanced with backward compatibility
 * 3. Full Effect integration
 */

// Simulated content for testing
const testContent = {
  id: 'test-123',
  source: 'jira' as const,
  type: 'issue' as const,
  title: 'Test Issue',
  content: 'This is a test issue with some content that needs hashing',
  url: 'https://example.com/issue/test-123',
  syncedAt: Date.now(),
};

console.log('=== Effect Integration Example ===\n');

// 1. Current approach (as used in content-manager.ts)
console.log('1. Current approach:');
try {
  const contentHash = OllamaClient.contentHash(testContent.content);
  console.log(`Hash: ${contentHash}`);
} catch (error) {
  console.log('Error:', error);
}

// 2. Using Effect version with explicit error handling
console.log('\n2. Effect version with error handling:');
const hashEffect = pipe(
  OllamaClient.contentHashEffect(testContent.content),
  Effect.tap((hash) => Effect.sync(() => console.log(`Hash: ${hash}`))),
  Effect.mapError((error) => {
    console.log(`Error details: ${error.message}`);
    return error;
  }),
);

// Run the effect
Effect.runPromise(hashEffect).catch(() => {
  console.log('Hash generation failed');
});

// 3. Full Effect integration example - saveContent method
console.log('\n3. Full Effect integration for saveContent:\n');

// Define custom error types for better error handling
class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

class DatabaseError extends Error {
  readonly _tag = 'DatabaseError';
}

// Simulated Effect-based saveContent
const saveContentEffect = (content: typeof testContent) =>
  pipe(
    // Step 1: Validate content
    Effect.succeed(content),
    Effect.filterOrFail(
      (c) => c.content && c.content.trim().length > 0,
      () => new ValidationError('Content cannot be empty'),
    ),

    // Step 2: Generate content hash
    Effect.flatMap((validContent) =>
      pipe(
        OllamaClient.contentHashEffect(validContent.content),
        Effect.map((hash) => ({ ...validContent, contentHash: hash })),
      ),
    ),

    // Step 3: Save to database (simulated)
    Effect.flatMap((contentWithHash) =>
      Effect.try(() => {
        console.log('Saving to database:');
        console.log(`  ID: ${contentWithHash.id}`);
        console.log(`  Title: ${contentWithHash.title}`);
        console.log(`  Hash: ${contentWithHash.contentHash}`);
        // In real implementation, this would be db.prepare(...).run(...)
        return contentWithHash;
      }).pipe(Effect.mapError(() => new DatabaseError('Failed to save to database'))),
    ),

    // Step 4: Log success
    Effect.tap((saved) => Effect.sync(() => console.log(`✓ Successfully saved content ${saved.id}`))),
  );

// Run the full pipeline
Effect.runPromise(
  pipe(
    saveContentEffect(testContent),
    Effect.tap(() => Effect.sync(() => console.log('\nPipeline completed successfully'))),
  ),
).catch((error) => console.log(`\nPipeline failed: ${error.message}`));

// 4. Demonstrate error cases
console.log('\n4. Error handling examples:\n');

// Empty content
const emptyContent = { ...testContent, content: '' };
Effect.runPromise(
  pipe(
    saveContentEffect(emptyContent),
    Effect.catchTag('ValidationError', (error) =>
      Effect.sync(() => console.log(`Validation failed: ${error.message}`)),
    ),
    Effect.catchTag('DatabaseError', (error) => Effect.sync(() => console.log(`Database failed: ${error.message}`))),
  ),
);

// 5. Composing multiple operations
console.log('\n5. Batch processing with Effect:\n');

const contents = [
  { ...testContent, id: 'test-1', title: 'Issue 1' },
  { ...testContent, id: 'test-2', title: 'Issue 2', content: '' }, // This will fail
  { ...testContent, id: 'test-3', title: 'Issue 3' },
];

const batchSave = pipe(
  contents,
  Effect.forEach(
    (content) =>
      pipe(
        saveContentEffect(content),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.log(`  ✗ Failed to save ${content.id}: ${error.message}`);
            return null;
          }),
        ),
      ),
    { concurrency: 2 }, // Process 2 at a time
  ),
  Effect.map((results) => {
    const succeeded = results.filter((r) => r !== null).length;
    console.log(`\nBatch complete: ${succeeded}/${contents.length} succeeded`);
  }),
);

Effect.runPromise(batchSave);
