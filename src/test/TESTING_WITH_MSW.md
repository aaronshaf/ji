# Testing with MSW - Current Status

## Issue with Bun + MSW

We've discovered that MSW's request interception isn't working properly with Bun's test runner. The handlers are registered but not matching requests. This appears to be a known compatibility issue between Bun and MSW's Node.js interceptors.

## Current Protection Against Real API Calls

### 1. MSW Setup (Partial Protection)
- MSW is configured with `onUnhandledRequest: 'error'`
- This will cause tests to fail if they make unmocked requests
- However, the mocking itself isn't working properly with Bun

### 2. Alternative Approaches for ji CLI

Since this is a CLI app, we have several options:

#### Option A: Mock at the Module Level
```typescript
// In tests, mock the JiraClient module
import { mock } from 'bun:test';

mock.module('../../lib/jira-client.js', () => ({
  JiraClient: class MockJiraClient {
    async getIssue(key: string) {
      return { key, fields: { summary: 'Mocked' } };
    }
  }
}));
```

#### Option B: Dependency Injection
```typescript
// Pass clients as parameters to commands
export async function viewIssue(
  issueKey: string, 
  options: any,
  jiraClient = new JiraClient(config) // Allow injection
) {
  // Implementation
}

// In tests
const mockClient = {
  getIssue: async (key) => ({ key, fields: mockFields })
};
await viewIssue('TEST-123', {}, mockClient);
```

#### Option C: Environment-based Protection
```typescript
// In JiraClient constructor
if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API) {
  throw new Error('Real API calls are not allowed in tests!');
}
```

## Recommended Approach

For immediate protection:

1. **Add environment check to API clients**:
```typescript
// src/lib/jira-client.ts
export class JiraClient {
  constructor(config: Config) {
    if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API_CALLS) {
      throw new Error(
        'Real API calls detected in test environment! ' +
        'Use mocks or set ALLOW_REAL_API_CALLS=true'
      );
    }
    // ... rest of constructor
  }
}
```

2. **Set NODE_ENV in test scripts**:
```json
{
  "scripts": {
    "test": "NODE_ENV=test bun test",
    "test:coverage": "NODE_ENV=test c8 bun test"
  }
}
```

3. **Use module mocking for unit tests**:
```typescript
// Example test with module mocking
import { test, expect, mock } from 'bun:test';

// Mock the entire module
mock.module('./path/to/api-client', () => ({
  APIClient: class {
    async fetch() {
      return { mocked: true };
    }
  }
}));
```

## MSW Future

Once Bun adds full Node.js compatibility for MSW, the existing MSW setup will work. For now, we need alternative approaches to ensure tests don't make real API calls.

## Summary

1. ✅ MSW is installed and configured (ready for future use)
2. ⚠️  MSW request interception doesn't work with Bun yet
3. ✅ Environment-based protection can prevent real API calls
4. ✅ Module mocking works well for unit tests
5. ✅ All tests will fail if they try to make real API calls (with env check)