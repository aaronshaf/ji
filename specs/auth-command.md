# ji auth Command Specification

## Overview

The `ji auth` command provides an interactive setup process for configuring Jira and Confluence authentication. It securely stores credentials and validates the connection to ensure proper setup.

## Requirements

### Command Invocation

1. When `ji auth` is invoked, the system shall start an interactive authentication setup process.

2. When `ji auth --help` is invoked, the system shall display comprehensive help information including required credentials.

### Interactive Setup Process

3. The system shall prompt for authentication information in this order:
   - Jira URL (e.g., https://company.atlassian.net)
   - Email address
   - API token

4. For Jira URL input, the system shall:
   - Validate the URL format
   - Ensure it uses HTTPS protocol
   - Test basic connectivity to the URL
   - Accept URLs with or without trailing slashes

5. For email input, the system shall:
   - Validate email format
   - Ensure it matches the email associated with the API token

6. For API token input, the system shall:
   - Mask the token during input for security
   - Validate the token format
   - Provide guidance on obtaining tokens from Atlassian

### Credential Validation

7. After collecting credentials, the system shall test the connection by:
   - Making a test API call to Jira
   - Verifying the user's identity
   - Checking basic permissions

8. When validation succeeds, the system shall display:
   ```
   ✓ Successfully authenticated as John Doe (john.doe@company.com)
   ✓ Connection to https://company.atlassian.net verified
   ```

9. When validation fails, the system shall:
   - Display specific error messages
   - Allow the user to retry with corrected information
   - Provide troubleshooting guidance

### Credential Storage

10. The system shall store credentials in `~/.ji/auth.json` with 600 file permissions.

11. The credential file shall contain:
    ```json
    {
      "jiraUrl": "https://company.atlassian.net",
      "email": "john.doe@company.com",
      "apiToken": "ATATT3xFfGF0...",
      "userId": "557058:12345678-abcd-1234-abcd-123456789abc"
    }
    ```

12. The system shall set restrictive file permissions (600) to protect sensitive data.

13. The system shall never commit credentials to version control or expose them in logs.

### Security Measures

14. The system shall validate that the auth.json file has correct permissions (600).

15. If auth.json exists with incorrect permissions, the system shall:
    - Display a security warning
    - Offer to fix the permissions automatically
    - Block execution until permissions are corrected

16. The system shall never echo API tokens to the console or logs.

### Configuration Updates

17. When re-running `ji auth`, the system shall:
    - Display current configuration (without sensitive data)
    - Allow updating individual fields
    - Preserve existing values when user skips fields

18. The system shall support updating specific fields without re-entering all credentials.

### Error Handling

19. For invalid URLs, the system shall display:
    `Error: Invalid Jira URL. Please use format: https://company.atlassian.net`

20. For connection failures, the system shall display:
    `Error: Cannot connect to Jira. Please check your URL and network connection.`

21. For authentication failures, the system shall display:
    `Error: Authentication failed. Please check your email and API token.`

22. For permission issues, the system shall display:
    `Error: Insufficient permissions. Please ensure your account has access to Jira.`

### Help and Guidance

23. The system shall provide clear instructions for obtaining API tokens:
    - Link to Atlassian API token creation page
    - Step-by-step guidance
    - Common troubleshooting tips

24. The system shall validate that all required fields are provided before proceeding.

## Example Usage

### Initial setup
```bash
$ ji auth

Setting up Jira & Confluence authentication...

Jira URL (e.g., https://company.atlassian.net): https://mycompany.atlassian.net
Email address: john.doe@company.com
API Token (create at https://id.atlassian.com/manage/api-tokens): [hidden input]

Testing connection...
✓ Successfully authenticated as John Doe (john.doe@company.com)
✓ Connection to https://mycompany.atlassian.net verified

Configuration saved to ~/.ji/auth.json
```

### Reconfiguration
```bash
$ ji auth

Current configuration:
- Jira URL: https://mycompany.atlassian.net
- Email: john.doe@company.com
- API Token: [configured]

Press Enter to keep current values or enter new ones:

Jira URL: [Enter - keeping current]
Email address: [Enter - keeping current]
API Token: [new token entered]

Testing connection...
✓ Successfully authenticated as John Doe (john.doe@company.com)
✓ Configuration updated
```

### Authentication failure
```bash
$ ji auth

Setting up Jira & Confluence authentication...

Jira URL: https://mycompany.atlassian.net
Email address: john.doe@company.com
API Token: [invalid token]

Testing connection...
✗ Authentication failed. Please check your email and API token.

The API token may be invalid or expired.
Create a new token at: https://id.atlassian.com/manage/api-tokens

Would you like to try again? (y/n): y
```

## Implementation Notes

- Uses Node.js readline for interactive prompts
- Implements secure input masking for sensitive data
- Validates all inputs before storage
- Tests actual API connectivity during setup
- Manages file permissions automatically
- Provides comprehensive error messages and guidance
- Supports both initial setup and reconfiguration
- Never exposes sensitive data in logs or console output