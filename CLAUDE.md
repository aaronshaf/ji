# Claude Code Instructions for ji CLI

## Project Overview

This is a **local-first, fast CLI** for Jira & Confluence built with:
- Bun (runtime, package manager, and SQLite provider)
- TypeScript
- zod (schema validation)
- chalk (color highlighting)
- Zero Node.js dependencies

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

**Core Philosophy**: This app is meant to be a local-first fast CLI for Jira and Confluence. All searches and data access should prioritize local SQLite database over API calls for instant response times.

## Key Design Decisions

1. **Local-first architecture**: All operations prioritize local SQLite database for instant response
2. **Bun-first**: This project uses Bun as the primary runtime and build tool
3. **Local SQLite storage**: Cached data stored in `~/.ji/data.db`
4. **Separate auth storage**: Credentials in `~/.ji/auth.json` (600 permissions)
5. **Background refresh**: Auto-refresh data in background for instant access
6. **Security**: API keys stored securely, never in git or environment variables
7. **Full-text search**: SQLite FTS5 for searching across all content
8. **No external search dependencies**: Removed Meilisearch dependency to ensure instant local search

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
    ├── ollama.ts             # Ollama integration for LLM
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
- ✅ Hybrid search with Meilisearch (semantic + keyword via Ollama embeddings)
- ✅ AI-powered Q&A with `ji ask` (uses Ollama + gemma3n)
- ✅ Background refresh for instant access
- ✅ Secure credential storage
- ✅ `ji mine` command to show your open issues
- ✅ `ji take` command to assign issues to yourself
- ✅ `--clean` flag for fresh sync

## Future Features

- More Jira commands (create, update issues)
- Confluence page creation/editing
- Watch mode for real-time updates
- Batch operations (bulk update issues)