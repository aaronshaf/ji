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

### Project Structure:
```
src/
├── cli.ts                    # Main CLI entry point
└── lib/                      # Shared libraries
    ├── cache.ts              # SQLite caching layer
    ├── config.ts             # Configuration & auth management
    ├── content-manager.ts    # Unified content storage
    ├── embeddings.ts         # Search functionality (FTS5)
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
- ✅ Background refresh for instant access
- ✅ Secure credential storage

## Future Features

- Vector embeddings for semantic search (needs Bun-compatible solution)
- More Jira commands (create, update issues)
- Confluence page creation/editing
- Watch mode for real-time updates