# Claude Code Instructions for ji CLI

## Project Overview

This is a **fast, API-driven CLI** for Jira built with:
- Bun (runtime and package manager)
- TypeScript
- Effect and Effect Schema (functional programming with type-safe error handling)
- chalk (color highlighting)
- Zero Node.js dependencies

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

**Core Philosophy**: 
- Fast CLI with direct API access for always-fresh data
- Smart filtering using JQL (Jira Query Language) for efficient queries
- Human-first design with pretty colored output by default, XML available for LLM consumption
- Use Effect comprehensively for type-safe, composable operations with proper error handling

## Key Design Decisions

1. **API-only architecture**: Direct API calls for always-fresh data without local storage complexity
2. **Bun-first**: This project uses Bun as the primary runtime and build tool
3. **Secure auth storage**: Credentials in `~/.ji/config.json` (600 permissions)
4. **Smart filtering**: JQL-powered queries for efficient status, time, and assignee filtering
5. **Security**: API keys stored securely, never in git or environment variables
6. **Human-first output**: Pretty colored output by default, with --xml flag for LLM compatibility
7. **Effect-first**: Use Effect and Effect Schema comprehensively for type-safe operations, proper error handling, and composable functions

## Development Guidelines

### Commands to run after changes:
```bash
bun run typecheck
bun run lint
```

### Testing commands:
```bash
bun test                     # Unit tests
ji test --setup              # Configure environment-specific integration tests
ji test                      # Run all integration tests
```

### Advanced Code Analysis Tools:

**ast-grep** - Available for complex code transformations and analysis:

```bash
# Find all function calls to a specific API
ast-grep --pattern 'jiraClient.getIssue($$$)' src/

# Find and replace configuration patterns
ast-grep --pattern 'config.jiraUrl' src/

# Find all async functions that don't have proper error handling
ast-grep --pattern 'async function $NAME($$$) { $$$ }' src/ | ast-grep --pattern 'try { $$$ }' --invert-match

# Find TypeScript interface definitions
ast-grep --pattern 'interface $NAME { $$$ }' src/

# Locate all database query patterns
ast-grep --pattern 'this.db.prepare($QUERY)' src/
```

Use ast-grep when you need to:
- Find complex code patterns across the entire codebase
- Perform structural code transformations
- Analyze function call patterns or API usage
- Refactor code with precision (safer than regex)

### Effect Usage Guidelines

This project uses **Effect comprehensively** for type-safe, composable operations. Follow these patterns:

#### 1. Schema Validation with Effect Schema
```typescript
// ✅ Use Effect Schema instead of Zod
import { Schema } from 'effect';

const ConfigSchema = Schema.Struct({
  jiraUrl: Schema.String,
  apiToken: Schema.String,
});

// ✅ Decode with proper error handling
const decodeConfig = (input: unknown) =>
  Schema.decodeUnknown(ConfigSchema)(input).pipe(
    Effect.mapError(error => new ValidationError(`Config validation failed: ${error}`))
  );
```

#### 2. File Operations with Effect
```typescript
// ✅ Use Effect for file operations
const readConfigFile = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, 'utf-8'),
    catch: (error) => new FileOperationError(`Failed to read ${path}: ${error}`)
  });

// ✅ Compose with pipe
const loadConfig = (path: string) =>
  pipe(
    readConfigFile(path),
    Effect.flatMap(content => Effect.try({
      try: () => JSON.parse(content),
      catch: (error) => new ParseError(`Invalid JSON: ${error}`)
    })),
    Effect.flatMap(decodeConfig)
  );
```

#### 3. Resource Management with Effect.scoped
```typescript
// ✅ Use Effect.scoped for automatic cleanup
const withHttpClient = <A, E>(
  operation: (client: HttpClient) => Effect.Effect<A, E>
): Effect.Effect<A, E | NetworkError> =>
  Effect.scoped(
    pipe(
      Effect.acquireRelease(
        Effect.sync(() => new HttpClient()),
        (client) => Effect.sync(() => client.close())
      ),
      Effect.flatMap(operation)
    )
  );
```

