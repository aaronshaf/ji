# ji - Jira & Confluence CLI

A fast, modern CLI for Jira and Confluence built with Bun and TypeScript. Features local caching with instant search and AI-powered Q&A.

**Key benefits:**
- ⚡ **Lightning fast** - local caching means <50ms searches
- 🔍 **Smart search** - finds what you need with typo tolerance
- 🤖 **AI assistant** - ask questions about your knowledge base
- 🔄 **Always fresh** - automatic background sync

## Installation

### Prerequisites
- [Bun](https://bun.sh) - JavaScript runtime (install: `curl -fsSL https://bun.sh/install | bash`)

### Install ji

```bash
git clone https://github.com/aaronshaf/ji.git
cd ji
bun install
bun link
```

Now you can use `ji` from anywhere!

## Getting Started

```bash
ji init
```

This interactive wizard will:
1. Set up your Atlassian credentials
2. Install search tools (Meilisearch)
3. Optionally set up AI features (Ollama)
4. Sync your first project/space

## Common Commands

### Daily Workflow

```bash
# View your assigned issues
ji mine

# View a specific issue (two ways)
ji PROJ-123                  # Shorthand
ji issue view PROJ-123       # Full command

# Take ownership of an issue
ji take PROJ-456

# View current sprint
ji sprint
```

### Search & Ask

```bash
# Search everything
ji search "login bug"

# Search only Confluence
ji search "api docs" --source confluence

# Ask the AI assistant
ji ask "How do we deploy to production?"
```

### Sync Data

```bash
# Sync a Jira project
ji issue sync PROJ

# Sync a Confluence space
ji confluence sync DOCS

# Sync all your workspaces
ji sync
```

## Key Features

### 🔍 Instant Search
All data is cached locally in SQLite with full-text search. Searches complete in milliseconds, even offline.

### 🤖 AI Assistant (Optional)
With Ollama installed, ask natural language questions about your knowledge base:
```bash
ji ask "What's our API rate limit?"
ji ask "Who owns the payment service?"
```

### 📱 Smart Sync
- Incremental sync only fetches changes
- Background refresh keeps data current
- Works offline with cached data

### 🎯 Sprint Management
```bash
ji sprint              # Current sprint overview
ji sprint unassigned   # Unassigned issues
ji board PROJ          # View project board
```

## Tips & Tricks

1. **Speed up searches** with source filters:
   ```bash
   ji search "error" --source jira --limit 20
   ```

2. **Remember facts** for the AI:
   ```bash
   ji remember "Our staging URL is https://staging.example.com"
   ```

3. **Sync in background**:
   ```bash
   ji confluence sync LARGE_SPACE --background
   ```

4. **View recent changes**:
   ```bash
   ji confluence recent ENG
   ```

## Documentation

- **[DOCS.md](DOCS.md)** - Complete command reference and advanced usage
- **[CLAUDE.md](CLAUDE.md)** - Development notes and architecture

## Quick Reference

```bash
# Setup
ji init                      # First-time setup
ji auth                      # Configure credentials

# Jira
ji mine                      # Your issues
ji <ISSUE-KEY>               # View issue (shorthand)
ji issue view <KEY>          # View issue (full command)
ji take <KEY>                # Assign to yourself
ji sprint [PROJECT]          # Sprint overview

# Confluence
ji confluence sync <SPACE>   # Sync space
ji confluence recent <SPACE> # Recent changes

# Search & AI
ji search "query"            # Search everything
ji ask "question"            # AI Q&A

# Maintenance
ji sync                      # Sync all workspaces
ji index                     # Rebuild search index
```

## License

MIT