# Testing with Bun + MSW

## Overview

This project uses **Bun's built-in test runner** with **MSW (Mock Service Worker)** for comprehensive testing, including real HTTP request interception.

## Key Features

✅ **Fast test execution** - All 48 tests run in ~180ms  
✅ **Real HTTP interception** - MSW intercepts actual network requests  
✅ **Unified test runner** - No need for separate test runners  
✅ **Jest-compatible syntax** - Familiar testing API  

## Test Structure

```
src/test/
├── integration-msw-issue-view.test.ts  # MSW integration tests
├── integration-issue-view-mvp.test.ts  # Mock-based integration tests
├── integration-simple.test.ts          # Environment protection tests
├── no-real-api-calls.test.ts         # API call protection tests
└── mocks/
    └── handlers.ts                    # Shared MSW handlers
```

## Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/test/integration-msw-issue-view.test.ts

# Run with coverage
bun test --coverage

# Watch mode
bun test --watch
```

## Writing MSW Integration Tests

```typescript
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Create MSW server
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

test('should intercept HTTP requests', async () => {
  // Mock specific endpoint
  server.use(
    http.get('https://api.example.com/data', () => {
      return HttpResponse.json({ message: 'Mocked!' });
    })
  );

  // Make request - MSW will intercept it
  const response = await fetch('https://api.example.com/data');
  const data = await response.json();
  
  expect(data.message).toBe('Mocked!');
});
```

## Environment Protection

By default, real API calls are blocked in tests:

```typescript
// JiraClient and ConfluenceClient check NODE_ENV
if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API_CALLS) {
  throw new Error('Real API calls detected in test environment!');
}
```

For MSW tests, temporarily allow API calls:

```typescript
test('MSW intercepts real API calls', async () => {
  process.env.ALLOW_REAL_API_CALLS = 'true';
  
  try {
    // Your test with MSW interception
  } finally {
    delete process.env.ALLOW_REAL_API_CALLS;
  }
});
```

## MSW Capabilities Tested

Our integration tests demonstrate:

1. **HTTP Request Interception** - Mock API responses
2. **Error Simulation** - Test 404s, network errors
3. **Request Counting** - Verify number of API calls
4. **Dynamic Responses** - Different responses per test

## Best Practices

1. **Use MSW for integration tests** - When you need to test real HTTP behavior
2. **Use mock classes for unit tests** - Faster for pure logic testing
3. **Reset handlers between tests** - Prevents test interference
4. **Handle unhandled requests** - Set `onUnhandledRequest: 'error'`
5. **Clean up environment** - Always reset `ALLOW_REAL_API_CALLS`

## Current Test Coverage

- **48 total tests** including:
  - 4 MSW integration tests
  - 7 mock-based integration tests
  - 3 environment protection tests
  - 34 unit tests

## Troubleshooting

### MSW Not Intercepting?
- Ensure `server.listen()` is called in `beforeAll`
- Check that `ALLOW_REAL_API_CALLS` is set
- Verify the request URL matches your handler

### Tests Failing with "Real API calls detected"?
- Add `process.env.ALLOW_REAL_API_CALLS = 'true'` for MSW tests
- Remember to clean up in `finally` block

### Import Errors?
- MSW requires dynamic imports after setting env vars
- Use `await import()` for API clients in tests

## Benefits of Bun + MSW

1. **Single test runner** - No need for Vitest or Jest
2. **Fast execution** - Bun's speed + efficient MSW
3. **Real interception** - Test actual HTTP layer
4. **Full compatibility** - MSW works perfectly with Bun
5. **Simple setup** - No complex configuration needed