#### 4. Error Handling with Custom Error Types
```typescript
// ✅ Define custom error classes
export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

export class NetworkError extends Error {
  readonly _tag = 'NetworkError';
}

// ✅ Use Effect.catchAll for error handling
const handleErrors = <A>(effect: Effect.Effect<A, ValidationError | NetworkError>) =>
  effect.pipe(
    Effect.catchAll(error => {
      switch (error._tag) {
        case 'ValidationError':
          return Console.error(`Validation failed: ${error.message}`);
        case 'NetworkError':
          return Console.error(`Network error: ${error.message}`);
      }
    })
  );
```

#### 5. CLI Commands with Effect
```typescript
// ✅ CLI command pattern
const commandEffect = (args: Args): Effect.Effect<void, CommandError> =>
  pipe(
    validateArgs(args),
    Effect.flatMap(processCommand),
    Effect.flatMap(displayResults),
    Effect.catchAll(handleCommandError)
  );

// ✅ Async wrapper for CLI framework
export async function command(args: Args): Promise<void> {
  await Effect.runPromise(
    commandEffect(args).pipe(
      Effect.catchAll(error => 
        pipe(
          Console.error(chalk.red(`Error: ${error.message}`)),
          Effect.flatMap(() => Effect.succeed(process.exit(1)))
        )
      )
    )
  );
}
```

#### 6. When to Use Effect vs Async/Await

**Use Effect for:**
- Operations that can fail (file I/O, network, parsing)
- Resource management (HTTP clients, connections)
- Composable operations
- Complex error handling
- Operations that need to be testable

