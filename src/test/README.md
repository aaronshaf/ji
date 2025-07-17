# Testing Guide - Preventing Real API Calls

## Overview

All tests in this project MUST use MSW (Mock Service Worker) to intercept API calls. This ensures:
- ✅ No real API calls to Jira/Confluence servers
- ✅ Fast, reliable tests
- ✅ No accidental data modifications
- ✅ No API rate limiting issues

## How It Works

1. **Strict MSW Mode**: Our MSW setup uses `onUnhandledRequest: 'error'` which causes tests to fail if they try to make any unmocked network request.

2. **Automatic Interception**: When you import `./setup-msw`, MSW automatically intercepts ALL network requests.

3. **Explicit Mocking**: Every API call must be explicitly mocked - no exceptions.

## Writing Safe Tests

### Basic Test Structure

```typescript
import { test, expect } from 'bun:test';
import './setup-msw'; // REQUIRED: This prevents real API calls
import { mockJiraIssue, mockJiraError } from './test-utils';

test('my test that needs API data', async () => {
  // Mock the API response BEFORE making the call
  mockJiraIssue('TEST-123', {
    summary: 'My Test Issue',
    status: { name: 'Done' }
  });
  
  // Now safe to make the "API call" - MSW will intercept it
  const response = await fetch('https://example.atlassian.net/rest/api/3/issue/TEST-123');
  const data = await response.json();
  
  expect(data.fields.status.name).toBe('Done');
});
```

### Testing Error Scenarios

```typescript
test('handle 404 errors', async () => {
  mockJiraError('MISSING-123', 404);
  
  const response = await fetch('https://example.atlassian.net/rest/api/3/issue/MISSING-123');
  expect(response.status).toBe(404);
});
```

### Custom Mocks

```typescript
test('custom API response', async () => {
  server.use(
    http.get('*/rest/api/3/search', () => {
      return HttpResponse.json({
        issues: [
          { key: 'TEST-1', fields: { summary: 'Issue 1' } },
          { key: 'TEST-2', fields: { summary: 'Issue 2' } }
        ],
        total: 2
      });
    })
  );
  
  // Make request...
});
```

## Safety Checklist

Before running tests, ensure:

1. ✅ Import `./setup-msw` in EVERY test file that makes API calls
2. ✅ Mock ALL API endpoints your test will call
3. ✅ Never use real API tokens or credentials in tests
4. ✅ Use the provided mock utilities for common scenarios

## What Happens If You Forget?

If you forget to mock an API call, the test will immediately fail with an error like:
```
Error: [MSW] Cannot bypass a request when using the "error" strategy for the "onUnhandledRequest" option.
```

This is intentional! It prevents accidental real API calls.

## Available Mock Utilities

- `mockJiraIssue(key, fields)` - Mock a Jira issue response
- `mockJiraError(key, status, message?)` - Mock an error response
- `mockAPI(method, url, response, status?)` - Generic API mock
- `ensureMSWActive()` - Verify MSW is running (for debugging)

## Running Tests

```bash
# Run all tests (MSW will prevent real API calls)
bun test

# Run with coverage
bun run test:coverage

# Run specific test file
bun test src/test/example.test.ts
```

## Debugging

If tests are failing with network errors:

1. Check you've imported `./setup-msw`
2. Verify all API endpoints are mocked
3. Look for typos in URLs or mock patterns
4. Use `server.printHandlers()` to see active mocks

## Example: Testing a CLI Command

```typescript
import { test, expect } from 'bun:test';
import './setup-msw';
import { mockJiraIssue } from './test-utils';
import { viewIssue } from '../cli/commands/issue';

test('ji issue view command', async () => {
  // Mock the API response
  mockJiraIssue('PROJ-123', {
    summary: 'Test Issue',
    description: 'Test Description',
    status: { name: 'In Progress' }
  });
  
  // Capture console output
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => output.push(msg);
  
  try {
    // Run the command - it will use the mocked API
    await viewIssue('PROJ-123', {});
    
    // Verify output
    expect(output.join('\n')).toContain('Test Issue');
    expect(output.join('\n')).toContain('In Progress');
  } finally {
    console.log = originalLog;
  }
});
```

Remember: **EVERY test that could make an API call MUST import './setup-msw'**