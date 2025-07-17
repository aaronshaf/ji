# Testing and Code Quality Plan

## Overview

This document outlines the comprehensive testing strategy, code quality enforcement, and file size management for the ji CLI project.

## Test Coverage Strategy

### Current State
- Basic unit tests with Bun test runner
- Integration tests via `ji test` command with real environment data
- Manual testing through CLI usage

### Coverage Tracking Setup

1. **Install Coverage Tools**
   ```bash
   bun add -d c8 nyc
   ```

2. **Add Coverage Scripts to package.json**
   ```json
   {
     "scripts": {
       "test:coverage": "c8 bun test",
       "test:coverage:report": "c8 --reporter=html --reporter=text bun test",
       "test:coverage:check": "c8 --check-coverage --lines 40 --functions 40 --branches 30 bun test"
     }
   }
   ```

3. **Coverage Configuration (.c8rc.json)**
   ```json
   {
     "reporter": ["text", "html", "lcov"],
     "reports-dir": "coverage",
     "exclude": [
       "**/*.test.ts",
       "**/*.test.tsx",
       "**/test/**",
       "**/coverage/**",
       "src/cli.ts"
     ],
     "include": [
       "src/**/*.ts",
       "src/**/*.tsx"
     ]
   }
   ```

### Target Coverage Levels (Starting Small)

- **Initial Target (Phase 1)**: 40% line coverage, 40% function coverage, 30% branch coverage
- **Phase 2 (3 months)**: 60% line coverage, 60% function coverage, 45% branch coverage
- **Phase 3 (6 months)**: 75% line coverage, 75% function coverage, 60% branch coverage

### Priority Testing Areas

1. **High Priority** (Must reach 80%+ coverage):
   - Authentication (`src/lib/config.ts`)
   - Core CLI commands (`src/cli/commands/`)
   - Database operations (`src/lib/cache.ts`)

2. **Medium Priority** (Target 60%+ coverage):
   - API clients (`src/lib/jira-client.ts`, `src/lib/confluence-client.ts`)
   - Search functionality (`src/cli/commands/search.ts`)
   - Sync operations (`src/cli/commands/sync.ts`)

3. **Lower Priority** (Target 40%+ coverage):
   - Utility functions
   - UI components (Ink components)
   - Error handling edge cases

## Pre-commit/Pre-push Hook Setup

### Pre-commit Hook (Strict)
Create `.git/hooks/pre-commit`:
```bash
#!/bin/bash
set -e

echo "🔍 Running pre-commit checks..."

# Type checking
echo "📝 Type checking..."
bun run typecheck

# Linting and formatting
echo "🎨 Linting and formatting..."
bun run lint

# File size checking
echo "📏 Checking file sizes..."
bun run check-file-sizes

# Run tests with coverage check
echo "🧪 Running tests with coverage..."
bun run test:coverage:check

echo "✅ Pre-commit checks passed!"
```

### Pre-push Hook (Comprehensive)
Create `.git/hooks/pre-push`:
```bash
#!/bin/bash
set -e

echo "🚀 Running pre-push checks..."

# All pre-commit checks
echo "🔍 Running pre-commit checks..."
.git/hooks/pre-commit

# Full test suite
echo "🧪 Running full test suite..."
bun test

# Generate coverage report
echo "📊 Generating coverage report..."
bun run test:coverage:report

echo "✅ Pre-push checks passed!"
```

## MSW Integration Strategy

### Setup MSW for API Testing

1. **MSW Configuration**
   Create `src/test/mocks/handlers.ts`:
   ```typescript
   import { http, HttpResponse } from 'msw';
   import type { Issue } from '../lib/jira-client.js';

   export const handlers = [
     // Jira API mocks
     http.get('*/rest/api/3/issue/:issueKey', ({ params }) => {
       const mockIssue: Issue = {
         id: '12345',
         key: params.issueKey as string,
         fields: {
           summary: 'Mock Issue',
           description: 'Mock description',
           status: { name: 'Open' },
           priority: { name: 'Medium' },
           assignee: { displayName: 'Test User' },
           reporter: { displayName: 'Test Reporter' },
           created: '2023-01-01T00:00:00.000Z',
           updated: '2023-01-01T00:00:00.000Z'
         }
       };
       return HttpResponse.json(mockIssue);
     }),

     // Confluence API mocks
     http.get('*/wiki/rest/api/content/:pageId', ({ params }) => {
       return HttpResponse.json({
         id: params.pageId,
         title: 'Mock Page',
         body: { storage: { value: '<p>Mock content</p>' } }
       });
     }),

     // Search API mocks
     http.get('*/rest/api/3/search', () => {
       return HttpResponse.json({
         issues: [],
         total: 0
       });
     })
   ];
   ```

2. **Test Setup**
   Create `src/test/setup.ts`:
   ```typescript
   import { beforeAll, afterEach, afterAll } from 'bun:test';
   import { server } from './mocks/server';

   beforeAll(() => server.listen());
   afterEach(() => server.resetHandlers());
   afterAll(() => server.close());
   ```

3. **MSW Server Setup**
   Create `src/test/mocks/server.ts`:
   ```typescript
   import { setupServer } from 'msw/node';
   import { handlers } from './handlers';

   export const server = setupServer(...handlers);
   ```

