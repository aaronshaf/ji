# Claude Code Instructions for ji CLI

## Project Overview

This is a **fast, API-driven CLI** for Jira & Confluence built with:
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
3. **Secure auth storage**: Credentials in `~/.ji/auth.json` (600 permissions)
4. **Smart filtering**: JQL-powered queries for efficient status, time, and assignee filtering
5. **Security**: API keys stored securely, never in git or environment variables
6. **Cross-platform search**: API-based search across Jira and Confluence content
7. **Human-first output**: Pretty colored output by default, with --xml flag for LLM compatibility
8. **Effect-first**: Use Effect and Effect Schema comprehensively for type-safe operations, proper error handling, and composable functions

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
ast-grep --pattern 'ollama.generate($$$)' src/

# Find and replace model parameter patterns
ast-grep --pattern 'model: options.model || "gemma3n:latest"' --rewrite 'model: askModel' src/

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
│       ├── search.ts         # Search across Jira/Confluence (API-only)
│       ├── memory.ts         # Memory management
│       ├── comment.ts        # Add comments to issues (Effect-based)
│       ├── board.ts          # Board and sprint management
│       └── test.ts           # Testing framework (comprehensive Effect usage)
└── lib/                      # Shared libraries
    ├── config.ts             # Configuration & auth management (Effect-based)
    ├── ollama.ts             # Ollama integration for LLM
    ├── jira-client.ts        # Jira API client (LARGE FILE - needs splitting)
    ├── confluence-client.ts  # Confluence API client
    └── confluence-converter.ts # Convert storage format to text
```

### Code Organization Guidelines

**File Size Management**: When files grow too large (>500 lines), split them into smaller, focused modules:
- `jira-client.ts` is getting large and should be split into:
  - `jira-client-core.ts` - Basic API methods
  - `jira-client-effects.ts` - Effect-based implementations
  - `jira-client-types.ts` - Schemas and type definitions
- Keep related functionality together but separate concerns
- Use barrel exports (`index.ts`) to maintain clean imports

## Important Security Notes

- NEVER commit API keys or tokens
- Authentication stored separately in `~/.ji/auth.json` (600 permissions)
- Test configuration stored in `~/.ji/test-config.json` (gitignored, contains environment-specific data)
- `.gitignore` configured to exclude all sensitive files including test configs
- All sensitive configuration files use 600 permissions for security
- No local storage of sensitive data - only cached in memory during API calls

## Current Features

- ✅ Jira issue viewing with direct API access (Effect-based)
- ✅ Advanced filtering: status, time ranges, assignees (JQL-powered)
- ✅ Cross-platform search across Jira and Confluence content
- ✅ AI-powered Q&A with `ji ask` (uses Ollama + gemma3n)
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

## Testing Framework

The project includes a comprehensive testing framework built with Effect:

### Features
- **Environment-specific tests**: Uses real issue keys and projects from your environment
- **LLM-based validation**: Uses Ollama to validate `ji ask` responses for quality and relevance
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
- `ji search "query"` - Pattern validation for YAML output
- `ji issue view KEY` - Issue data structure validation
- `ji ask "question"` - LLM-based answer quality assessment
- `ji mine --status "In Progress" --since 24h` - Filtered issue retrieval validation
- `ji mine` - Personal issue retrieval validation

## Future Features

- Complete Effect migration for remaining async/Promise code
- More Jira commands (create, update issues) with Effect-based operations
- Confluence page creation/editing
- Advanced filtering combinations (multiple projects, custom JQL)
- Batch operations (bulk update issues)
- CI/CD integration with seeded test data
- Performance optimizations for large result sets