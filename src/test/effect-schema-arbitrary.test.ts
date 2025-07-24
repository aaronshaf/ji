import { expect, test } from 'bun:test';
import { Schema } from 'effect';
import { IssueSchema, UserSchema } from '../lib/effects/jira/schemas';
import { createArbitraryIssue, createArbitraryUser, createDiverseIssues } from './msw-schema-validation';

// Test enhanced mock generation for consistent, schema-compliant test data

test('createArbitraryIssue generates schema-compliant Issues', () => {
  const arbitraryIssue = createArbitraryIssue();

  // Validate that the generated mock passes schema validation
  const validationResult = Schema.decodeUnknownEither(IssueSchema)(arbitraryIssue);
  expect(validationResult._tag).toBe('Right');

  // Generated issues should have all required fields
  expect(arbitraryIssue.key).toBeDefined();
  expect(arbitraryIssue.self).toBeDefined();
  expect(arbitraryIssue.fields).toBeDefined();
  expect(arbitraryIssue.fields.summary).toBeDefined();
  expect(arbitraryIssue.fields.status).toBeDefined();
  expect(arbitraryIssue.fields.reporter).toBeDefined();
});

test('createArbitraryIssue allows overrides while maintaining schema compliance', () => {
  const customKey = 'CUSTOM-999';
  const customSummary = 'Custom Issue Summary';

  const issue = createArbitraryIssue({
    key: customKey,
    fields: {
      summary: customSummary,
      status: { name: 'Done' },
      reporter: {
        displayName: 'Custom Reporter',
        emailAddress: 'custom-reporter@test.com',
        accountId: 'custom-reporter-id',
      },
      created: '2024-01-01T12:00:00.000Z',
      updated: '2024-01-01T14:00:00.000Z',
    },
  });

  // Overrides should be applied
  expect(issue.key).toBe(customKey);
  expect(issue.fields.summary).toBe(customSummary);
  expect(issue.fields.status.name).toBe('Done');

  // Generated data should still be present for non-overridden fields
  expect(issue.self).toBeDefined();
  expect(issue.fields.reporter).toBeDefined();

  // Schema validation should still pass
  const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
  expect(validationResult._tag).toBe('Right');
});

test('createArbitraryUser generates valid users with overrides', () => {
  const customEmail = 'custom@test.com';
  const customName = 'Custom User';

  const user = createArbitraryUser({
    emailAddress: customEmail,
    displayName: customName,
    active: false,
  });

  // Overrides should be applied
  expect(user.emailAddress).toBe(customEmail);
  expect(user.displayName).toBe(customName);
  expect(user.active).toBe(false);

  // Generated fields should still be present
  expect(user.accountId).toBeDefined();

  // Schema validation should pass
  const validationResult = Schema.decodeUnknownEither(UserSchema)(user);
  expect(validationResult._tag).toBe('Right');
});

test('createDiverseIssues generates varied issue data', () => {
  const diverseIssues = createDiverseIssues(4);

  expect(diverseIssues).toHaveLength(4);

  // Each issue should have different status/priority combinations
  const statuses = diverseIssues.map((issue) => issue.fields.status.name);
  const projects = diverseIssues.map((issue) => issue.fields.project?.key);

  // Should have variety in statuses and projects
  expect(new Set(statuses).size).toBeGreaterThan(1);
  expect(new Set(projects).size).toBeGreaterThan(1);

  // All should be schema-compliant
  diverseIssues.forEach((issue, index) => {
    const validationResult = Schema.decodeUnknownEither(IssueSchema)(issue);
    expect(validationResult._tag).toBe('Right');
    expect(issue.fields.summary).toContain(`Generated Issue ${index + 1}`);
    expect(issue.key).toMatch(/^(ALPHA|BETA|GAMMA|DELTA)-\d+$/);
  });
});

test('createDiverseIssues creates issues with predictable patterns', () => {
  const diverseIssues = createDiverseIssues(8);

  expect(diverseIssues).toHaveLength(8);

  // Should cycle through the variations
  expect(diverseIssues[0].fields.status.name).toBe('To Do');
  expect(diverseIssues[0].fields.priority?.name).toBe('High');
  expect(diverseIssues[0].fields.project?.key).toBe('ALPHA');

  expect(diverseIssues[1].fields.status.name).toBe('In Progress');
  expect(diverseIssues[1].fields.priority?.name).toBe('Medium');
  expect(diverseIssues[1].fields.project?.key).toBe('BETA');

  expect(diverseIssues[2].fields.status.name).toBe('In Review');
  expect(diverseIssues[2].fields.priority?.name).toBe('Low');
  expect(diverseIssues[2].fields.project?.key).toBe('GAMMA');

  expect(diverseIssues[3].fields.status.name).toBe('Testing');
  expect(diverseIssues[3].fields.priority).toBeNull();
  expect(diverseIssues[3].fields.project?.key).toBe('DELTA');

  // Should cycle back to the beginning
  expect(diverseIssues[4].fields.status.name).toBe('To Do');
  expect(diverseIssues[4].fields.project?.key).toBe('ALPHA');
});

test('Enhanced mock generation maintains consistent structure', () => {
  const issue1 = createArbitraryIssue({ key: 'TEST-1' });
  const issue2 = createArbitraryUser({ accountId: 'user-123' });

  // Issues should have consistent structure
  expect(issue1).toHaveProperty('key');
  expect(issue1).toHaveProperty('self');
  expect(issue1).toHaveProperty('fields');
  expect(issue1.fields).toHaveProperty('summary');
  expect(issue1.fields).toHaveProperty('status');
  expect(issue1.fields).toHaveProperty('reporter');

  // Users should have consistent structure
  expect(issue2).toHaveProperty('accountId');
  expect(issue2).toHaveProperty('displayName');
  expect(issue2).toHaveProperty('active');

  // Both should be schema-compliant
  expect(Schema.decodeUnknownEither(IssueSchema)(issue1)._tag).toBe('Right');
  expect(Schema.decodeUnknownEither(UserSchema)(issue2)._tag).toBe('Right');
});
