# Hybrid Testing Strategy: Bun + Vitest + MSW

## Overview

This project uses a **hybrid testing approach** to get the best of both worlds:
- **Bun**: Lightning-fast unit tests
- **Vitest + MSW**: Real HTTP interception for integration tests

## Why Hybrid?

**Problem**: MSW (Mock Service Worker) doesn't work with Bun due to Node.js HTTP module incompatibilities.

**Solution**: Use Bun for unit tests and Vitest (Node.js) for MSW integration tests.

## Test Structure

```
src/test/
├── *.test.ts              # Bun unit tests (mock-based)
├── *.vitest.ts            # Vitest integration tests (MSW-based)
├── setup-msw-vitest.ts    # MSW setup for Vitest
└── mocks/
    └── handlers.ts        # MSW request handlers
```

## Running Tests

### All Tests (Recommended)
```bash
bun run test:all
# Runs both Bun unit tests and Vitest integration tests
```

### Unit Tests Only (Bun)
```bash
bun test
# Fast, mock-based tests
# 44 tests in ~150ms
```

### Integration Tests Only (Vitest + MSW)
```bash
bun run test:integration
# Real HTTP interception with MSW
# Tests actual network layer
```

### Interactive Integration Tests
```bash
bun run test:integration:ui
# Opens Vitest UI for debugging
```

## Writing Tests

### Unit Tests (Bun)
Use `.test.ts` extension for Bun unit tests:

```typescript
// src/lib/example.test.ts
import { test, expect } from 'bun:test';

test('unit test example', () => {
  expect(1 + 1).toBe(2);
});
```

### Integration Tests (Vitest + MSW)
Use `.vitest.ts` extension for MSW integration tests:

```typescript
// src/test/example.vitest.ts
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './setup-msw-vitest';

describe('MSW Integration Test', () => {
  it('should intercept HTTP requests', async () => {
    server.use(
      http.get('https://api.example.com/data', () => {
        return HttpResponse.json({ message: 'Mocked!' });
      })
    );

    const response = await fetch('https://api.example.com/data');
    const data = await response.json();
    
    expect(data.message).toBe('Mocked!');
  });
});
```

## Key Differences

### Bun Tests
- ✅ Super fast (~150ms for entire suite)
- ✅ Great for unit tests and business logic
- ✅ Uses Bun's built-in SQLite
- ❌ Can't intercept real HTTP requests
- ❌ MSW doesn't work

### Vitest + MSW Tests
- ✅ Real HTTP interception
- ✅ Tests actual network behavior
- ✅ Can test error scenarios (timeouts, 404s)
- ❌ Slower than Bun
- ❌ Can't use Bun-specific APIs (bun:sqlite)

## Best Practices

1. **Use Bun for most tests** - It's faster and covers 90% of needs
2. **Use Vitest + MSW for critical integration points** - When you need to test actual HTTP behavior
3. **Name files clearly** - `.test.ts` for Bun, `.vitest.ts` for Vitest
4. **Keep MSW handlers updated** - In `src/test/mocks/handlers.ts`

## Current Test Coverage

- **Bun Unit Tests**: 44 tests covering:
  - Core business logic
  - Formatters and utilities
  - Mock-based integration tests
  
- **Vitest + MSW Tests**: 4 tests covering:
  - Real HTTP request interception
  - Network error scenarios
  - Multiple request handling

## CI/CD Configuration

For CI pipelines, run both test suites:

```yaml
# GitHub Actions example
- name: Run Tests
  run: |
    bun install
    bun run test:all
```

## Troubleshooting

### MSW Not Working?
- Make sure you're using `.vitest.ts` extension
- Check that `ALLOW_REAL_API_CALLS=true` is set in tests
- Verify handlers in `src/test/mocks/handlers.ts`

### Bun Tests Failing?
- Don't import MSW in `.test.ts` files
- Use mock classes instead of MSW for Bun tests

### Need Bun-specific APIs in Integration Tests?
- Consider splitting the test
- Use Bun for SQLite operations
- Use Vitest for HTTP operations