# Integration Testing MVP for ji CLI

## Overview

This document describes the MVP approach for integration testing in the ji CLI, given the current limitations with MSW + Bun compatibility.

## Current Status

✅ **Working**: Environment-based protection prevents real API calls  
❌ **Not Working**: MSW request interception with Bun  
✅ **MVP Solution**: Mock classes with dependency injection pattern

## Approach

Since MSW doesn't work with Bun currently, we use a hybrid approach:

### 1. Environment Protection (Already Working)
```typescript
// All API clients check NODE_ENV=test and throw if real calls attempted
if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API_CALLS) {
  throw new Error('Real API calls detected in test environment!');
}
```

### 2. Mock Service Classes
```typescript
class MockJiraClient {
  async getIssue(key: string): Promise<Issue> {
    if (key === 'TEST-123') {
      return mockIssue;
    }
    throw new Error('Issue not found');
  }
}
```

### 3. Integration Test Pattern
```typescript
test('integration test', async () => {
  // 1. Create mock services
  const jiraClient = new MockJiraClient(config);
  const configManager = new MockConfigManager();
  
  // 2. Test the workflow
  const issue = await jiraClient.getIssue('TEST-123');
  
  // 3. Verify formatting/output
  expect(issue.key).toBe('TEST-123');
});
```

## MVP Capabilities

The current MVP provides:

### ✅ What We Can Test
- **Core business logic** - issue formatting, data processing
- **Error handling** - 404s, auth failures, etc.
- **End-to-end workflows** - fetch → cache → format → display
- **Output formatting** - YAML structure, colors (without ANSI)
- **Mock service behavior** - realistic API responses

### ❌ What We Cannot Test (Yet)
- **Real HTTP requests** - MSW interception doesn't work with Bun
- **CLI argument parsing** - Would need more setup
- **File system operations** - Could be added later
- **Background processes** - Complex to mock

## Files

- `integration-simple.test.ts` - Basic framework verification
- `integration-issue-view-mvp.test.ts` - Full MVP example for issue view command
- `no-real-api-calls.test.ts` - Environment protection verification

## Example Usage

```typescript
// Test the core issue display functionality
test('issue view integration', async () => {
  const mockIssue = { key: 'TEST-123', fields: { summary: 'Test' } };
  const jiraClient = new MockJiraClient();
  
  const issue = await jiraClient.getIssue('TEST-123');
  
  // Verify issue processing
  expect(issue.fields.summary).toBe('Test');
  
  // Test output formatting (capture console.log)
  const output = captureConsoleOutput(() => {
    formatIssueOutput(issue, config);
  });
  
  expect(output).toContain('key: TEST-123');
});
```

## Future Improvements

When MSW + Bun compatibility improves:
1. Replace mock classes with MSW handlers
2. Add HTTP-level integration tests
3. Test CLI argument parsing end-to-end
4. Add file system operation tests

## Running Tests

```bash
# Run integration tests
NODE_ENV=test bun test src/test/integration-*.test.ts

# Run all tests  
bun test
```

## Benefits of This Approach

1. **Safe** - Prevents accidental real API calls
2. **Fast** - No network requests, pure unit tests
3. **Reliable** - No flaky network dependencies
4. **Comprehensive** - Tests core business logic thoroughly
5. **Maintainable** - Easy to update mock data
6. **Ready for MSW** - Easy to migrate when Bun support improves