# ji issue Command Specification

## Overview

The `ji issue` command provides subcommands for viewing and synchronizing Jira issues. It serves as a namespace for issue-related operations.

## Requirements

### Command Structure

1. When `ji issue` is invoked without subcommands, the system shall display help information.

2. When `ji issue --help` is invoked, the system shall display comprehensive help for all issue subcommands.

### Issue View Subcommand

3. When `ji issue view <issue-key>` is invoked, the system shall display detailed information about the specified issue.

4. When `ji issue view <issue-key> --json` is invoked, the system shall output the issue data in JSON format.

5. The issue view shall display in YAML format by default:
   ```yaml
   key: EVAL-123
   summary: Fix login authentication bug
   description: |
     Users are unable to log in using their email addresses...
   status: In Progress
   priority: High
   assignee: John Doe
   reporter: Jane Smith
   created: 2023-12-01T10:30:00Z
   updated: 2023-12-05T14:22:00Z
   ```

6. When `--json` flag is used, the system shall output the complete issue object as returned by Jira API.

### Issue Sync Subcommand

7. When `ji issue sync <project-key>` is invoked, the system shall synchronize all issues from the specified project to the local cache.

8. When `ji issue sync <project-key> --clean` is invoked, the system shall:
   - Remove all existing issues for that project from local cache
   - Fetch all issues from the project fresh from Jira
   - Store them in the local cache

9. During sync, the system shall display progress information:
   - Total number of issues to sync
   - Current progress (e.g., "Syncing issues... 50/200")
   - Completion confirmation

### Data Display

10. Issue view shall include all standard fields:
    - Key, summary, description
    - Status, priority, issue type
    - Assignee, reporter
    - Created and updated timestamps
    - Labels and components (if any)

11. Issue view shall include custom fields when available:
    - Story points
    - Acceptance criteria
    - Sprint information
    - Any other configured custom fields

12. All timestamps shall be displayed in ISO 8601 format for consistency.

13. Multi-line text fields (description, acceptance criteria) shall use YAML literal block format with proper indentation.

### Caching Behavior

14. Issue view shall prioritize local cache for immediate display when available.

15. If issue is not in cache or cache is stale (>24 hours), the system shall fetch fresh data from Jira.

16. After fetching fresh data, the system shall update the local cache automatically.

### Error Handling

17. If authentication is not configured, the system shall display an error and direct user to run `ji auth`.

18. If the issue key does not exist, the system shall display:
    `Error: Issue <issue-key> not found`

19. If the project key does not exist during sync, the system shall display:
    `Error: Project <project-key> not found or not accessible`

20. If sync fails due to network issues, the system shall:
    - Display appropriate error message
    - Preserve any existing cached data
    - Suggest trying again later

21. For permission errors, the system shall display:
    `Error: You don't have permission to access <resource>`

### Performance

22. Issue view from cache shall load in under 100ms.

23. Fresh issue fetch shall complete within 5 seconds under normal conditions.

24. Sync operations shall process issues in batches of 50 for optimal performance.

25. Large project syncs (>1000 issues) shall display progress updates every 100 issues.

## Example Usage

### View issue (YAML format)
```bash
$ ji issue view EVAL-123

key: EVAL-123
summary: Fix login authentication bug
description: |
  Users are unable to log in using their email addresses.
  The authentication service is returning 401 errors.
status: In Progress
priority: High
assignee: John Doe
reporter: Jane Smith
created: 2023-12-01T10:30:00Z
updated: 2023-12-05T14:22:00Z
```

### View issue (JSON format)
```bash
$ ji issue view EVAL-123 --json
{
  "id": "12345",
  "key": "EVAL-123",
  "fields": {
    "summary": "Fix login authentication bug",
    "description": "Users are unable to log in...",
    ...
  }
}
```

### Sync project issues
```bash
$ ji issue sync EVAL
Syncing issues from project EVAL...
Fetched 150 issues
✓ Synchronized 150 issues from EVAL project
```

### Clean sync project
```bash
$ ji issue sync EVAL --clean
Clearing existing issues for project EVAL...
Syncing issues from project EVAL...
Fetched 150 issues
✓ Clean sync complete: 150 issues from EVAL project
```

## Implementation Notes

- Uses Jira REST API for issue retrieval
- Supports both issue keys and issue IDs
- YAML output formatted for human readability
- JSON output preserves complete API response structure
- Batch processing for efficient sync operations
- Comprehensive error handling with user-friendly messages
- Cache integration for optimal performance