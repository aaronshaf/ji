#!/usr/bin/env bun
/**
 * Demonstration of Effect integration for various leaf node functions
 * Shows Option types, validation, and error handling patterns
 */

import { Effect, Option, pipe } from 'effect';
import { ConfigManager } from '../config';
import { makeConfigEffect } from './config-effect';
import { 
  hashQuestion, 
  containsUncertainty
} from './memory-effect';
import { 
  confluenceToMarkdown, 
  extractTeamOwnership,
  normalizeText,
  extractCodeBlocks 
} from './text-transform-effect';

async function main() {
  console.log('=== Effect Leaf Node Integration Demo ===\n');

  // 1. Configuration with Option
  console.log('1. Configuration Settings (Option pattern):\n');
  
  const configManager = new ConfigManager();
  const configEffect = makeConfigEffect(configManager);
  
  // Get optional settings
  await pipe(
    configEffect.getSettings(['theme', 'pageSize', 'nonExistent']),
    Effect.tap(settingsMap => 
      Effect.sync(() => {
        settingsMap.forEach((value, key) => {
          const display = Option.match(value, {
            onNone: () => 'not set',
            onSome: (v) => v
          });
          console.log(`  ${key}: ${display}`);
        });
      })
    ),
    Effect.runPromise
  );

  // Get required setting with error handling
  console.log('\n  Getting required setting:');
  await pipe(
    configEffect.getRequiredSetting('jiraUrl'),
    Effect.match({
      onFailure: (error) => console.log(`  Error: ${error.message}`),
      onSuccess: (value) => console.log(`  jiraUrl: ${value}`)
    }),
    Effect.runPromise
  );

  // 2. Hash functions with validation
  console.log('\n2. Question Hashing with Validation:\n');
  
  const questions = [
    'How do I configure authentication?',
    '  ', // Empty
    'a b', // Too short
    'What is the @#$% best way to handle errors?'
  ];
  
  for (const q of questions) {
    await pipe(
      hashQuestion(q),
      Effect.match({
        onFailure: (error) => console.log(`  "${q}" -> Error: ${error.message}`),
        onSuccess: (hash) => console.log(`  "${q}" -> ${hash}`)
      }),
      Effect.runPromise
    );
  }

  // 3. Text analysis
  console.log('\n3. Uncertainty Detection:\n');
  
  const facts = [
    'The system uses OAuth2 for authentication',
    'This might be causing the issue',
    'It seems like the cache is corrupted',
    ''
  ];
  
  for (const fact of facts) {
    await pipe(
      containsUncertainty(fact),
      Effect.match({
        onFailure: (error) => console.log(`  Error: ${error.message}`),
        onSuccess: (hasUncertainty) => 
          console.log(`  "${fact}" -> ${hasUncertainty ? 'uncertain' : 'certain'}`)
      }),
      Effect.runPromise
    );
  }

  // 4. Text transformation
  console.log('\n4. Confluence to Markdown Conversion:\n');
  
  const confluenceContent = `
    <h1>Project Setup</h1>
    <p>This is a <strong>guide</strong> for setting up the project.</p>
    <ac:structured-macro ac:name="code">
      <ac:plain-text-body><![CDATA[npm install
npm run dev]]></ac:plain-text-body>
    </ac:structured-macro>
  `;
  
  await pipe(
    confluenceToMarkdown(confluenceContent),
    Effect.tap(markdown => 
      Effect.sync(() => {
        console.log('  Converted:');
        console.log(markdown.split('\n').map(line => `    ${line}`).join('\n'));
      })
    ),
    Effect.catchAll(error => 
      Effect.sync(() => console.log(`  Error: ${error.message}`))
    ),
    Effect.runPromise
  );

  // 5. Extract team ownership
  console.log('\n5. Team Ownership Extraction (Option):\n');
  
  const markdownContent = `
# Project Overview

## Team
Engineering Platform

## Tech Lead
John Smith

## Description
This service handles authentication...
  `;
  
  await pipe(
    extractTeamOwnership(markdownContent),
    Effect.tap(ownership => 
      Effect.sync(() => {
        const display = Option.match(ownership, {
          onNone: () => 'No team/owner found',
          onSome: ({ team, owner }) => `Team: ${team}, Owner: ${owner}`
        });
        console.log(`  ${display}`);
      })
    ),
    Effect.runPromise
  );

  // 6. Text normalization
  console.log('\n6. Text Normalization:\n');
  
  const texts = [
    'Hello   World!!!',
    'Testing @#$ Special-Characters',
    ''
  ];
  
  for (const text of texts) {
    await pipe(
      normalizeText(text, { maxLength: 20 }),
      Effect.match({
        onFailure: (error) => console.log(`  "${text}" -> Error: ${error.message}`),
        onSuccess: (normalized) => console.log(`  "${text}" -> "${normalized}"`)
      }),
      Effect.runPromise
    );
  }

  // 7. Extract code blocks
  console.log('\n7. Code Block Extraction:\n');
  
  const markdownWithCode = `
Here's some text.

\`\`\`typescript
const hello = "world";
console.log(hello);
\`\`\`

And more text.

\`\`\`bash
npm install effect
\`\`\`
  `;
  
  await pipe(
    extractCodeBlocks(markdownWithCode),
    Effect.tap(blocks => 
      Effect.sync(() => {
        console.log(`  Found ${blocks.length} code blocks:`);
        blocks.forEach((block, i) => {
          console.log(`    ${i + 1}. Language: ${block.language}, Lines: ${block.code.split('\n').length}`);
        });
      })
    ),
    Effect.runPromise
  );

  // 8. Composing multiple operations
  console.log('\n8. Composed Pipeline:\n');
  
  const processContent = (content: string) => pipe(
    // Convert to markdown
    confluenceToMarkdown(content),
    // Extract team info
    Effect.flatMap(markdown => 
      pipe(
        extractTeamOwnership(markdown),
        Effect.map(teamOption => ({ markdown, teamOption }))
      )
    ),
    // Normalize for search
    Effect.flatMap(({ markdown, teamOption }) =>
      pipe(
        normalizeText(markdown, { maxLength: 100 }),
        Effect.map(normalized => ({ markdown, teamOption, normalized }))
      )
    )
  );
  
  await pipe(
    processContent(confluenceContent),
    Effect.match({
      onFailure: (error) => console.log(`  Pipeline failed: ${error.message}`),
      onSuccess: ({ normalized, teamOption }) => {
        console.log(`  Normalized: "${normalized}"`);
        console.log(`  Team info: ${Option.isNone(teamOption) ? 'Not found' : 'Found'}`);
      }
    }),
    Effect.runPromise
  );

  // Cleanup
  configManager.close();
  
  console.log('\n✓ Demo complete');
}

main().catch(console.error);