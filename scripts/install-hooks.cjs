#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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

# Run linting  
echo "Running ESLint..."
bun run lint
if [ $? -ne 0 ]; then
  echo "❌ ESLint check failed. Commit aborted."
  echo "Tip: Run 'bun run lint:fix' to auto-fix some issues."
  exit 1
fi

echo "✅ Pre-commit checks passed!"
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
console.log('The hook will run type checking and linting before each commit.');
console.log('To bypass the hook, use: git commit --no-verify');