import chalk from 'chalk';
import { formatDistanceToNow } from 'date-fns';
import { ConfigManager } from '../../lib/config.js';
import { ContentManager } from '../../lib/content-manager.js';
import { MeilisearchAdapter } from '../../lib/meilisearch-adapter.js';
import { OllamaClient } from '../../lib/ollama.js';

export async function search(
  query: string,
  options: {
    source?: 'jira' | 'confluence';
    limit?: number;
    includeAll?: boolean;
  } = {},
) {
  const limit = options.limit || 10;

  try {
    // Always use local SQLite search for instant results
    const contentManager = new ContentManager();
    const results = await contentManager.searchContent(query, {
      source: options.source,
      limit,
    });

    if (results.length === 0) {
      console.log(chalk.yellow('No results found'));
      contentManager.close();
      return;
    }

    // Convert ContentManager results to display format with truncated snippets
    const formattedResults = results.map((result) => {
      // Truncate content to 150 chars for cleaner display
      const truncatedContent = result.content
        ? result.content
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim()
            .slice(0, 150)
            .trim()
        : '';

      return {
        content: result,
        snippet: truncatedContent ? `${truncatedContent}...` : undefined,
      };
    });

    displaySearchResults(formattedResults, results.length);

    contentManager.close();
  } catch (error) {
    console.error(chalk.red('Search failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

function displaySearchResults(
  results: Array<{
    content: { id: string; title?: string; source: string; updatedAt?: string | number };
    snippet?: string;
  }>,
  totalCount: number,
) {
  const displayCount = Math.min(results.length, 10);
  console.log(chalk.bold(`Found ${totalCount} results (showing top ${displayCount}):\n`));
  console.log(chalk.gray('---'));

  results.slice(0, 10).forEach((result, index) => {
    const { content, snippet } = result;
    // Use "Issue" for jira and "Page" for confluence
    const type = content.source === 'jira' ? 'Issue' : 'Page';
    const key = content.id.replace(/^(jira|confluence):/, '');
    const title = content.title || 'Untitled';
    const updated = content.updatedAt
      ? formatDistanceToNow(
          new Date(typeof content.updatedAt === 'string' ? content.updatedAt : content.updatedAt * 1000),
          { addSuffix: true },
        )
      : 'unknown';

    console.log(`${chalk.blue(`- ${type}`)}: ${chalk.bold(key)}`);
    console.log(`  ${chalk.yellow(title)}`);
    console.log(`  ${chalk.dim(`Updated ${updated}`)}`);

    if (snippet) {
      const cleanSnippet = snippet
        .replace(/<mark>/g, '')
        .replace(/<\/mark>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      console.log(chalk.gray(`  ${cleanSnippet}`));
    }

    if (index < displayCount - 1) {
      console.log();
    }
  });

  console.log(chalk.gray('---'));
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
    const context = searchResults
      .slice(0, 5)
      .map((result) => {
        const type = result.source === 'jira' ? 'Jira Issue' : 'Confluence Page';
        return `${type}: ${result.title}\n${result.content}`;
      })
      .join('\n\n---\n\n');

    // Generate answer using Ollama
    const ollama = new OllamaClient();
    const prompt = `Based on the following content from Jira and Confluence, please answer this question: "${question}"

Relevant content:
${context}

Please provide a clear and concise answer based on the information provided. If the information doesn't fully answer the question, mention what's missing.`;

    console.log(chalk.gray('Generating answer...\n'));

    const response = await ollama.generate(prompt, {
      model: settings.askModel || 'gemma2:2b',
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
