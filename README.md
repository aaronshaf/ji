# ji - Jira & Confluence CLI

[![CI](https://github.com/aaronshaf/ji/actions/workflows/ci.yml/badge.svg)](https://github.com/aaronshaf/ji/actions/workflows/ci.yml)
[![Code Quality](https://img.shields.io/badge/warnings-0-brightgreen)](https://github.com/aaronshaf/ji/actions/workflows/ci.yml)

A fast, modern CLI for Jira and Confluence built with Bun and TypeScript. Direct API access for always-fresh data.

**Key benefits:**
- **Always fresh** - direct API access means current data
- **Fast and reliable** - optimized API queries with intelligent filtering
- **Human-first** - Pretty colored output by default, with --xml flag for LLM parsing
- **Smart filtering** - powerful status, time, and assignee filtering

## Architecture

**ji** is a pure API client with intelligent query optimization:

- **Direct API access** - Always shows current, fresh data
- **Flexible output** - Pretty colored output by default, XML format available with --xml flag
- **Smart filtering** - JQL-powered filtering for status, time ranges, and assignees
- **Effect-based error handling** - Type-safe operations with comprehensive error handling

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

# View your assigned issues with filtering
ji mine --status "In Progress"        # Filter by status
ji mine --since 24h                   # Issues updated in last 24h
ji mine --status "Closed" --since 7d  # Closed issues from last week

# View a specific issue (two ways)
ji PROJ-123                  # Shorthand
ji issue view PROJ-123       # Full command

# Take ownership of an issue
ji take PROJ-456

# View current sprint
ji sprint
```

### Search and Filter

```bash
# Search across all content
ji search "authentication error"

# Advanced filtering with JQL
ji mine --status "To Do,In Progress" --since 30d
```

## Key Features

### Smart Filtering
- Status-based filtering with JQL queries
- Time range filtering (24h, 7d, 30d, etc.)
- Always shows current, fresh data from API

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

1. **Filter your issues efficiently**:
   ```bash
   ji mine --status "In Progress,Review" --since 48h
   ```

2. **Search across all accessible content**:
   ```bash
   ji search "authentication bug" 
   ```

## Documentation

- **[DOCS.md](docs/DOCS.md)** - Complete command reference and advanced usage
- **[CLAUDE.md](CLAUDE.md)** - Development notes and architecture

## Quick Reference

```bash
# Setup
ji auth                      # Configure credentials

# Jira
ji mine                      # Your issues
ji mine --status "In Progress" --since 24h  # Filtered issues
ji <ISSUE-KEY>               # View issue (shorthand)
ji issue view <KEY>          # View issue (full command)
ji take <KEY>                # Assign to yourself
ji comment <KEY> ["text"]    # Add comment (supports wiki markup)
ji sprint [PROJECT]          # Sprint overview

# Search
ji search "bug authentication"  # Search across all content

# Testing
ji test --setup              # Configure environment tests
ji test                      # Run all tests
```

## License

MIT