### Testing Strategy with MSW

1. **Unit Tests**: Test individual functions with mocked API responses
2. **Integration Tests**: Test complete command flows with MSW
3. **Error Testing**: Mock API errors and network failures
4. **Performance Tests**: Mock slow responses to test timeout handling

## File Size Management

### File Size Limits

1. **Warning Thresholds**:
   - TypeScript files (`.ts`): 500 lines
   - TSX files (`.tsx`): 300 lines
   - Any file: 1000 lines

2. **Blocking Thresholds**:
   - TypeScript files (`.ts`): 800 lines
   - TSX files (`.tsx`): 500 lines
   - Any file: 1500 lines

### File Size Checker Script

Create `scripts/check-file-sizes.ts`:
```typescript
#!/usr/bin/env bun
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';

interface FileSize {
  path: string;
  lines: number;
  size: number;
}

const LIMITS = {
  warning: { ts: 500, tsx: 300, any: 1000 },
  blocking: { ts: 800, tsx: 500, any: 1500 }
};

async function checkFileSize(filePath: string): Promise<FileSize> {
  const content = await Bun.file(filePath).text();
  const lines = content.split('\n').length;
  const size = content.length;
  
  return { path: filePath, lines, size };
}

async function scanDirectory(dir: string): Promise<FileSize[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: FileSize[] = [];
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...await scanDirectory(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(await checkFileSize(fullPath));
    }
  }
  
  return results;
}

async function main() {
  console.log('📏 Checking file sizes...');
  
  const files = await scanDirectory('src');
  let hasWarnings = false;
  let hasBlocking = false;
  
  for (const file of files) {
    const ext = file.path.endsWith('.tsx') ? 'tsx' : 'ts';
    const warningLimit = LIMITS.warning[ext];
    const blockingLimit = LIMITS.blocking[ext];
    
    if (file.lines > blockingLimit) {
      console.log(chalk.red(`❌ BLOCKING: ${file.path} (${file.lines} lines, limit: ${blockingLimit})`));
      hasBlocking = true;
    } else if (file.lines > warningLimit) {
      console.log(chalk.yellow(`⚠️  WARNING: ${file.path} (${file.lines} lines, limit: ${warningLimit})`));
      hasWarnings = true;
    }
  }
  
  if (hasBlocking) {
    console.log(chalk.red('\n❌ Some files exceed blocking size limits!'));
    console.log(chalk.yellow('Consider splitting large files into smaller modules.'));
    process.exit(1);
  }
  
  if (hasWarnings) {
    console.log(chalk.yellow('\n⚠️  Some files are approaching size limits.'));
    console.log(chalk.gray('Consider refactoring if they grow further.'));
  } else {
    console.log(chalk.green('\n✅ All files are within size limits.'));
  }
}

main().catch(console.error);
```

### Package.json Scripts

Add to `package.json`:
```json
{
  "scripts": {
    "check-file-sizes": "bun run scripts/check-file-sizes.ts",
    "test:coverage": "c8 bun test",
    "test:coverage:report": "c8 --reporter=html --reporter=text bun test",
    "test:coverage:check": "c8 --check-coverage --lines 40 --functions 40 --branches 30 bun test"
  }
}
```

## Implementation Timeline

### Phase 1 (Week 1-2): Foundation
- [ ] Install coverage tools (c8)
- [ ] Set up basic coverage configuration
- [ ] Create file size checker script
- [ ] Install and configure MSW
- [ ] Set up pre-commit hooks

### Phase 2 (Week 3-4): Core Testing
- [ ] Write MSW handlers for main APIs
- [ ] Add unit tests for critical functions
- [ ] Achieve 40% baseline coverage
- [ ] Implement file size enforcement

### Phase 3 (Month 2): Coverage Expansion
- [ ] Add integration tests with MSW
- [ ] Expand test coverage to 60%
- [ ] Add error scenario testing
- [ ] Refactor oversized files

### Phase 4 (Month 3): Advanced Testing
- [ ] Performance testing with MSW
- [ ] Edge case coverage
- [ ] Achieve 75% target coverage
- [ ] Comprehensive error handling tests

## Monitoring and Reporting

### Coverage Reports
- Generate HTML coverage reports in `coverage/` directory
- Include coverage badges in README
- Track coverage trends over time

### File Size Monitoring
- Regular file size audits
- Automated alerts for files approaching limits
- Refactoring recommendations for large files

### Quality Metrics
- Test execution time monitoring
- Coverage trend analysis
- File size distribution reports

## Current Large Files Requiring Attention

Based on the codebase analysis, these files should be prioritized for refactoring:

1. **src/lib/jira-client.ts** - Likely >500 lines, needs splitting
2. **src/cli/index.ts** - Command routing, consider extracting help functions
3. **src/lib/cache.ts** - Database operations, potential for modularization

## Tools and Dependencies

### Required Dependencies
```bash
bun add -d c8 nyc msw
```

### Optional Tools
- `size-limit` - For bundle size monitoring
- `bundlesize` - Alternative file size checking
- `jest-coverage-badges` - For README badges

This plan provides a comprehensive approach to improving code quality while maintaining development velocity. The phased approach allows for gradual implementation without overwhelming the development process.