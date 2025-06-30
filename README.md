# ji - Jira & Confluence CLI

A fast, modern CLI for Jira and Confluence built with Bun and TypeScript. Features local SQLite caching with background sync for instant access to your data.

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

## Features

- 🚀 Built with Bun for lightning-fast performance
- 💾 Local SQLite caching for offline access and instant queries
- 🔄 Automatic background refresh keeps data up-to-date
- 🔐 Secure API key storage (separate from database)
- 📝 Clean, intuitive command structure
- 🔍 Fast full-text search across Jira issues and Confluence pages
- 🧠 Semantic search with local vector embeddings (via Ollama)
- 📚 Confluence integration with space syncing
- 🎨 Subtle color highlighting with chalk

## Prerequisites

- [Bun](https://bun.sh) (v1.0 or later)
- [Ollama](https://ollama.com) (optional, for semantic search)

## Installation

```bash
bun install
```

To install globally:
```bash
bun link
```

## Setup

First, authenticate with your Atlassian instance:

```bash
ji auth
```

You'll need:
- Your Atlassian instance URL (e.g., `https://company.atlassian.net`)
- Your email address
- An Atlassian API token (create one at https://id.atlassian.com/manage-profile/security/api-tokens)

The authentication credentials are stored securely in `~/.ji/auth.json` with 600 permissions, separate from the database so you can recreate the SQLite database without re-authenticating.

## Usage

### Jira Commands

#### View an issue

```bash
ji issue view PROJ-123
```

By default, if cached data exists, it will be displayed immediately while fresh data is fetched in the background for next time.

View as JSON:
```bash
ji issue view PROJ-123 --json
ji issue view PROJ-123 -j
```

Force sync from API (wait for fresh data):
```bash
ji issue view PROJ-123 --sync
ji issue view PROJ-123 -s
```

Combine options:
```bash
ji issue view PROJ-123 --sync --json
```

#### Sync all issues from a project

Sync all issues from a Jira project to your local database:

```bash
ji issue sync PROJ
```

Clear local data and start fresh:
```bash
ji issue sync PROJ --clean
```

This will:
- Fetch all issues from the specified project
- Store them in the local SQLite database for searching
- Show progress during the sync
- Generate vector embeddings in background (if Ollama is available)

#### Show your open issues

```bash
ji mine
```

Shows all open issues assigned to you, grouped by project.

### Confluence Commands

#### Sync a Confluence space

Sync all pages from a Confluence space to your local database:

```bash
ji confluence sync <space-key>
```

This will:
- Fetch all pages from the specified space
- Convert Confluence storage format to plain text
- Store pages in the local SQLite database for searching
- Show progress during the sync

#### View a Confluence page

```bash
ji confluence view <page-id>
```

View as JSON:
```bash
ji confluence view <page-id> --json
```

### Search

Search across all cached content (both Jira and Confluence):
```bash
ji search "performance issues"
```

Semantic search (finds conceptually related content):
```bash
ji search --semantic "authentication problems"
```

Filter by source:
```bash
ji search "deployment" --source jira
ji search "api documentation" --source confluence
```

Limit results:
```bash
ji search "bug" --limit 5
```

Search results show:
- Title with status icon (for Jira issues)
- Relevant metadata (status, priority, assignee)
- Content preview from descriptions

#### Semantic Search Setup

For semantic search to work, you need Ollama:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model
ollama pull mxbai-embed-large

# Ollama runs as a service automatically
```

After syncing issues, embeddings are generated in the background. Semantic search will find conceptually related content even if exact keywords don't match.

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Run tests
bun test

# Type checking
bun run typecheck

# Linting
bun run lint
```

## Architecture

- **Runtime**: Pure Bun for lightning-fast execution
- **Storage**: Bun's built-in SQLite database stored in `~/.ji/data.db`
- **Authentication**: Credentials stored separately in `~/.ji/auth.json` (600 permissions)
- **Search**: SQLite FTS5 for full-text search across all content
- **Sync**: Background processes for data refresh
- **Security**: API credentials stored securely, never committed to git
- **Zero Node.js dependencies**: Runs entirely on Bun

## License

MIT