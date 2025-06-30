# Claude Code Instructions for ji CLI

## Project Overview

This is a Jira & Confluence CLI tool built with:
- Bun (runtime, package manager, and SQLite provider)
- TypeScript
- zod (schema validation)
- chalk (color highlighting)
- Zero Node.js dependencies

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

## Key Design Decisions

1. **Bun-first**: This project uses Bun as the primary runtime and build tool
2. **Local SQLite storage**: Cached data stored in `~/.ji/data.db`
3. **Separate auth storage**: Credentials in `~/.ji/auth.json` (600 permissions)
4. **Background refresh**: Auto-refresh data in background for instant access
5. **Security**: API keys stored securely, never in git or environment variables
6. **Full-text search**: SQLite FTS5 for searching across all content

## Development Guidelines

### Commands to run after changes:
```bash
bun run typecheck
bun run lint
```

### Testing commands:
```bash
bun test
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

### Project Structure:
```
src/
├── cli.ts                    # Main CLI entry point
└── lib/                      # Shared libraries
    ├── cache.ts              # SQLite caching layer
    ├── config.ts             # Configuration & auth management
    ├── content-manager.ts    # Unified content storage
    ├── embeddings.ts         # Search functionality (FTS5 + semantic)
    ├── ollama.ts             # Ollama integration for embeddings & LLM
    ├── jira-client.ts        # Jira API client
    ├── confluence-client.ts  # Confluence API client
    └── confluence-converter.ts # Convert storage format to text
```

## Important Security Notes

- NEVER commit API keys or tokens
- Authentication stored separately in `~/.ji/auth.json` (600 permissions)
- Database at `~/.ji/data.db` contains only cached content
- `.gitignore` configured to exclude all sensitive files

## Current Features

- ✅ Jira issue viewing with caching
- ✅ Confluence space syncing and page viewing
- ✅ Full-text search across all content
- ✅ Semantic search with vector embeddings (via Ollama + mxbai-embed-large)
- ✅ Hybrid search combining semantic and keyword matching
- ✅ AI-powered Q&A with `ji ask` (uses Ollama + gemma3n)
- ✅ Background refresh for instant access
- ✅ Secure credential storage
- ✅ `ji mine` command to show your open issues
- ✅ `--clean` flag for fresh sync

## Future Features

- More Jira commands (create, update issues)
- Confluence page creation/editing
- Watch mode for real-time updates
- Batch operations (bulk update issues)