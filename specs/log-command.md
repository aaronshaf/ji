# ji log Command Specification

## Overview

The `ji log` command provides an interactive interface for viewing and adding comments to Jira issues using a React-based terminal UI powered by Ink.

## Requirements

### Command Invocation

1. When `ji log <issue-key>` is invoked, the system shall display all existing comments for the specified issue in chronological order (oldest first).

2. When displaying comments, the system shall show in YAML format:
   - Comment author's display name
   - Comment timestamp (formatted as smart date)
   - Comment body text with proper indentation
   - Reactions with emojis (if any)

### Interactive Mode

3. After displaying all comments, the system shall enter interactive mode with an input box.

4. The input box shall display placeholder text: "Type /exit or Ctrl+C to quit, Ctrl+R to refresh"

5. When the user enters non-empty text and presses Enter, the system shall:
   - Post the comment to the Jira issue
   - Show "Posting comment..." while processing
   - Display the newly added comment immediately
   - Clear the input field for the next comment

6. When the user presses Enter with empty input, the system shall:
   - Do nothing (no error, no action)
   - Keep the input field ready

7. When the user types '/exit', the system shall:
   - Hide the input box
   - Exit gracefully, leaving only the comment history visible

8. When the user presses Ctrl+C, the system shall:
   - Hide the input box
   - Exit gracefully, leaving only the comment history visible

### Manual Refresh

9. When the user presses Ctrl+R, the system shall:
   - Show "Refreshing..." status
   - Fetch the latest comments from Jira
   - Update the display with any new comments
   - Not insert 'r' into the input field

### Auto-refresh

10. While in interactive mode, the system shall check for new comments every 2 minutes.

11. When new comments are detected during auto-refresh, the system shall:
    - Add the new comments to the display
    - Maintain the user's current input in the prompt
    - Not interrupt the user's typing

12. If auto-refresh fails due to network issues, the system shall:
    - Silently continue without displaying error messages
    - Retry on the next 2-minute interval

### Error Handling

13. If the issue key is not found, the system shall display an error message and exit.

14. If fetching comments fails initially, the system shall:
    - Display an error message
    - Exit the application

15. If posting a comment fails, the system shall:
    - Display the error message in red text
    - Remain in interactive mode
    - Allow the user to try again

### Display Format

16. The system shall format comment display in YAML style:
    ```yaml
    issue: EVAL-5756
    comments:
    - author: John Doe
      time: 3 days ago
      comment: |
        Started working on this issue. The main problem seems to be...
    - author: Jane Smith
      time: 2 days ago
      reactions: 👍 John Doe | ❤️ Alice
      comment: |
        I've reviewed the code and found a potential fix...
    ```

17. The input box shall be:
    - Surrounded by a light gray rounded border
    - Show "> " prompt when ready for input
    - Hidden completely when exiting

### Authentication

18. If no authentication is configured, the system shall display an error message directing the user to run `ji auth` first.

### Performance

19. The initial load shall show "Loading comments..." spinner

20. While posting a comment, the input area shall show "Posting comment..."

21. While refreshing (Ctrl+R), the input area shall show "Refreshing..."

22. Auto-refresh shall not show any loading indicators

### Multi-line Support

23. The system shall support pasting multi-line content

24. Multi-line comments shall be properly formatted in the display

## Example Usage

```bash
$ ji log EVAL-5756

issue: EVAL-5756
comments:
- author: John Doe
  time: 3 days ago
  comment: |
    Started working on this issue. The main problem seems to be...
- author: Jane Smith
  time: 2 days ago
  comment: |
    I've reviewed the code and found a potential fix...

╭─────────────────────────────────────────────────────────────────╮
│ > Fixed the issue and added tests                               │
╰─────────────────────────────────────────────────────────────────╯

[User presses Enter]

- author: You
  time: just now
  comment: |
    Fixed the issue and added tests

╭─────────────────────────────────────────────────────────────────╮
│ > /exit                                                         │
╰─────────────────────────────────────────────────────────────────╯

[User presses Enter, box disappears, only comments remain]
```

## Implementation Notes

- Built with Ink (React for CLI) and ink-text-input
- Uses Effect for all async operations and error handling
- State management through React hooks
- Automatic UI updates when state changes
- Border styling with Ink's Box component
- Clean exit behavior that hides UI elements