**Use async/await only for:**
- Simple CLI wrapper functions
- Backward compatibility layers
- Third-party library integration (when Effect version doesn't exist)

#### 7. Migration Strategy

When updating existing code to use Effect:

1. **Start with schemas**: Replace Zod with Effect Schema
2. **Add error types**: Define custom error classes with `_tag`
3. **Convert file operations**: Use `Effect.tryPromise` for async operations
4. **Add resource management**: Use `Effect.scoped` for cleanup
5. **Update tests**: Use Effect testing utilities
6. **Maintain compatibility**: Keep async wrappers for existing callers

### Project Structure:
```
src/
├── cli.ts                    # Main CLI entry point
├── cli/                      # CLI command structure
│   ├── index.ts              # Command router
│   ├── utils/                # CLI utilities
│   │   └── time-parser.ts    # Parse human time formats to JQL
│   └── commands/             # Individual command implementations
│       ├── auth.ts           # Authentication setup
│       ├── issue.ts          # Issue viewing (API-only, Effect-based)
│       ├── mine.ts           # Personal issues with filtering (API-only)
│       ├── memory.ts         # Memory management
│       ├── comment.ts        # Add comments to issues (Effect-based)
│       ├── board.ts          # Board and sprint management
│       ├── test.ts           # Testing framework (comprehensive Effect usage)
│       ├── do.ts             # Agentic issue resolution (SDK-based)
│       ├── do-types.ts       # Type definitions for do command
│       ├── do-prompt.ts      # Prompt generation for do iterations
│       ├── do-iteration.ts   # Iteration execution logic
│       └── do-publish.ts     # Publishing and PR creation
└── lib/                      # Shared libraries
    ├── config.ts             # Configuration & auth management (Effect-based)
    ├── agent-sdk-wrapper.ts  # Claude Agent SDK wrapper (Effect-based)
    ├── jira-client.ts        # Jira API client (LARGE FILE - needs splitting)
    └── jira-client/          # Jira client components
```

### Code Organization Guidelines

**File Size Management**: When files grow too large (>500 lines), split them into smaller, focused modules:
- Split by responsibility:
  - `*-read.ts` - Read/query operations
  - `*-mutations.ts` - Write/update operations
  - `*-types.ts` - Schemas and type definitions
- Keep related functionality together but separate concerns
- Use composition pattern for unified interfaces
- Use barrel exports (`index.ts`) to maintain clean imports

### Git Commit and PR Guidelines

#### Commit Messages
- **ALWAYS** use conventional commit format (e.g., `feat:`, `fix:`, `refactor:`, `test:`, `docs:`)
- **NEVER** use `--no-verify` flag when committing (let pre-commit hooks run)
- Keep commit messages concise and focused on the "why" rather than the "what"
- Example: `refactor: delegate async methods to Effect versions for consistency`

#### Pull Request Descriptions
When creating PRs (via `gh pr create` or GitHub UI), follow these formatting rules:

**Structure:**
```markdown
## Summary
[Clear description of changes]

## Changes
- [Bullet point list of specific changes]

## Testing
- [How the changes were tested]

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**CRITICAL RULES:**
- **Only add the Claude Code attribution ONCE** at the very end as a footer
- Use a separator line (`---`) before the footer
- **DO NOT** add attribution comments scattered throughout the PR body text
- Keep the main content clean and focused on technical details

**Example of CORRECT formatting:**
```markdown
## Summary
Refactor async methods to delegate to Effect versions for consistent error handling.

## Changes
- Updated getIssue() to delegate to getIssueEffect()
- Fixed issue key validation regex to support hyphens
- Added comprehensive JSDoc comments

## Testing
- All 465 tests passing
- Verified with real Jira instance

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Example of INCORRECT formatting (DO NOT DO THIS):**
```markdown
## Summary

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Refactor async methods...

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Changes
- Updated getIssue()...

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

#### Branch Management
- Create feature branches from `main` for new work
- Branch naming convention: `<type>/<description>` (e.g., `refactor/improve-error-handling`)
- Always pull latest `main` before creating new branches
- Use `git stash` to preserve uncommitted work when switching branches

## API Stability & Maintenance

### Jira API Version Strategy

**Current Version**: `/rest/api/3` (Jira Cloud REST API v3)

**Important Context**: In 2025, Atlassian deprecated the `/rest/api/3/search` endpoint in favor of `/rest/api/3/search/jql`. This required immediate migration and taught us valuable lessons about API monitoring.

#### API Endpoint Evolution

```typescript
// ❌ Deprecated (May 2025)
const url = `${jiraUrl}/rest/api/3/search?jql=${jql}`;

// ✅ Current (migrated 2025)
const url = `${jiraUrl}/rest/api/3/search/jql?jql=${jql}`;
```

**Key differences in new endpoint:**
- `total` field is now optional (may be undefined)
- `startAt` field is now optional (may be undefined)
- `maxResults` field is now optional (may be undefined)
- Fields parameter is required (defaults to `*navigable`)
- Supports cursor-based pagination via `nextPageToken`

### Handling Optional Response Fields

Always handle optional fields defensively with fallbacks:

```typescript
// ✅ Good: Handle missing total field
const result = await searchIssues(jql);
return {
  issues: result.issues,
  total: result.total ?? result.issues.length,  // Fallback to issue count
  startAt: result.startAt ?? 0,                 // Fallback to 0
};

// ❌ Bad: Assume total is always present
const total = result.total; // May be undefined!
```

**Schema patterns for optional fields:**
```typescript
// ✅ Use Schema.optional() for new API optional fields
export const SearchResultSchema = Schema.Struct({
  issues: Schema.Array(IssueSchema),           // Required
  startAt: Schema.optional(Schema.Number),     // Optional in new API
  maxResults: Schema.optional(Schema.Number),  // Optional in new API
  total: Schema.optional(Schema.Number),       // Optional in new API
  nextPageToken: Schema.optional(Schema.String), // Cursor pagination
});
```

### API Deprecation Monitoring

#### Detection Strategy

1. **Monitor response headers** for deprecation warnings:
```typescript
private checkDeprecationWarnings(response: Response): void {
  const deprecation = response.headers.get('Deprecation');
  const sunset = response.headers.get('Sunset');

  if (deprecation) {
    console.warn(
      `⚠️  Jira API deprecation warning:\n` +
      `   Endpoint: ${response.url}\n` +
      `   Sunset date: ${sunset || 'not specified'}\n` +
      `   See: https://developer.atlassian.com/cloud/jira/platform/deprecation-notices/`
    );
  }
}
```

2. **Log API version in requests** for debugging:
```typescript
protected getHeaders() {
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'ji-cli/1.0.0', // Track which client version
  };
}
```

3. **Monitor Atlassian's deprecation notices**:
   - https://developer.atlassian.com/cloud/jira/platform/deprecation-notices/
   - Subscribe to Atlassian Developer newsletter
   - Check quarterly for breaking changes

#### Recommended: Add Health Check Command

```typescript
// Future enhancement: ji doctor
export async function doctor(): Promise<void> {
  const client = await getJiraClient();

  // Test API connectivity
  await client.testConnection();

  // Check for deprecation warnings
  await client.checkApiHealth();

  // Verify authentication
  await client.getCurrentUser();

  console.log('✅ All Jira API checks passed');
}
```

### Testing with Mock API Responses

**Fixture Location**: `src/test/fixtures/jira-api-responses.ts`

Use fixtures for consistent, maintainable tests:

```typescript
import {
  mockSearchResultNewFormat,
  mockSearchResultOldFormat,
  mockSearchResultMixed,
  createMockFetchHandler,
} from '../test/fixtures/jira-api-responses.js';

