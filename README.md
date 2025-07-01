# ji - Jira & Confluence CLI

A fast, modern CLI for Jira and Confluence built with Bun and TypeScript. Features local SQLite caching with background sync for instant access to your data.

Inspired by [jira-cli](https://github.com/ankitpokhrel/jira-cli).

## Features

- ⚡ **Lightning fast** - Built with Bun, local SQLite caching, <50ms search
- 🧠 **Smart search** - Hybrid semantic + keyword search with typo tolerance
- 🤖 **AI-powered** - Ask questions about your knowledge base with memory
- 📚 **Complete integration** - Both Jira issues and Confluence pages
- 🔄 **Always fresh** - Automatic background sync keeps data up-to-date

## Prerequisites

- [Bun](https://bun.sh) (v1.0 or later)
- [Meilisearch](https://www.meilisearch.com) (for search functionality)
- [Ollama](https://ollama.com) (for AI Q&A and hybrid search embeddings)

### Installing Meilisearch

```bash
# macOS
brew install meilisearch
brew services start meilisearch

# Linux/WSL
curl -L https://install.meilisearch.com | sh
./meilisearch
```

### Installing Ollama

For hybrid search and AI Q&A:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the default embedding model for hybrid search
ollama pull mxbai-embed-large

# Pull the language model for AI Q&A
ollama pull gemma3n

# For better analysis and reasoning, consider upgrading to:
ollama pull phi4:latest

# Ollama runs as a service automatically
```

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
- Index content in Meilisearch for fast searching

#### Show your open issues

```bash
ji mine
```

Shows all open issues assigned to you, grouped by project.

#### Take ownership of an issue

```bash
ji take PROJ-123
```

Assigns the specified issue to yourself. Shows the issue details and confirms the assignment.

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

#### Fast Search Setup

Before searching, index your data to Meilisearch:
```bash
ji index              # Index all documents
ji index --clean      # Clear and re-index everything
```

Search across all cached content (both Jira and Confluence):
```bash
ji search "performance issues"
```

By default, closed/resolved/done issues are excluded. To include all issues:
```bash
ji search "performance issues" --all
```

Filter by source:
```bash
ji search "deployment" --source jira              # Only Jira issues
ji search "api documentation" --source confluence  # Only Confluence pages
```

Limit results:
```bash
ji search "bug" --limit 5
```

Search features:
- ⚡ Instant results (<50ms)
- 🧠 Hybrid semantic + keyword search (understands meaning and context)
- 🎯 Typo tolerance (finds "authentcation" → "authentication")
- 📊 Smart ranking based on relevance
- 🔍 Highlighted search terms in results
- 📋 Shows status, priority, and reporter for Jira issues


### AI Q&A

Ask questions about your synced data using AI:

```bash
ji ask "How do we handle authentication?"
```

By default, the AI assistant focuses on Confluence documentation. To include Jira issues in the search:

```bash
ji ask "What bugs are related to login?" --include-jira
```

Options:
- `--source [jira|confluence]` - Search only specific source
- `--limit <n>` - Number of context documents to use (default: 10)
- `--verbose` - Show which documents were used
- `--model <name>` - Use a different Ollama model (default: gemma3n)
- `--include-old` - Include documentation not modified in 3+ years

The AI uses the same hybrid search technology to find the most relevant documentation and provides concise, contextual answers. It also learns from previous Q&A sessions, storing key facts for improved future responses.

#### AI Setup

For AI Q&A to work, you need the language model:

```bash
# Pull the default language model
ollama pull gemma3n

# For better analysis and reasoning, consider upgrading to:
ollama pull phi4:latest
```

### Memory Management

The AI assistant can remember facts from previous conversations and manual additions. This helps improve response accuracy over time.

#### Add a fact manually

```bash
ji remember "EVAL team handles Canvas evaluation and grading systems"
```

#### List stored memories

```bash
ji memories list                  # Show recent memories
ji memories list --limit 50       # Show more memories
```

#### Search memories

```bash
ji memories search "EVAL"         # Search for specific terms
```

#### Delete a specific memory

```bash
ji memories delete <memory-id>    # Delete by ID (shown in list)
```

#### Clear memories

```bash
ji memories clear                 # Clear only manually added memories
ji memories clear --all           # Clear ALL memories (requires confirmation)
```

#### View memory statistics

```bash
ji memories stats                 # Show total memories and usage
```

The memory system helps correct false information by allowing you to:
- Manually add correct facts that override auto-extracted ones
- Delete incorrect memories that were automatically extracted
- Clear all memories if needed to start fresh

### Model Configuration

Configure which Ollama models to use for AI features:

```bash
ji models
```

This interactive command lets you:
- Auto-detect available Ollama models
- Select which model to use for Q&A (ask command)
- Select which model to use for embeddings (hybrid search)
- Select which model to use for analysis (query generation & source selection)
- Automatically pull models if they're not installed

### Index Management

Index all documents to Meilisearch for fast search:
```bash
ji index              # Index all documents
ji index --clean      # Clear indexes and re-index
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
- **Storage**: Bun's built-in SQLite database stored in `~/.ji/data.db`
- **Authentication**: Credentials stored separately in `~/.ji/auth.json` (600 permissions)
- **Search**: Meilisearch for instant, typo-tolerant search with smart ranking
- **AI**: Local LLM integration via Ollama for Q&A functionality
- **Sync**: Background processes for data refresh
- **Security**: API credentials stored securely, never committed to git
- **Zero Node.js dependencies**: Runs entirely on Bun

## License

MIT