# ji search Command Specification

## Overview

The `ji search` command provides full-text search across both Jira issues and Confluence pages using the local SQLite FTS5 index. It returns relevant results with highlighting and supports various filtering options.

## Requirements

### Command Invocation

1. When `ji search <query>` is invoked, the system shall search across both Jira issues and Confluence pages using the provided query.

2. When no query is provided, the system shall display an error message and usage instructions.

### Search Options

3. When `ji search <query> --limit=N` is invoked, the system shall limit results to N items (default: 10).

4. When `ji search <query> --limit N` is invoked, the system shall accept the space-separated limit format.

5. When `ji search <query> --jira` is invoked, the system shall search only Jira content.

6. When `ji search <query> --confluence` is invoked, the system shall search only Confluence content.

7. When `ji search <query> --all` is invoked, the system shall include all matching results without truncation.

### Search Behavior

8. The system shall use SQLite FTS5 for full-text search with relevance ranking.

9. The system shall search across these Jira fields:
   - Issue key, summary, description
   - Comments, labels, components
   - Status, priority, assignee
   - Custom fields content

10. The system shall search across these Confluence fields:
    - Page title, content body
    - Space key, author
    - Labels and metadata

11. The system shall support phrase searches using quotes (e.g., "exact phrase").

12. The system shall support boolean operators (AND, OR, NOT) in queries.

### Result Display

13. The system shall format search results in YAML structure:
    ```yaml
    query: "login bug"
    total_results: 15
    showing: 10
    results:
    - type: jira
      key: EVAL-123
      title: Fix login authentication bug
      summary: Users are unable to log in using their email addresses...
      relevance_score: 0.95
      url: https://company.atlassian.net/browse/EVAL-123
    - type: confluence
      id: "98765"
      title: Authentication Troubleshooting Guide
      summary: This page contains steps to diagnose login issues...
      relevance_score: 0.87
      url: https://company.atlassian.net/wiki/spaces/DOC/pages/98765
    ```

14. The system shall highlight search terms in result summaries using markdown bold formatting.

15. Results shall be sorted by relevance score (highest first).

16. Each result shall include a clickable URL to the original content.

### Result Truncation

17. When results exceed the limit, the system shall show "showing X of Y total results".

18. Result summaries shall be truncated to 150 characters with "..." if longer.

19. When using `--all` flag, the system shall display all results without limit truncation.

### Performance

20. Search operations shall complete within 500ms for typical queries against local database.

21. The system shall automatically update search index when new content is synced.

22. For empty or very short queries (< 2 characters), the system shall display a helpful message.

### Error Handling

23. If the search index is not available, the system shall display:
    `Error: Search index not available. Run 'ji sync' to build the index.`

24. For malformed FTS5 queries, the system shall display:
    `Error: Invalid search query. Check your search syntax.`

25. If no results are found, the system shall display:
    ```yaml
    query: "nonexistent term"
    total_results: 0
    message: No results found. Try different search terms or run 'ji sync' to update content.
    ```

### Content Freshness

26. The system shall prioritize recently updated content in relevance scoring.

27. When search returns stale results, the system shall suggest running `ji sync` for fresh content.

### Special Query Types

28. For issue key patterns (e.g., "EVAL-123"), the system shall prioritize exact key matches.

29. For email patterns, the system shall search assignee and reporter fields effectively.

30. For date-related queries, the system shall support searches like "updated:today" or "created:last-week".

## Example Usage

### Basic search
```bash
$ ji search "login bug"

query: "login bug"
total_results: 15
showing: 10
results:
- type: jira
  key: EVAL-123
  title: Fix **login** authentication **bug**
  summary: Users are unable to **log in** using their email addresses. The authentication service is returning 401 errors when users attempt to **log in**...
  relevance_score: 0.95
  url: https://company.atlassian.net/browse/EVAL-123
```

### Limited results
```bash
$ ji search "deployment" --limit=3

query: "deployment"
total_results: 25
showing: 3
results:
[First 3 results...]
```

### Jira-only search
```bash
$ ji search "API error" --jira

query: "API error"
source: jira
total_results: 8
results:
[Jira issues only...]
```

### No results
```bash
$ ji search "nonexistent"

query: "nonexistent"
total_results: 0
message: No results found. Try different search terms or run 'ji sync' to update content.
```

## Implementation Notes

- Uses SQLite FTS5 for local full-text search
- No external search dependencies (removed Meilisearch)
- Instant response times from local database
- Relevance scoring based on term frequency and field importance
- Automatic index maintenance during sync operations
- Support for complex search expressions and operators
- Markdown formatting for result highlighting