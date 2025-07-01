# ji CLI - Comprehensive Documentation

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Commands Reference](#commands-reference)
- [Search & AI Features](#search--ai-features)
- [Memory System](#memory-system)
- [Sync Strategies](#sync-strategies)
- [Advanced Usage](#advanced-usage)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

## Installation

### Prerequisites

- **Bun** (required): JavaScript runtime and package manager
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

- **Meilisearch** (required): Fast search engine
  ```bash
  # macOS
  brew install meilisearch
  brew services start meilisearch

  # Linux/WSL
  curl -L https://install.meilisearch.com | sh
  ./meilisearch
  ```

- **Ollama** (optional): AI features
  ```bash
  # macOS/Linux
  curl -fsSL https://ollama.ai/install.sh | sh
  
  # Pull a model (recommended)
  ollama pull llama3.2
  ```

### Install ji

```bash
git clone https://github.com/aaronshaf/ji.git
cd ji
bun install
bun link
```

## Configuration

### Authentication

ji stores credentials securely in `~/.ji/auth.json` with 600 permissions.

```bash
# Interactive setup (recommended)
ji init

# Manual setup
ji auth
```

### Directory Structure

```
~/.ji/
├── auth.json       # Encrypted credentials (600 permissions)
├── data.db         # SQLite database with cached content
├── settings.json   # User preferences and model configuration
└── sync.log        # Background sync logs
```

### Settings

Configure AI models and preferences:

```bash
ji models  # Interactive model selection
```

Or edit `~/.ji/settings.json` directly:

```json
{
  "askModel": "llama3.2",
  "embeddingModel": "mxbai-embed-large",
  "analysisModel": "llama3.2"
}
```

## Commands Reference

### Core Commands

#### Authentication & Setup
```bash
ji init                      # First-time setup wizard
ji auth                      # Configure authentication
ji models                    # Configure AI models
```

#### Jira Commands
```bash
ji mine                      # Show your assigned issues
ji issue view <KEY>          # View issue details
ji issue sync <PROJECT>      # Sync all issues from a project
ji take <KEY>                # Assign issue to yourself
ji board [PROJECT]           # Show boards (all or by project)
ji sprint [PROJECT]          # Show current sprint(s)
ji sprint unassigned [PROJ]  # Show unassigned sprint issues
```

#### Confluence Commands
```bash
ji confluence sync <SPACE>   # Sync Confluence space
ji confluence view <PAGE-ID> # View page content
ji confluence recent <SPACE> # Show recently updated pages
```

#### Search & AI
```bash
ji search "query"            # Search across all content
ji ask "question"            # AI-powered Q&A
ji remember "fact"           # Add to memory
```

#### Sync & Maintenance
```bash
ji sync                      # Sync all active workspaces
ji index                     # Rebuild search index
```

### Command Options

#### Global Options
- `--help, -h` - Show help
- `--json, -j` - Output as JSON
- `--verbose, -v` - Show additional details

#### Sync Options
- `--sync, -s` - Force sync from API
- `--clean` - Clear local data before sync
- `--background` - Run sync in background

#### Search Options
- `--source [jira|confluence]` - Filter by source
- `--limit <n>` - Limit results (default: 5)
- `--all` - Include closed/resolved issues
- `--include-jira` - Include Jira in AI answers
- `--include-old` - Include old documents (3+ years)

## Search & AI Features

### Search Types

1. **Keyword Search** (no Ollama required)
   ```bash
   ji search "websocket error"
   ```

2. **Hybrid Search** (with Ollama)
   - Combines keyword matching with semantic understanding
   - Automatically enabled when Ollama is available

3. **AI-Powered Q&A**
   ```bash
   ji ask "how do I configure SSO?"
   ji ask "what team owns the payment service?"
   ```

### Search Tips

- Use quotes for exact phrases: `ji search "exact phrase"`
- Filter by source: `ji search "API docs" --source confluence`
- Increase result limit: `ji search "deployment" --limit 20`

### AI Model Selection

The AI features use different models for different tasks:

- **Ask Model**: Main Q&A responses (default: llama3.2)
- **Embedding Model**: Semantic search (default: mxbai-embed-large)
- **Analysis Model**: Query understanding (default: same as ask model)

## Memory System

ji includes an intelligent memory system that learns from your interactions.

### Manual Memory Management

```bash
# Add a fact
ji remember "The payments team uses Stripe for processing"

# List memories
ji memories list
ji memories list --limit 50

# Search memories
ji memories search "payment"

# Delete a memory
ji memories delete <ID>

# Clear memories
ji memories clear          # Clear manual memories only
ji memories clear --all    # Clear ALL memories (dangerous)

# View statistics
ji memories stats
```

### Automatic Memory Extraction

When you use `ji ask`, the system automatically:
1. Extracts key facts from search results
2. Stores them with relevance scores
3. Uses them to improve future answers

### Memory Storage

Memories are stored in SQLite with:
- Unique key facts
- Source document references
- Access counts and timestamps
- Relevance scoring

## Sync Strategies

### Initial Sync

```bash
# Sync a new project
ji issue sync PROJECT

# Sync a new space
ji confluence sync SPACE
```

### Incremental Sync

```bash
# Sync only recent changes (default for ji sync)
ji sync
```

### Clean Sync

```bash
# Clear and re-sync everything
ji issue sync PROJECT --clean
ji confluence sync SPACE --clean
```

### Background Sync

```bash
# Run Confluence sync in background
ji confluence sync SPACE --background
```

### Auto-refresh

ji automatically refreshes data in the background when you access it, ensuring content is always fresh.

## Advanced Usage

### Workspace Management

Active workspaces are tracked automatically. View them in the database:

```sql
sqlite3 ~/.ji/data.db "SELECT * FROM workspaces WHERE is_active = 1"
```

### Custom Queries

Access the SQLite database directly:

```bash
sqlite3 ~/.ji/data.db

# Example: Find all critical bugs
SELECT key, summary FROM issues 
WHERE priority = 'Critical' 
AND status != 'Done'
ORDER BY updated DESC;
```

### Search Index Management

```bash
# Rebuild search index
ji index --clean

# Check index stats
curl http://localhost:7700/indexes/ji-content/stats
```

### Batch Operations

```bash
# Sync multiple projects
for proj in PROJ1 PROJ2 PROJ3; do
  ji issue sync $proj
done

# Sync all spaces
for space in $(cat spaces.txt); do
  ji confluence sync $space --background
done
```

## Troubleshooting

### Common Issues

#### "No configuration found"
Run `ji init` or `ji auth` to set up authentication.

#### "Meilisearch is not running"
```bash
# macOS
brew services start meilisearch

# Linux/Manual
meilisearch --db-path ./meili-data
```

#### "Ollama is not available"
```bash
# Start Ollama
ollama serve

# Pull a model
ollama pull llama3.2
```

#### Sync Issues

1. **Timeout errors**: Reduce batch size or use `--background`
2. **Rate limiting**: Add delays between syncs
3. **Large spaces**: Use incremental sync or background mode

#### Search Not Working

1. Ensure Meilisearch is running
2. Rebuild index: `ji index --clean`
3. Check logs: `~/.ji/sync.log`

### Debug Mode

```bash
# Run with verbose output
ji search "query" --verbose

# Check database
sqlite3 ~/.ji/data.db ".tables"
sqlite3 ~/.ji/data.db "SELECT COUNT(*) FROM searchable_content"

# Check Meilisearch
curl http://localhost:7700/health
```

### Reset & Clean

```bash
# Reset specific data
rm ~/.ji/data.db          # Clear all cached data
rm ~/.ji/auth.json        # Clear credentials
rm ~/.ji/settings.json    # Clear settings

# Full reset
rm -rf ~/.ji
ji init
```

## Architecture

### Technology Stack

- **Runtime**: Bun (no Node.js dependencies)
- **Database**: SQLite with FTS5 (full-text search)
- **Search**: Meilisearch (typo-tolerant, fast)
- **AI**: Ollama (local LLM, optional)
- **Language**: TypeScript with Zod validation

### Data Flow

1. **API Fetch** → Jira/Confluence REST APIs
2. **Storage** → SQLite with normalized schema
3. **Indexing** → Meilisearch for search
4. **AI Processing** → Ollama for embeddings/Q&A
5. **Memory** → Automatic fact extraction

### Database Schema

```sql
-- Main content table
CREATE TABLE searchable_content (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  space_key TEXT,
  project_key TEXT,
  metadata TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  synced_at INTEGER
);

-- Full-text search
CREATE VIRTUAL TABLE searchable_content_fts USING fts5(
  title, content, content=searchable_content
);

-- Workspaces tracking
CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  key_or_id TEXT NOT NULL,
  name TEXT,
  last_accessed INTEGER,
  is_active INTEGER DEFAULT 1
);
```

### Performance Optimizations

- Incremental sync with timestamp tracking
- Parallel batch processing
- Background refresh on access
- Aggressive caching with SQLite
- Efficient embedding generation

### Security Considerations

- Credentials stored with 600 permissions
- No credentials in environment variables
- No sensitive data in logs
- API tokens never exposed in git

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT