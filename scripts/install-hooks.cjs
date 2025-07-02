#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const hookScript = `#!/bin/sh
# Pre-commit hook for ji CLI

echo "Running pre-commit checks..."

# Run type checking
echo "Checking TypeScript..."
bun run typecheck
if [ $? -ne 0 ]; then
  echo "❌ TypeScript check failed. Commit aborted."
  exit 1
fi

# Run Biome formatting and linting with auto-fix
echo "Running Biome format and lint with auto-fix..."
bun run biome check --write .

# Check if Biome found any errors (exit code will be non-zero)
BIOME_EXIT_CODE=$?

# Add any files that were modified by Biome
git add -u

if [ $BIOME_EXIT_CODE -ne 0 ]; then
  echo "❌ Biome found errors that couldn't be auto-fixed. Commit aborted."
  echo "Run 'bun run lint' to see the errors."
  exit 1
fi

echo "✅ Pre-commit checks passed! (Biome may have auto-fixed some issues)"
exit 0
`;

const hooksDir = path.join('.git', 'hooks');
const preCommitPath = path.join(hooksDir, 'pre-commit');

// Check if we're in a git repository
if (!fs.existsSync('.git')) {
  console.log('Not a git repository, skipping hook installation.');
  process.exit(0);
}

// Create hooks directory if it doesn't exist
if (!fs.existsSync(hooksDir)) {
  fs.mkdirSync(hooksDir, { recursive: true });
}

// Write the pre-commit hook
fs.writeFileSync(preCommitPath, hookScript);

// Make it executable
fs.chmodSync(preCommitPath, '755');

console.log('✅ Pre-commit hook installed successfully!');
console.log('The hook will run type checking and Biome formatting/linting before each commit.');
console.log('To bypass the hook, use: git commit --no-verify');
