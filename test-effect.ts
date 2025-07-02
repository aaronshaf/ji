#!/usr/bin/env bun
import { Effect, pipe } from 'effect';
import { OllamaClient } from './src/lib/ollama';

console.log('Testing Effect integration with contentHash\n');

// Test 1: Valid content
console.log('Test 1: Valid content');
const validHash = pipe(
  OllamaClient.contentHashEffect('Hello, Effect!'),
  Effect.matchEffect({
    onFailure: (error) => Effect.succeed(`Error: ${error.message}`),
    onSuccess: (hash) => Effect.succeed(`Success: ${hash}`)
  }),
  Effect.runSync
);
console.log(validHash);

// Test 2: Empty content (should fail)
console.log('\nTest 2: Empty content');
const emptyHash = pipe(
  OllamaClient.contentHashEffect(''),
  Effect.matchEffect({
    onFailure: (error) => Effect.succeed(`Error: ${error.message}`),
    onSuccess: (hash) => Effect.succeed(`Success: ${hash}`)
  }),
  Effect.runSync
);
console.log(emptyHash);

// Test 3: Large content
console.log('\nTest 3: Large content');
const largeContent = 'x'.repeat(11_000_000); // 11MB
const largeHash = pipe(
  OllamaClient.contentHashEffect(largeContent),
  Effect.matchEffect({
    onFailure: (error) => Effect.succeed(`Error: ${error.message}`),
    onSuccess: (hash) => Effect.succeed(`Success: ${hash}`)
  }),
  Effect.runSync
);
console.log(largeHash);

// Test 4: Backward compatibility
console.log('\nTest 4: Backward compatibility');
console.log('Valid content:', OllamaClient.contentHash('Test'));
console.log('Empty content:', OllamaClient.contentHash('')); // Should fallback gracefully

// Test 5: Composing Effects
console.log('\nTest 5: Composing multiple Effects');
const pipeline = pipe(
  Effect.succeed('Initial content'),
  Effect.flatMap((content) => OllamaClient.contentHashEffect(content)),
  Effect.flatMap((hash) => OllamaClient.contentHashEffect(hash)), // Hash the hash
  Effect.map((doubleHash) => `Double hash: ${doubleHash}`)
);

const pipelineResult = Effect.runSync(
  Effect.matchEffect(pipeline, {
    onFailure: (error) => Effect.succeed(`Pipeline failed: ${error.message}`),
    onSuccess: (result) => Effect.succeed(result)
  })
);
console.log(pipelineResult);