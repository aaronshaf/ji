import chalk from 'chalk';
import { MeilisearchAdapter } from '../../lib/meilisearch-adapter.js';
import { ContentManager } from '../../lib/content-manager.js';
import { OllamaClient } from '../../lib/ollama.js';
import { ConfigManager } from '../../lib/config.js';
import { formatDistanceToNow } from 'date-fns';

export async function search(query: string, options: { 
  source?: 'jira' | 'confluence',
  limit?: number,
  includeAll?: boolean
} = {}) {
  const limit = options.limit || 10;
  
  try {
    // Try Meilisearch first (if available)
    try {
      const meilisearch = new MeilisearchAdapter();
      const results = await meilisearch.search(query, {
        source: options.source,
        limit,
        includeAll: options.includeAll
      });

      if (results.length === 0) {
        console.log(chalk.yellow('No results found'));
        return;
      }

      console.log(chalk.bold(`Found ${results.length} results:\n`));

      for (const result of results) {
        const { content, snippet } = result;
        const type = content.source === 'jira' ? chalk.blue('[JIRA]') : chalk.green('[CONFLUENCE]');
        const key = content.id.replace(/^(jira|confluence):/, '');
        const title = content.title || '';
        const updated = content.updatedAt ? chalk.gray(formatDistanceToNow(new Date(content.updatedAt), { addSuffix: true })) : '';
        
        console.log(`${type} ${chalk.bold(key)} ${title}`);
        if (updated) console.log(`  ${updated}`);
        
        if (snippet) {
          const preview = snippet
            .replace(/<mark>/g, chalk.yellow(''))
            .replace(/<\/mark>/g, '')
            .slice(0, 200)
            .trim();
          console.log(chalk.gray(`  ${preview}...`));
        }
        console.log();
      }
    } catch (meilisearchError) {
      // Fallback to SQLite FTS5 search
      console.log(chalk.gray('Using local search (Meilisearch not available)\n'));
      
      const contentManager = new ContentManager();
      const results = await contentManager.searchContent(query, {
        source: options.source,
        limit: options.limit
      });
      
      if (results.length === 0) {
        console.log(chalk.yellow('No results found'));
        return;
      }

      console.log(chalk.bold(`Found ${results.length} results:\n`));

      for (const result of results.slice(0, limit)) {
        const type = result.source === 'jira' ? chalk.blue('[JIRA]') : chalk.green('[CONFLUENCE]');
        const key = result.id.replace(/^(jira|confluence):/, '');
        const title = result.title || '';
        const updated = result.updatedAt ? chalk.gray(formatDistanceToNow(new Date(result.updatedAt), { addSuffix: true })) : '';
        
        console.log(`${type} ${chalk.bold(key)} ${title}`);
        if (updated) console.log(`  ${updated}`);
        
        // For SQLite results, show a preview of the content
        if (result.content) {
          const preview = result.content.slice(0, 200).trim();
          console.log(chalk.gray(`  ${preview}...`));
        }
        console.log();
      }
      
      contentManager.close();
    }
  } catch (error) {
    console.error(chalk.red('Search failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

export async function ask(question: string) {
  try {
    const configManager = new ConfigManager();
    const config = await configManager.getConfig();
    const settings = await configManager.getSettings();
    
    if (!config) {
      console.error(chalk.red('Configuration not found. Run "ji auth" first.'));
      process.exit(1);
    }

    console.log(chalk.gray('Searching for relevant content...\n'));

    // Search for relevant content
    const contentManager = new ContentManager();
    const searchResults = await contentManager.searchContent(question);
    
    if (searchResults.length === 0) {
      console.log(chalk.yellow('No relevant content found in your workspace.'));
      return;
    }

    // Prepare context from search results
    const context = searchResults.slice(0, 5).map(result => {
      const type = result.source === 'jira' ? 'Jira Issue' : 'Confluence Page';
      return `${type}: ${result.title}\n${result.content}`;
    }).join('\n\n---\n\n');

    // Generate answer using Ollama
    const ollama = new OllamaClient();
    const prompt = `Based on the following content from Jira and Confluence, please answer this question: "${question}"

Relevant content:
${context}

Please provide a clear and concise answer based on the information provided. If the information doesn't fully answer the question, mention what's missing.`;

    console.log(chalk.gray('Generating answer...\n'));

    const response = await ollama.generate(prompt, {
      model: settings.askModel || 'gemma2:2b'
    });

    console.log(chalk.bold('Answer:\n'));
    console.log(response);
    
    // Show sources
    console.log(chalk.gray('\nSources:'));
    for (const result of searchResults.slice(0, 5)) {
      const type = result.source === 'jira' ? 'Jira' : 'Confluence';
      const key = result.id.replace(/^(jira|confluence):/, '');
      console.log(chalk.gray(`- ${type}: ${key} - ${result.title}`));
    }
    
    configManager.close();
  } catch (error) {
    console.error(chalk.red('Failed to generate answer:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}