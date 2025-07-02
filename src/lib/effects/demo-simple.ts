#!/usr/bin/env bun
/**
 * Simple demonstration of Effect patterns for leaf node functions
 */

import { Effect, pipe } from 'effect';
import { 
  hashQuestion, 
  containsUncertainty
} from './memory-effect';
import { 
  confluenceToMarkdown, 
  normalizeText
} from './text-transform-effect';

async function main() {
  console.log('=== Simple Effect Patterns Demo ===\n');

  // 1. Hash validation
  console.log('1. Question Hashing:\n');
  
  const question = 'How do I configure authentication?';
  const emptyQuestion = '  ';
  
  const hash1 = await Effect.runPromise(
    pipe(
      hashQuestion(question),
      Effect.match({
        onFailure: (error) => `Error: ${error.message}`,
        onSuccess: (hash) => `Hash: ${hash}`
      })
    )
  );
  console.log(`  "${question}" -> ${hash1}`);
  
  const hash2 = await Effect.runPromise(
    pipe(
      hashQuestion(emptyQuestion),
      Effect.match({
        onFailure: (error) => `Error: ${error.message}`,
        onSuccess: (hash) => `Hash: ${hash}`
      })
    )
  );
  console.log(`  "${emptyQuestion}" -> ${hash2}`);

  // 2. Uncertainty detection
  console.log('\n2. Uncertainty Detection:\n');
  
  const certainFact = 'The system uses OAuth2 for authentication';
  const uncertainFact = 'This might be causing the issue';
  
  const certain = await Effect.runPromise(
    containsUncertainty(certainFact)
  );
  console.log(`  "${certainFact}" -> ${certain ? 'uncertain' : 'certain'}`);
  
  const uncertain = await Effect.runPromise(
    containsUncertainty(uncertainFact)
  );
  console.log(`  "${uncertainFact}" -> ${uncertain ? 'uncertain' : 'certain'}`);

  // 3. Text transformation
  console.log('\n3. Confluence to Markdown:\n');
  
  const html = '<h1>Title</h1><p>Some <strong>bold</strong> text.</p>';
  
  const markdown = await Effect.runPromise(
    pipe(
      confluenceToMarkdown(html),
      Effect.match({
        onFailure: (error) => `Error: ${error.message}`,
        onSuccess: (md) => md
      })
    )
  );
  console.log('  Input:', html);
  console.log('  Output:', markdown);

  // 4. Text normalization
  console.log('\n4. Text Normalization:\n');
  
  const messyText = 'Hello   World!!!   @#$%';
  
  const normalized = await Effect.runPromise(
    pipe(
      normalizeText(messyText),
      Effect.match({
        onFailure: (error) => `Error: ${error.message}`,
        onSuccess: (text) => text
      })
    )
  );
  console.log(`  "${messyText}" -> "${normalized}"`);

  // 5. Composing effects
  console.log('\n5. Composed Pipeline:\n');
  
  const processAndHash = (content: string) => pipe(
    confluenceToMarkdown(content),
    Effect.flatMap(markdown => normalizeText(markdown, { maxLength: 50 })),
    Effect.flatMap(normalized => hashQuestion(normalized))
  );
  
  const result = await Effect.runPromise(
    pipe(
      processAndHash(html),
      Effect.match({
        onFailure: (error) => `Pipeline failed: ${error.message}`,
        onSuccess: (hash) => `Final hash: ${hash}`
      })
    )
  );
  console.log(`  ${result}`);

  console.log('\n✓ Demo complete');
}

main().catch(console.error);