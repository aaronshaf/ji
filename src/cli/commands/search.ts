import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { formatTimeAgo } from '../formatters/time.js';

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
    const configManager = new ConfigManager();
    const config = await configManager.getConfig();

    if (!config) {
      console.error('No configuration found. Please run "ji auth" first.');
      process.exit(1);
    }

    // Use Jira API for search (JQL text search)
    const jiraClient = new JiraClient(config);

    // Build JQL query for text search
    const jql = `text ~ "${query}" ORDER BY updated DESC`;

    try {
      const searchResult = await jiraClient.searchIssues(jql, { maxResults: limit });

      if (searchResult.issues.length === 0) {
        console.log('No results found');
        configManager.close();
        return;
      }

      // Display results in YAML format for LLM compatibility
      searchResult.issues.forEach((issue) => {
        console.log(`- type: issue`);
        console.log(`  key: ${issue.key}`);
        console.log(`  title: ${issue.fields.summary}`);
        console.log(`  status: ${issue.fields.status.name}`);
        console.log(`  priority: ${issue.fields.priority?.name || 'None'}`);
        console.log(`  assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}`);
        console.log(`  updated: ${formatTimeAgo(new Date(issue.fields.updated).getTime())}`);
        console.log(`  project: ${issue.key.split('-')[0]}`);

        // Show snippet of description if available
        if (issue.fields.description) {
          const description =
            typeof issue.fields.description === 'string'
              ? issue.fields.description
              : JSON.stringify(issue.fields.description);
          const snippet = description.replace(/\s+/g, ' ').trim().slice(0, 150);
          console.log(`  snippet: ${snippet}${snippet.length >= 150 ? '...' : ''}`);
        }
        console.log();
      });

      console.log(`Found ${searchResult.issues.length} result${searchResult.issues.length !== 1 ? 's' : ''}`);
    } catch (apiError) {
      console.error(`Search failed: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`);
      process.exit(1);
    }

    configManager.close();
  } catch (error) {
    console.error('Search failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

export async function askQuestion(question: string) {
  try {
    const configManager = new ConfigManager();
    const config = await configManager.getConfig();

    if (!config) {
      console.error('No configuration found. Please run "ji auth" first.');
      process.exit(1);
    }

    // For now, just perform a search with the question terms
    // Extract key terms from the question for JQL search
    const searchTerms = question
      .toLowerCase()
      .replace(/[?.,!;]/g, '')
      .split(/\s+/)
      .filter(
        (term) =>
          term.length > 2 &&
          !['how', 'what', 'when', 'where', 'why', 'who', 'the', 'and', 'for', 'are', 'can', 'will'].includes(term),
      )
      .slice(0, 3) // Take first 3 meaningful terms
      .join(' ');

    if (!searchTerms) {
      console.log('Could not extract meaningful search terms from question');
      configManager.close();
      return;
    }

    console.log(`Searching for: "${searchTerms}"`);
    console.log();

    // Use the search function
    await search(searchTerms, { limit: 5 });

    configManager.close();
  } catch (error) {
    console.error('Question processing failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
