# ji take Command Specification

## Overview

The `ji take` command assigns a Jira issue to the current authenticated user. It provides a quick way to take ownership of unassigned issues or reassign issues from other users.

## Requirements

### Command Invocation

1. When `ji take <issue-key>` is invoked, the system shall assign the specified issue to the current authenticated user.

2. When the issue key is not provided, the system shall display an error message and show help text.

### Issue Assignment

3. The system shall validate that the issue key exists in the Jira instance.

4. When the issue exists, the system shall update the assignee field to the current user.

5. When assignment is successful, the system shall display a confirmation message in the format:
   `✓ Assigned <issue-key> to you`

6. After successful assignment, the system shall update the local cache with the new assignee information.

### Error Handling

7. If authentication is not configured, the system shall display an error message directing the user to run `ji auth` first.

8. If the issue key does not exist, the system shall display:
   `Error: Issue <issue-key> not found`

9. If the user lacks permission to assign the issue, the system shall display:
   `Error: You don't have permission to assign issue <issue-key>`

10. If the Jira API is unreachable, the system shall display:
    `Error: Unable to connect to Jira. Please check your connection.`

11. For any other assignment failure, the system shall display the specific error returned by Jira.

### Cache Management

12. When assignment is successful, the system shall update the cached issue data with the new assignee.

13. When cache update fails, the system shall silently continue without affecting the assignment operation.

### Performance

14. The system shall complete the assignment operation within 5 seconds under normal network conditions.

15. The system shall provide immediate feedback to the user while the assignment is being processed.

## Example Usage

### Successful assignment
```bash
$ ji take EVAL-123
✓ Assigned EVAL-123 to you
```

### Issue not found
```bash
$ ji take INVALID-999
Error: Issue INVALID-999 not found
```

### Missing issue key
```bash
$ ji take
Please specify an issue key

ji take - Assign an issue to yourself

Usage:
  ji take <issue-key>
```

### Permission denied
```bash
$ ji take RESTRICTED-456
Error: You don't have permission to assign issue RESTRICTED-456
```

## Implementation Notes

- Uses Jira REST API PUT /rest/api/3/issue/{issueIdOrKey} endpoint
- Updates assignee field with current user's account ID
- Handles both issue keys (e.g., EVAL-123) and issue IDs
- Graceful error handling with user-friendly messages
- Cache synchronization for immediate reflection in `ji mine` command