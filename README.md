# ji - Jira CLI

A fast, modern CLI for Jira built with Bun and TypeScript. Features local SQLite caching with background sync for instant access to your Jira data.

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

## Features

- 🚀 Built with Bun for lightning-fast performance
- 💾 Local SQLite caching for offline access and instant queries
- 🔄 Automatic background refresh keeps data up-to-date
- 🔐 Secure API key storage
- 📝 Clean, intuitive command structure
- 🔍 Local vector search with semantic understanding
- 🤖 Hybrid search combining keyword and AI-powered semantic search

## Prerequisites

- [Bun](https://bun.sh) (v1.0 or later)

## Installation

```bash
bun install
```

To install globally:
```bash
bun link
```

## Setup

First, authenticate with your Jira instance:

```bash
ji auth
```

You'll need:
- Your Jira instance URL (e.g., `https://company.atlassian.net`)
- Your email address
- A Jira API token (create one at https://id.atlassian.com/manage-profile/security/api-tokens)

## Usage

### View an issue

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

### Search

Search across all cached content (hybrid search by default):
```bash
ji search "performance issues"
```

Semantic search only (AI-powered):
```bash
ji search --semantic "how to improve page load times"
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
- **Storage**: Bun's built-in SQLite database stored in `~/.ji/` for fast local queries
- **Search**: Local vector embeddings using Transformers.js (all-MiniLM-L6-v2)
- **Sync**: Background processes for data refresh and embedding generation
- **Security**: API credentials stored securely in local SQLite database
- **Zero Node.js dependencies**: Runs entirely on Bun

## License

MIT