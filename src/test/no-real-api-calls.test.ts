import { expect, test } from 'bun:test';
import { ConfluenceClient } from '../lib/confluence-client';
import { JiraClient } from '../lib/jira-client';

const mockConfig = {
  jiraUrl: 'https://example.atlassian.net',
  email: 'test@example.com',
  apiToken: 'mock-token',
  userId: 'test-user-id',
};

test('JiraClient blocks real API calls in test environment', () => {
  expect(() => {
    new JiraClient(mockConfig);
  }).toThrow('Real API calls detected in test environment!');
});

test('ConfluenceClient blocks real API calls in test environment', () => {
  expect(() => {
    new ConfluenceClient(mockConfig);
  }).toThrow('Real API calls detected in test environment!');
});

test('Environment protection can be bypassed with ALLOW_REAL_API_CALLS=true', () => {
  // Temporarily allow real API calls
  process.env.ALLOW_REAL_API_CALLS = 'true';

  try {
    // These should not throw
    const jiraClient = new JiraClient(mockConfig);
    const confluenceClient = new ConfluenceClient(mockConfig);

    expect(jiraClient).toBeDefined();
    expect(confluenceClient).toBeDefined();
  } finally {
    // Clean up
    delete process.env.ALLOW_REAL_API_CALLS;
  }
});