// ✅ Test both old and new API response formats
it('should handle new /search/jql API format', async () => {
  global.fetch = createMockFetchHandler({
    '/rest/api/3/search/jql': mockSearchResultNewFormat,
  });

  const result = await client.searchIssues('project = PROJ');
  expect(result.total).toBeDefined(); // Should have fallback
});

// ✅ Test backward compatibility
it('should handle mixed response format', async () => {
  global.fetch = createMockFetchHandler({
    '/rest/api/3/search/jql': mockSearchResultMixed, // Has startAt/total but not maxResults
  });

  const result = await client.searchIssues('project = PROJ');
  expect(result.startAt).toBe(0);
});
```

**Test Coverage Requirements:**
- Old API format (for backward compatibility tests)
- New API format (minimal fields only)
- Mixed format (some optional fields present)
- Error responses (401, 403, 404, 410)
- Deprecation header handling
- Pagination edge cases (total undefined, cursor-based)

### MSW Configuration

When using Mock Service Worker (MSW) for integration tests:

```typescript
// vitest.config.ts or test setup
export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup.ts'],
    msw: {
      mode: 'bypass', // ✅ Bypass unhandled requests (don't fail tests)
    },
  },
});
```

**Why 'bypass' mode?**: Tests should only mock what they explicitly need. Unhandled requests indicate missing mocks, not test failures.

### Migration Checklist for API Changes

When Atlassian announces a new API version or deprecation:

- [ ] Update endpoint URLs in affected files
- [ ] Update schemas to handle new optional/required fields
- [ ] Add fallback logic for optional response fields
- [ ] Update JSDoc comments with migration notes
- [ ] Add tests for new API response format
- [ ] Keep backward compatibility for transition period
- [ ] Update CLAUDE.md with new API patterns
- [ ] Test with real Jira instance (use `ji test`)
- [ ] Add deprecation warnings if old patterns are still used
- [ ] Update error messages to reference new endpoints

## Important Security Notes

- NEVER commit API keys or tokens
- Authentication stored separately in `~/.ji/config.json` (600 permissions)
- Test configuration stored in `~/.ji/test-config.json` (gitignored, contains environment-specific data)
- `.gitignore` configured to exclude all sensitive files including test configs
- All sensitive configuration files use 600 permissions for security
- No local storage of sensitive data - only cached in memory during API calls

## Project Configuration: `.jiconfig.json`

Configure project-specific settings for `ji do` command in `.jiconfig.json` in your project root:

```json
{
  "publish": "git push origin HEAD:refs/for/master"
}
```

### Configuration Options

- **`publish`** (optional): Shell command to execute after successful iterations but before creating a PR. Use this for:
  - Custom git push commands (e.g., Gerrit: `git push origin HEAD:refs/for/master`)
  - Pre-publish validation scripts
  - Custom deployment workflows

**Note**: The `publish` command runs in a non-interactive shell, so you may need to source your shell config or use absolute paths if the command depends on tools from shell managers (asdf, nvm, etc.).

## Current Features

- ✅ Jira issue viewing with direct API access (Effect-based)
- ✅ Advanced filtering: status, time ranges, assignees (JQL-powered)
- ✅ Always-fresh data from live API calls
- ✅ Secure credential storage
- ✅ `ji mine` command with powerful filtering (YAML output)
- ✅ `ji take` command to assign issues to yourself
- ✅ Memory management system (`ji remember`, `ji memories`)
- ✅ Comprehensive testing framework (`ji test --setup`, `ji test`)
- ✅ Effect-based error handling and type safety
- ✅ Human-first pretty output with XML option for LLM compatibility
- ✅ Sprint and board management (`ji sprint`, `ji board`)
- ✅ Human-readable time parsing (24h, 7d, 30d) to JQL conversion
- ✅ **Agentic issue resolution** with `ji do` command

## Agentic Development with `ji do`

The `ji do` command provides automated issue resolution using the **Claude Agent SDK**, working directly in your current directory with iterative development cycles.

### Prerequisites

**Authentication**: The command uses the Claude Agent SDK which supports two authentication methods:

1. **Local Claude Code authentication** (default, recommended):
   - No configuration needed if you're already signed into Claude Code
   - SDK automatically uses your local Claude Code session

2. **API Key authentication** (optional):
   - Set `ANTHROPIC_API_KEY` environment variable
   - Useful for CI/CD or automated workflows
   ```bash
   export ANTHROPIC_API_KEY=your_api_key_here
   ```

**Important**: The SDK will use local authentication by default. Only set `ANTHROPIC_API_KEY` if you need explicit API key authentication.

### Usage

```bash
ji do ISSUE-123                      # Resolve issue in current directory (2 iterations)
ji do ISSUE-123 --iterations 3       # Run 3 development iterations
ji do ISSUE-123 --single-commit      # Create one commit at end (default: multiple commits)
ji do ISSUE-123 --dry-run            # Preview what would be done without executing
ji do ISSUE-123 --model opus         # Use Claude Opus (default: sonnet)
```

### How it Works

1. **Validation**: Validates issue key format and git repository status
2. **Branch Check**: Ensures you're on a clean branch (you create the feature branch)
3. **Iteration 1 (Implementation)**: SDK agent implements core functionality
   - Analyzes issue requirements
   - Examines codebase
   - Implements solution
   - Adds tests
   - Creates commits (unless `--single-commit` is used)
4. **Iteration 2+ (Review & Refinement)**: SDK agent reviews and improves
   - Reviews previous iteration's changes
   - Identifies bugs and issues
   - Makes refinements
   - Ensures quality checks pass
   - Stops early if no further changes needed
5. **Safety Validation**: Validates modified files and test requirements
6. **Publishing**:
   - Executes custom `publish` command if configured in `.jiconfig.json`
   - Creates GitHub PR (if GitHub remote detected)
   - Or completes Gerrit workflow (if Gerrit remote detected)

### Commit Strategies

The `--single-commit` flag controls how commits are created:

#### Multiple Commits (default)
```bash
ji do ISSUE-123
```
- Creates logical commits after each meaningful change
- Uses conventional commit format (`feat:`, `fix:`, etc.)
- Provides clear development history
- Recommended for most workflows

#### Single Commit
```bash
ji do ISSUE-123 --single-commit
```
- Makes all changes first, then creates one comprehensive commit at the end
- Cleaner commit history for simple changes
- Useful for squash-merge workflows
- Better for small, focused issues

### Workflow

**Before running `ji do`:**
1. Create your feature branch: `git checkout -b feature/ISSUE-123-description`
2. Ensure working directory is clean (commit or stash changes)

**The command will:**
- Work in your current directory (no worktrees)
- Use your current branch
- Respect your `.claude/` project settings
- Create commits based on strategy (single or multiple)
- Run safety validation
- Create PR or execute publish command

**After completion:**
- Review the changes and commits
- Push your branch if not already pushed
- The PR will be created automatically (for GitHub)

### Configuration

Configure the publish workflow via `.jiconfig.json` (see **Project Configuration** section above):

```json
{
  "publish": "git push origin HEAD:refs/for/master",
  "checkBuild": "gh pr checks $(gh pr view --json number -q .number) --watch"
}
```

### Remote Iterations (CI Build Fixes)

After local iterations complete and PR is created, `ji do` can automatically fix CI build failures:

```bash
ji do ISSUE-123 --remote-iterations 2    # Fix CI failures (default: 2)
ji do ISSUE-123 --remote-iterations 0    # Disable remote iterations
```

#### How Remote Iterations Work

1. **Local iterations complete** → PR created and pushed
2. **Run `checkBuild`** command from `.jiconfig.json`
3. **If build fails**:
   - Agent analyzes build failure output
   - Agent runs relevant tests locally to reproduce
   - Agent makes targeted fixes
   - Commits and pushes (amends for Gerrit)
   - Runs `checkBuild` again
4. **Repeat** until build passes or max iterations reached (early exit on success)

#### Configuration

Add `checkBuild` to `.jiconfig.json`:

```json
{
  "publish": "git push origin HEAD:refs/for/master",
  "checkBuild": "gh pr checks $(gh pr view --json number -q .number) --watch"
}
```

The `checkBuild` command should:
- Exit with code 0 on success, non-zero on failure
- Output build logs/errors to stdout/stderr
- Wait for CI checks to complete (if needed)

**Example commands:**
- GitHub: `gh pr checks $(gh pr view --json number -q .number) --watch`
- Custom script: `./scripts/check-ci.sh`
- Jenkins: `jenkins-cli build-status $BUILD_ID`

#### Gerrit vs GitHub

- **Gerrit**: Automatically amends commits to maintain single commit (uses `git commit --amend`)
- **GitHub**: Creates new commits for each fix (or respects `--single-commit` if used)

#### Example Output

```
🌐 Starting remote iterations (max: 2)
🔍 Running build check: gh pr checks 123 --watch
❌ Build failed - starting remote iterations

