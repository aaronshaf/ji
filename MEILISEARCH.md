# Meilisearch Configuration for ji CLI

The ji CLI uses Meilisearch for enhanced search capabilities and automatically handles index naming to avoid conflicts in shared environments.

## Automatic Index Management

ji automatically creates uniquely named indexes in Meilisearch:
- `{user-prefix}-jira-issues` - Contains Jira issues for full-text search
- `{user-prefix}-confluence-pages` - Contains Confluence pages for full-text search

The prefix is automatically derived from your email address (the part before @) to ensure uniqueness. For example:
- Email: `john.doe@company.com` → Prefix: `john_doe`
- Indexes: `john_doe-jira-issues`, `john_doe-confluence-pages`

## Shared Environment Support

### Automatic Conflict Prevention
- **Zero configuration**: Works out of the box in shared Meilisearch instances
- **User isolation**: Each user gets their own set of indexes automatically
- **No data mixing**: Users cannot see each other's data

### Requirements for Shared Environments
- **Meilisearch permissions**: Users need read/write access to create indexes
- **No administrative setup**: ji handles all index management automatically

## Advanced Configuration (Optional)

For specialized use cases, you can override the automatic prefix:

```bash
# Set custom prefix (advanced users only)
sqlite3 ~/.ji/data.db "INSERT OR REPLACE INTO config (key, value) VALUES ('meilisearchIndexPrefix', 'custom-name')"

# After changing prefix, rebuild indexes
ji sync --clean
```

### When to Use Custom Prefixes
- **Team shared indexes**: `frontend-team`, `backend-team`
- **Environment separation**: `john-dev`, `john-staging`, `john-prod`
- **Service accounts**: `ci-bot`, `monitoring`

## Troubleshooting

### Viewing Your Current Indexes
```bash
# List all indexes in Meilisearch
curl http://localhost:7700/indexes | jq '.results[].uid'

# Check your current prefix
sqlite3 ~/.ji/data.db "SELECT value FROM config WHERE key = 'meilisearchIndexPrefix'"
```

### Clean Installation
If you need to reset your indexes:
```bash
ji sync --clean  # Rebuilds all indexes from scratch
```

### Permission Issues
If you get permission errors:
- Ensure Meilisearch is running and accessible
- Verify you can create indexes (try with curl)
- Check if your email-based prefix conflicts with existing indexes

## Performance Notes

- **No overhead**: Automatic prefixes add no performance cost
- **Isolation**: Each user's search is completely isolated
- **Scalability**: Supports unlimited users on shared Meilisearch
- **Maintenance**: No manual index management required