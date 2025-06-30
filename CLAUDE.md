# Claude Code Instructions for ji CLI

## Project Overview

This is a Jira CLI tool built with:
- Bun (runtime, package manager, and SQLite provider)
- TypeScript
- zod (schema validation)
- Zero Node.js dependencies

## Key Design Decisions

1. **Bun-first**: This project uses Bun as the primary runtime and build tool
2. **Local SQLite storage**: API credentials and cached data stored in `~/.ji/`
3. **Background daemon**: Will sync Jira data to local SQLite for fast queries
4. **Security**: API keys stored in SQLite, never in environment variables or config files

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
├── cli.ts        # Main CLI entry point
├── lib/          # Shared libraries
│   ├── config.ts # Configuration management (uses Bun SQLite)
│   └── jira-client.ts
└── daemon/       # Background sync daemon (TBD)
```

## Important Security Notes

- NEVER commit API keys or tokens
- All sensitive data stored in SQLite at `~/.ji/config.db`
- `.gitignore` configured to exclude all sensitive files

## Future Features

- Background daemon for syncing Jira data
- More commands (create, update, search issues)
- Confluence integration
- Local caching for offline access