🔄 Remote iteration 1/2
📝 Agent analyzing build failure...
✅ Fixed failing tests in auth module
⬆️  Pushing changes to remote
⏳ Waiting for CI to process...
🔍 Running build check...
✅ Build passed after 1 remote iteration(s)!
```

### Module Architecture

The `ji do` command is organized into focused modules for maintainability:

```
src/cli/commands/
├── do.ts                      # Main entry point (294 lines)
│                              # - Issue validation & git checks
│                              # - Jira client setup
│                              # - Remote/branch detection
│                              # - Orchestration
│
├── do-types.ts                # Type definitions (109 lines)
│                              # - DoCommandOptions (with remoteIterations)
│                              # - IterationContext
│                              # - RemoteIterationContext
│                              # - RemoteIterationResult
│                              # - IssueInfo, RemoteType
│                              # - SafetyReport, FinalResult
│
├── do-prompt.ts               # Prompt generation (217 lines)
│                              # - generateIterationPrompt()
│                              # - generateRemoteIterationPrompt()
│                              # - generatePRDescription()
│
├── do-iteration.ts            # Local iteration execution (78 lines)
│                              # - executeIterations()
│                              # - SDK agent invocation
│                              # - Early termination logic
│
├── do-remote.ts               # Remote utilities (NEW, 95 lines)
│                              # - executeCheckBuild()
│                              # - pushToRemote()
│                              # - Build status checking
│
├── do-remote-iteration.ts     # Remote iteration loop (NEW, 126 lines)
│                              # - executeRemoteIterations()
│                              # - CI failure fixing loop
│                              # - Gerrit amend handling
│
└── do-publish.ts              # Publishing workflow (307 lines)
                               # - executeFinalPublishStep()
                               # - createPullRequest()
                               # - performSafetyValidation()
                               # - executePublishCommand()
                               # - Remote iteration integration
