# Claude Code Instructions for ji CLI

## Project Overview

This is a Jira CLI tool built with:
- Bun (runtime and package manager)
- TypeScript
- oclif (CLI framework)
- better-sqlite3 (local storage)
- zod (schema validation)

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
├── bin/          # CLI entry point
├── commands/     # oclif commands
│   ├── auth.ts   # Authentication setup
│   └── issue/    # Issue-related commands
│       └── view.ts
├── lib/          # Shared libraries
│   ├── config.ts # Configuration management
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