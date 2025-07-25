import { ConfigManager } from '../../lib/config.js';
import { ContentManager } from '../../lib/content-manager.js';
import { OllamaClient } from '../../lib/ollama.js';
import { formatSmartDate } from '../../lib/utils/date-formatter.js';

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
      console.log('No results found');
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
    console.error('Search failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

function displaySearchResults(
  results: Array<{
    content: {
      id: string;
      title?: string;
      source: string;
      createdAt?: string | number;
      updatedAt?: string | number;
      metadata?: Record<string, unknown>;
    };
    snippet?: string;
  }>,
  _totalCount: number,
) {
  // YAML output for LLM compatibility with color highlighting
  results.slice(0, 10).forEach((result, index) => {
    const { content, snippet } = result;
    const type = content.source === 'jira' ? 'issue' : 'page';
    const key = content.id.replace(/^(jira|confluence):/, '');
    // Remove redundant key from title if present
    let title = content.title || 'Untitled';
    if (title.startsWith(`${key}: `)) {
      title = title.substring(key.length + 2);
    }
    // Handle date properly - convert from milliseconds if needed
    let updated = null;
    if (content.updatedAt) {
      const timestamp = typeof content.updatedAt === 'string' ? parseInt(content.updatedAt) : content.updatedAt;
      // If timestamp is in milliseconds (>= year 2001), use as is, otherwise multiply by 1000
      const dateValue = timestamp >= 978307200000 ? timestamp : timestamp * 1000;
      updated = formatSmartDate(dateValue);
    }

    let created = null;
    if (content.createdAt) {
      const timestamp = typeof content.createdAt === 'string' ? parseInt(content.createdAt) : content.createdAt;
      // If timestamp is in milliseconds (>= year 2001), use as is, otherwise multiply by 1000
      const dateValue = timestamp >= 978307200000 ? timestamp : timestamp * 1000;
      created = formatSmartDate(dateValue);
    }

    // YAML output
    console.log(`- type: ${type}`);
    console.log(`  key: ${key}`);
    console.log(`  title: ${title}`);
    if (created) {
      console.log(`  created: ${created}`);
    }
    if (updated) {
      console.log(`  updated: ${updated}`);
    }
    if (content.metadata?.status) {
      console.log(`  status: ${String(content.metadata.status)}`);
    }
    if (content.metadata?.priority) {
      const priority = String(content.metadata.priority);
      console.log(`  priority: ${priority}`);
    }
    if (content.metadata?.assignee) {
      console.log(`  assignee: ${content.metadata.assignee}`);
    }
    if (snippet) {
      const cleanSnippet = snippet
        .replace(/<mark>/g, '')
        .replace(/<\/mark>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate at word boundary with ellipsis
      const maxLength = 150;
      let truncated = cleanSnippet;
      if (cleanSnippet.length > maxLength) {
        const lastSpace = cleanSnippet.lastIndexOf(' ', maxLength);
        truncated = `${cleanSnippet.substring(0, lastSpace > 0 ? lastSpace : maxLength)}...`;
      }

      console.log(`  description: |`);
      console.log(`    ${truncated}`);
    }

    // Only add empty line between results, not after the last one
    if (index < results.slice(0, 10).length - 1) {
      console.log();
    }
  });
}

export async function ask(question: string) {
  try {
    const configManager = new ConfigManager();
    const config = await configManager.getConfig();
    const settings = await configManager.getSettings();

    if (!config) {
      console.error('Configuration not found. Run "ji auth" first.');
      process.exit(1);
    }

    console.log('Searching for relevant content...\n');

    // Search for relevant content
    const contentManager = new ContentManager();
    const searchResults = await contentManager.searchContent(question);

    if (searchResults.length === 0) {
      console.log('No relevant content found in your workspace.');
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

    console.log('Generating answer...\n');

    const response = await ollama.generate(prompt, {
      model: settings.askModel || 'gemma2:2b',
    });

    console.log('Answer:\n');
    console.log(response);

    // Show sources
    console.log('\nSources:');
    for (const result of searchResults.slice(0, 5)) {
      const type = result.source === 'jira' ? 'Jira' : 'Confluence';
      const key = result.id.replace(/^(jira|confluence):/, '');
      console.log(`- ${type}: ${key} - ${result.title}`);
    }

    configManager.close();
  } catch (error) {
    console.error('Failed to generate answer:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