```

**Key Design Principles:**
- Each module has a single responsibility
- Uses Effect-based functional composition
- Comprehensive error handling with custom error types
- All modules <300 lines for maintainability

## Testing Framework

The project includes a comprehensive testing framework built with Effect:

### Features
- **Environment-specific tests**: Uses real issue keys and projects from your environment
- **Comprehensive coverage**: Tests all major commands with appropriate validation strategies
- **Effect-based architecture**: Demonstrates comprehensive Effect usage patterns
- **Security-conscious**: Test configs are gitignored and stored locally

### Usage
```bash
ji test --setup     # Interactive configuration wizard
ji test            # Run all configured tests
```

### Architecture Highlights
- Effect Schema for test configuration validation
- Effect.scoped for resource management
- Custom error types (TestConfigError, ValidationError, etc.)
- Composable Effect functions for test setup and execution
- Mutable types for runtime updates while preserving schema validation

### Example Commands Tested
- `ji issue view KEY` - Issue data structure validation
- `ji mine --status "In Progress" --since 24h` - Filtered issue retrieval validation
- `ji mine` - Personal issue retrieval validation

## Future Features

- Complete Effect migration for remaining async/Promise code
- More Jira commands (create, update issues) with Effect-based operations
- Advanced filtering combinations (multiple projects, custom JQL)
- Batch operations (bulk update issues)
- CI/CD integration with seeded test data
- Performance optimizations for large result sets