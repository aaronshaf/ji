# ji mine Command Specification

## Overview

The `ji mine` command displays open issues assigned to the current user using a React-based terminal UI powered by Ink. It shows cached data immediately, then updates with fresh data from Jira.

## Requirements

### Command Invocation

1. When `ji mine` is invoked, the system shall display all open issues assigned to the current user.

2. When `ji mine --project <key>` is invoked, the system shall display only issues from the specified project key.

3. When the project filter is specified, the system shall convert the project key to uppercase for matching.

### Data Loading Strategy

4. When displaying issues, the system shall first show cached data immediately from the local SQLite database.

5. After showing cached data, the system shall fetch fresh data from Jira API in the background.

6. When fresh data is available, the system shall update the display seamlessly without flickering.

7. While fetching fresh data, the system shall show an animated spinner with "updating..." text.

### Sorting and Organization

8. The system shall sort issues consistently in both cached and fresh data by:
   - First by priority (Highest → High → Medium → Low → Lowest → None → Unassigned!)
   - Then by updated date (most recent first)

9. The system shall group issues by project key and sort projects alphabetically.

10. Within each project, issues shall be sorted according to the priority and date rules above.

### Display Format

11. The system shall format output in YAML style:
    ```yaml
    projects:
    - name: CFA
      issues:
      - key: CFA-98
        title: Use dynamic imports instead of custom up/down readiness system
        status: In Progress
        updated: about 4 hours ago
      - key: CFA-89
        title: Remove jest-transform-yaml dependency
        status: Blocked - External
        updated: about 12 hours ago
    ```

12. The system shall color-code issue status:
    - Blue: In Progress, Development
    - Magenta: Review, Feedback
    - Green: Done, Complete
    - Red: Blocked
    - Yellow: Todo, Open
    - White: Other statuses

13. The system shall display relative timestamps (e.g., "about 4 hours ago", "2 days ago").

### Project Filtering

14. When using `--project` filter, the system shall accept both formats:
    - `ji mine --project CFA`
    - `ji mine --project=CFA`

15. When project filtering returns no results, the system shall display:
    "No open issues assigned to you in project <PROJECT>."

### Performance and Caching

16. The system shall load cached data in under 100ms for immediate display.

17. When fetching fresh data, the system shall only request data for projects that have cached issues (optimization).

18. When project filter is specified, the system shall only fetch fresh data for that specific project.

19. After fetching fresh data, the system shall update the local cache with new issue details.

### Data Consistency

20. The system shall handle both timestamp formats:
    - ISO date strings from API responses
    - Unix timestamps from cached data

21. The system shall handle various priority naming conventions:
    - Standard names: Highest, High, Medium, Low, Lowest
    - Jira shorthand: P1, P2, P3, P4, P5
    - Custom values: None, Unassigned!

### Visual Feedback

22. On initial load, the system shall show a spinner with "Loading issues..." text.

23. During background refresh, the system shall show a spinner with "updating..." text next to the projects header.

24. The system shall not show "Updated with latest data" message after refresh.

25. The system shall automatically exit after displaying data and completing background refresh.

### Spacing and Layout

26. The system shall not add extra line breaks at the bottom of the output.

27. The system shall use consistent spacing between projects (1 line) except for the last project.

### Error Handling

28. If authentication is not configured, the system shall display an error and direct user to run `ji auth`.

29. If cached data loading fails, the system shall display "Failed to load cached issues" error.

30. If fresh data fetching fails, the system shall silently continue with cached data only.

31. If individual issue cache updates fail, the system shall continue processing other issues.

### Empty State

32. When no issues are found, the system shall display:
    "No open issues assigned to you."
    "💡 Run 'ji sync' to update your workspaces."

33. When using project filter with no results, the system shall display project-specific message.

## Example Usage

### Show all issues
```bash
$ ji mine

projects:
- name: CFA
  issues:
  - key: CFA-98
    title: Use dynamic imports instead of custom up/down readiness system
    status: In Progress
    updated: about 4 hours ago

- name: EVAL
  issues:
  - key: EVAL-5628
    title: Missing RCE Options in Assignment Comments
    status: Open
    updated: about 7 hours ago
```

### Show filtered by project
```bash
$ ji mine --project EVAL

projects:
- name: EVAL
  issues:
  - key: EVAL-5628
    title: Missing RCE Options in Assignment Comments
    status: Open
    updated: about 7 hours ago
```

## Implementation Notes

- Built with Ink (React for CLI) and ink-spinner
- Uses Effect for configuration management and error handling
- React hooks for state management (cached vs fresh data)
- Consistent sorting across both data sources
- Optimized API calls based on available cached data
- Graceful error handling with fallback to cached data