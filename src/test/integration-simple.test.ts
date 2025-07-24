import { expect, test } from 'bun:test';

// Simple integration test to verify we can test CLI commands without real API calls
// This demonstrates the MVP approach for integration testing

test('Integration test framework MVP - environment protection works', () => {
  // Test that our environment protection is working
  expect(process.env.NODE_ENV).toBe('test');

  // Import the clients - they should throw because NODE_ENV=test
  const { JiraClient } = require('../lib/jira-client.js');
  const { ConfluenceClient } = require('../lib/confluence-client.js');

  const mockConfig = {
    jiraUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'mock-token',
    userId: 'test-user-id',
  };

  // These should throw in test environment
  expect(() => new JiraClient(mockConfig)).toThrow('Real API calls detected in test environment!');
  expect(() => new ConfluenceClient(mockConfig)).toThrow('Real API calls detected in test environment!');
});

test('Integration test framework MVP - can bypass protection for testing', () => {
  // Set the bypass flag
  process.env.ALLOW_REAL_API_CALLS = 'true';

  try {
    const { JiraClient } = require('../lib/jira-client.js');
    const mockConfig = {
      jiraUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'mock-token',
      userId: 'test-user-id',
    };

    // This should not throw now
    const client = new JiraClient(mockConfig);
    expect(client).toBeDefined();
  } finally {
    // Clean up
    delete process.env.ALLOW_REAL_API_CALLS;
  }
});

// Demonstrate how we could test CLI commands with dependency injection
test('Integration test concept - CLI command with injected dependencies', async () => {
  // Mock implementations
  const mockJiraClient = {
    async getIssue(key: string) {
      return {
        key,
        fields: {
          summary: 'Mock Issue Summary',
          status: { name: 'To Do' },
          assignee: { displayName: 'Mock User' },
        },
      };
    },
  };

  const mockConfigManager = {
    async getConfig() {
      return {
        jiraUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
      };
    },
    close() {},
  };

  // Simulate a CLI command function that accepts injected dependencies
  async function mockViewIssue(
    issueKey: string,
    jiraClient: typeof mockJiraClient,
    _configManager: typeof mockConfigManager,
  ) {
    const issue = await jiraClient.getIssue(issueKey);
    return `Issue: ${issue.key} - ${issue.fields.summary}`;
  }

  // Test the command
  const result = await mockViewIssue('TEST-123', mockJiraClient, mockConfigManager);
  expect(result).toContain('TEST-123');
  expect(result).toContain('Mock Issue Summary');
});
