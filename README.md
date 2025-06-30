# ji - Jira CLI

A fast, modern CLI for Jira built with Bun and TypeScript. Features local SQLite caching with background sync for instant access to your Jira data.

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

## Features

- 🚀 Built with Bun for lightning-fast performance
- 💾 Local SQLite database for offline access and instant queries
- 🔄 Background daemon syncs data automatically
- 🔐 Secure API key storage
- 📝 Clean, intuitive command structure

## Installation

```bash
bun install
bun run build
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

View as JSON:
```bash
ji issue view PROJ-123 --json
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

- **CLI**: Built with oclif for a robust command structure
- **Storage**: SQLite database stored in `~/.ji/` for fast local queries
- **Sync**: Background daemon (coming soon) syncs data with Jira
- **Security**: API credentials stored securely in local SQLite database

## License

MIT