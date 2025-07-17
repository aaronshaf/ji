# ji sync Command Specification

## Overview

The `ji sync` command synchronizes both Jira projects and Confluence spaces from the remote Atlassian instances to the local SQLite database. It serves as the primary data refresh mechanism for the ji CLI.

## Requirements

### Command Invocation

1. When `ji sync` is invoked, the system shall synchronize all active workspaces (both Jira projects and Confluence spaces).

2. When `ji sync --clean` is invoked, the system shall perform a clean sync by removing all existing data before fetching fresh content.

3. When `ji sync --help` is invoked, the system shall display comprehensive help information.

### Workspace Discovery

4. The system shall automatically discover active workspaces from the user's Jira and Confluence instances.

5. For Jira, the system shall sync projects where the user has browse permission.

6. For Confluence, the system shall sync spaces where the user has read permission.

### Sync Strategy

7. The system shall use incremental sync by default, only fetching content that has changed since the last sync.

8. The system shall track last sync timestamps for each workspace to enable efficient incremental updates.

9. When using `--clean` flag, the system shall:
   - Clear all existing issues and pages from the database
   - Reset all sync timestamps
   - Fetch all content fresh from the APIs

### Jira Sync Process

10. For each Jira project, the system shall:
    - Fetch all issues using JQL queries
    - Process issues in batches of 50 for optimal performance
    - Store complete issue data including custom fields
    - Update the full-text search index

11. The system shall sync these Jira data types:
    - Issues (all fields, comments, attachments metadata)
    - Project metadata (name, key, description)
    - Issue transitions and workflow states
    - Custom field definitions

### Confluence Sync Process

12. For each Confluence space, the system shall:
    - Fetch pages using the Confluence REST API
    - Process pages in batches of 50
    - Convert page content to searchable text format
    - Store page metadata and content

13. The system shall sync these Confluence data types:
    - Page content (title, body, metadata)
    - Space information (key, name, description)
    - Page hierarchy and parent relationships
    - Labels and page properties

### Progress Reporting

14. During sync, the system shall display real-time progress:
    ```
    Syncing workspaces...
    
    Jira Projects:
    ✓ EVAL: 150 issues synced
    ⏳ CFA: 45/120 issues...
    
    Confluence Spaces:
    ✓ DOC: 25 pages synced
    ⏳ ENG: 12/30 pages...
    ```

15. The system shall show total sync time and summary statistics upon completion.

### Error Handling

16. If authentication is not configured, the system shall display an error and direct user to run `ji auth`.

17. If a workspace sync fails, the system shall:
    - Log the error details
    - Continue syncing other workspaces
    - Report failed workspaces in the final summary

18. For network timeouts, the system shall:
    - Retry failed requests up to 3 times
    - Use exponential backoff for retry delays
    - Skip problematic items and continue

19. For permission errors, the system shall:
    - Skip inaccessible workspaces
    - Log permission issues for user awareness
    - Continue with accessible content

### Performance Optimization

20. The system shall use parallel processing for multiple workspaces when possible.

21. For large datasets (>1000 items), the system shall:
    - Process in smaller batches
    - Show progress updates every 100 items
    - Use database transactions for efficiency

22. The system shall implement request rate limiting to avoid API throttling.

### Cache and Index Management

23. After successful sync, the system shall update the full-text search index automatically.

24. The system shall maintain sync metadata including:
    - Last sync timestamp for each workspace
    - Item counts and sync statistics
    - Error logs and retry attempts

25. When sync completes, the system shall display summary statistics:
    ```
    Sync completed in 45.2 seconds
    
    Jira: 2 projects, 275 issues
    Confluence: 3 spaces, 67 pages
    Search index: Updated with 342 items
    ```

### Background Sync

26. The system shall support background sync operations that don't block the CLI.

27. When background sync is active, other commands shall continue to work with cached data.

## Example Usage

### Standard sync
```bash
$ ji sync

Syncing workspaces...

Jira Projects:
✓ EVAL: 150 issues synced
✓ CFA: 120 issues synced

Confluence Spaces:
✓ DOC: 25 pages synced
✓ ENG: 30 pages synced

Sync completed in 45.2 seconds

Jira: 2 projects, 270 issues
Confluence: 2 spaces, 55 pages
Search index: Updated with 325 items
```

### Clean sync
```bash
$ ji sync --clean

Clearing existing data...
Syncing workspaces...

Jira Projects:
✓ EVAL: 150 issues synced (fresh)
✓ CFA: 120 issues synced (fresh)

Confluence Spaces:
✓ DOC: 25 pages synced (fresh)
✓ ENG: 30 pages synced (fresh)

Clean sync completed in 2 minutes 15 seconds

Jira: 2 projects, 270 issues
Confluence: 2 spaces, 55 pages
Search index: Rebuilt with 325 items
```

### Sync with errors
```bash
$ ji sync

Syncing workspaces...

Jira Projects:
✓ EVAL: 150 issues synced
✗ RESTRICTED: Permission denied

Confluence Spaces:
✓ DOC: 25 pages synced
✗ PRIVATE: Access forbidden

Sync completed with errors in 32.1 seconds

Jira: 1 project, 150 issues (1 failed)
Confluence: 1 space, 25 pages (1 failed)
Search index: Updated with 175 items

Note: Some workspaces were skipped due to permission issues.
```

## Implementation Notes

- Uses Jira REST API v3 and Confluence REST API v2
- Implements incremental sync with timestamp tracking
- Batch processing for optimal API usage
- Parallel workspace processing where possible
- Comprehensive error handling with graceful degradation
- Automatic search index maintenance
- Database transaction management for data integrity
- Rate limiting to respect API quotas