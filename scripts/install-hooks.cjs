#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const preCommitScript = `#!/bin/sh
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

# Check file sizes
echo "Checking file sizes..."
bun run check-file-sizes
if [ $? -ne 0 ]; then
  echo "❌ File size check failed. Commit aborted."
  exit 1
fi

# Run test coverage check
echo "Checking test coverage..."
bun run test:coverage:check
if [ $? -ne 0 ]; then
  echo "❌ Test coverage below minimum threshold. Commit aborted."
  exit 1
fi

echo "✅ Pre-commit checks passed! (Biome may have auto-fixed some issues)"
exit 0
`;

const prePushScript = `#!/bin/sh
# Pre-push hook for ji CLI

echo "Running pre-push checks..."

# Run type checking
echo "Checking TypeScript..."
bun run typecheck
if [ $? -ne 0 ]; then
  echo "❌ TypeScript check failed. Push aborted."
  exit 1
fi

# Run Biome linting (no auto-fix on push)
echo "Running Biome lint check..."
bunx biome check .
if [ $? -ne 0 ]; then
  echo "❌ Biome found issues. Push aborted."
  echo "Run 'bun run lint:fix' to fix issues."
  exit 1
fi

# Check file sizes
echo "Checking file sizes..."
bun run check-file-sizes
if [ $? -ne 0 ]; then
  echo "❌ File size check failed. Push aborted."
  exit 1
fi

# Run test coverage check
echo "Checking test coverage..."
bun run test:coverage:check
if [ $? -ne 0 ]; then
  echo "❌ Test coverage below minimum threshold. Push aborted."
  exit 1
fi

# Run tests
echo "Running tests..."
bun test
if [ $? -ne 0 ]; then
  echo "❌ Tests failed. Push aborted."
  exit 1
fi

echo "✅ Pre-push checks passed!"
exit 0
`;

const hooksDir = path.join('.git', 'hooks');
const preCommitPath = path.join(hooksDir, 'pre-commit');
const prePushPath = path.join(hooksDir, 'pre-push');

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
fs.writeFileSync(preCommitPath, preCommitScript);
fs.chmodSync(preCommitPath, '755');

// Write the pre-push hook
fs.writeFileSync(prePushPath, prePushScript);
fs.chmodSync(prePushPath, '755');

console.log('✅ Git hooks installed successfully!');
console.log('');
console.log('Pre-commit hook will run:');
console.log('  - TypeScript type checking');
console.log('  - Biome formatting/linting (with auto-fix)');
console.log('  - File size checks');
console.log('  - Test coverage checks');
console.log('');
console.log('Pre-push hook will run:');
console.log('  - TypeScript type checking');
console.log('  - Biome linting (no auto-fix)');
console.log('  - File size checks');
console.log('  - Test coverage checks');
console.log('  - All tests');
console.log('');
console.log('To bypass hooks, use: git commit/push --no-verify');
