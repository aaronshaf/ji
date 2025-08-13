# ji - Jira & Confluence CLI

[![CI](https://github.com/aaronshaf/ji/actions/workflows/ci.yml/badge.svg)](https://github.com/aaronshaf/ji/actions/workflows/ci.yml)
[![Code Quality](https://img.shields.io/badge/warnings-0-brightgreen)](https://github.com/aaronshaf/ji/actions/workflows/ci.yml)

A fast, modern CLI for Jira and Confluence built with Bun and TypeScript. Features local caching for instant access.

**Key benefits:**
- **Lightning fast** - local caching means instant responses
- **Always fresh** - automatic background sync
- **LLM-friendly** - YAML output format, minimal tokens, no color codes
- **Offline capable** - full functionality without network access

## Local-First Architecture

**ji** provides a hybrid approach for optimal performance:

- **Remote-first for issues** - `ji PROJ-123` fetches fresh data from Jira by default
- **Local-first for search** - Search and list operations use SQLite for instant results  
- **XML output format** - Structured XML output optimized for LLM parsing
- **Offline mode** - Add `--local` flag to any command to use cached data
- **Background sync** - Data updates happen silently in the background

Issue viewing commands fetch fresh data by default, ensuring you always see the latest status. Use `--local` for instant offline access when needed.

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
2. Sync your first project/space

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

### Smart Sync
- Incremental sync only fetches changes
- Background refresh keeps data current
- Works offline with cached data

### Sprint Management
```bash
ji sprint              # Current sprint overview
ji sprint unassigned   # Unassigned issues
ji board PROJ          # View project board
```

### Testing Framework
Built-in testing for environment-specific commands:
```bash
ji test --setup        # Configure tests for your environment
ji test                # Run all configured tests
```

Features:
- Environment-specific test cases (real issue keys, projects)
- Comprehensive coverage of all commands
- Pass/fail reporting with statistics

## Tips & Tricks

1. **Sync in background**:
   ```bash
   ji confluence sync LARGE_SPACE --background
   ```

2. **View recent changes**:
   ```bash
   ji confluence recent ENG
   ```

## Documentation

- **[DOCS.md](docs/DOCS.md)** - Complete command reference and advanced usage
- **[CLAUDE.md](CLAUDE.md)** - Development notes and architecture

## Quick Reference

```bash
# Setup
ji init                      # First-time setup
ji auth                      # Configure credentials

# Jira
ji mine                      # Your issues
ji <ISSUE-KEY>               # View issue (shorthand)
ji <ISSUE-KEY> --fetch       # View issue (fetch fresh from API)
ji issue view <KEY>          # View issue (full command)
ji issue view <KEY> --fetch  # View issue (fetch fresh from API)
ji take <KEY>                # Assign to yourself
ji comment <KEY> ["text"]    # Add comment (supports wiki markup)
ji sprint [PROJECT]          # Sprint overview

# Confluence
ji confluence sync <SPACE>   # Sync space
ji confluence recent <SPACE> # Recent changes

# Maintenance
ji sync                      # Sync all workspaces

# Testing
ji test --setup              # Configure environment tests
ji test                      # Run all tests
```

## License

MIT