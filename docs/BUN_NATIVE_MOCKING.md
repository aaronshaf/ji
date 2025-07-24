# Bun Native Mocking for HTTP Calls

## ✅ Working Solution for Bun + HTTP Mocking

Since MSW has compatibility issues with Bun, we can use **Bun's native mocking** to achieve the same results with better performance and no compatibility issues.

## Why Bun Native Mocking?

1. **🚀 No compatibility issues** - Works perfectly with Bun's runtime
2. **⚡ Better performance** - No service worker overhead
3. **🛡️ Same safety** - Still prevents real API calls
4. **📊 Schema validation** - Works with Effect schemas
5. **🔧 More control** - Direct control over mock behavior

## Working Pattern

### Basic Fetch Mocking

```typescript
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Schema } from 'effect';
import { IssueSchema } from '../lib/effects/jira/schemas';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.ALLOW_REAL_API_CALLS;
});

test('Bun fetch mocking with schema validation', async () => {
  // Create schema-validated mock data
  const mockIssue = {
    key: 'BUN-123',
    self: 'https://test.atlassian.net/rest/api/3/issue/BUN-123',
    fields: {
      summary: 'Bun Mock Test',
      status: { name: 'Done' },
      assignee: {
        displayName: 'Bun Tester',
        emailAddress: 'bun@example.com',
        accountId: 'bun-tester-id',
      },
      reporter: {
        displayName: 'Reporter',
        emailAddress: 'reporter@example.com',
        accountId: 'reporter-id',
      },
      created: '2024-01-01T10:00:00.000Z',
      updated: '2024-01-02T15:30:00.000Z',
      issuetype: { name: 'Task' },
      labels: ['bun', 'test'],
      project: { key: 'BUN', name: 'Bun Project' },
    },
  };

  // Mock fetch globally
  global.fetch = mock(async (url: RequestInfo | URL) => {
    if (typeof url === 'string' && url.includes('/issue/BUN-123')) {
      return new Response(JSON.stringify(mockIssue), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  });

  // Enable API calls to bypass protection
  process.env.ALLOW_REAL_API_CALLS = 'true';

  // Import and use client
  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient({
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
  });

  // Make API call - intercepted by mock
  const issue = await client.getIssue('BUN-123');

  // Verify mock data
  expect(issue.key).toBe('BUN-123');
  expect(issue.fields.summary).toBe('Bun Mock Test');

  // Verify schema compliance
  const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
  expect(validationResult._tag).toBe('Right');

  // Verify mock was called
  expect(global.fetch).toHaveBeenCalled();
});
```

### Advanced Pattern with Multiple Endpoints

```typescript
test('Multiple endpoint mocking', async () => {
  global.fetch = mock(async (url: RequestInfo | URL) => {
    const urlString = typeof url === 'string' ? url : url.toString();
    
    if (urlString.includes('/issue/SUCCESS-123')) {
      return new Response(JSON.stringify(successIssue), { status: 200 });
    }
    
    if (urlString.includes('/issue/ERROR-123')) {
      return new Response(
        JSON.stringify({ errorMessages: ['Not found'] }),
        { status: 404 }
      );
    }

    if (urlString.includes('/myself')) {
      return new Response(JSON.stringify(currentUser), { status: 200 });
    }

    // Default to error for safety
    return new Response('Unexpected request', { status: 500 });
  });

  // ... rest of test
});
```

### Module-Level Mocking

```typescript
test('Module mocking approach', async () => {
  // Mock the entire client module
  mock.module('../lib/jira-client', () => ({
    JiraClient: class MockJiraClient {
      constructor(config: any) {}

      async getIssue(issueKey: string) {
        if (issueKey === 'MODULE-789') {
          return mockIssue;
        }
        throw new Error('Issue not found');
      }
    }
  }));

  const { JiraClient } = await import('../lib/jira-client');
  const client = new JiraClient(config);
  const issue = await client.getIssue('MODULE-789');
  
  expect(issue.key).toBe('MODULE-789');
});
```

## Benefits vs MSW

| Feature | MSW | Bun Native |
|---------|-----|------------|
| **Bun Compatibility** | ❌ Issues | ✅ Perfect |
| **Performance** | ⚠️ Service Worker overhead | ✅ Direct mocking |
| **Schema Validation** | ✅ Yes | ✅ Yes |
| **Error Simulation** | ✅ Yes | ✅ Yes |
| **Multiple Endpoints** | ✅ Easy | ✅ Easy |
| **Setup Complexity** | ⚠️ Server setup needed | ✅ Simple |
| **Runtime Support** | ❌ Node.js only | ✅ Bun native |

## Migration from MSW

If you were using MSW patterns, here's how to migrate:

### MSW Pattern
```typescript
// OLD - MSW pattern
server.use(
  http.get('https://api.example.com/users/:id', ({ params }) => {
    return HttpResponse.json(mockUser);
  })
);
```

### Bun Native Pattern
```typescript
// NEW - Bun native pattern
global.fetch = mock(async (url) => {
  if (url.includes('/users/123')) {
    return new Response(JSON.stringify(mockUser), { status: 200 });
  }
  return new Response('Not found', { status: 404 });
});
```

## Testing Patterns

### 1. Schema-First Testing
```typescript
import { createValidIssue } from './msw-schema-validation';

const mockIssue = createValidIssue({ key: 'TEST-123' });
// mockIssue is guaranteed to pass schema validation
```

### 2. Error Testing
```typescript
global.fetch = mock(async (url) => {
  return new Response(
    JSON.stringify({ errorMessages: ['Permission denied'] }),
    { status: 403 }
  );
});

await expect(client.getIssue('FORBIDDEN')).rejects.toThrow();
```

### 3. Request Verification
```typescript
const mockFetch = mock(async () => new Response(JSON.stringify(data)));
global.fetch = mockFetch;

await client.getIssue('TEST-123');

expect(mockFetch).toHaveBeenCalledWith(
  'https://test.atlassian.net/rest/api/3/issue/TEST-123',
  expect.objectContaining({
    method: 'GET',
    headers: expect.objectContaining({
      'Authorization': expect.stringContaining('Basic'),
    }),
  })
);
```

## Best Practices

1. **Always restore fetch**: Use `beforeEach`/`afterEach` to prevent test pollution
2. **Use schema validation**: Ensure mocks conform to expected schemas
3. **Handle all endpoints**: Provide defaults to catch unexpected requests
4. **Test error cases**: Mock both success and failure scenarios
5. **Verify calls**: Check that mocks were called with expected parameters

## Result

✅ **Perfect Bun compatibility**  
✅ **Schema validation with Effect**  
✅ **No real API calls**  
✅ **Better performance than MSW**  
✅ **Same safety guarantees**

Bun native mocking gives us all the benefits of MSW with none of the compatibility issues! 🚀