import { Schema } from 'effect';

// Define a more specific Issue type for testing that matches what the actual API returns
interface TestIssue {
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string };
    assignee?: { displayName: string; emailAddress?: string; accountId?: string } | null;
    reporter: { displayName: string; emailAddress?: string; accountId?: string };
    priority?: { name: string } | null;
    created: string;
    updated: string;
    labels?: string[];
    comment?: unknown;
    project?: { key: string; name: string };
    [key: string]: unknown; // Allow additional custom fields
  };
}

import {
  type Board,
  BoardSchema,
  IssueSchema,
  type JiraUser,
  type Project,
  ProjectSchema,
  type Sprint,
  SprintSchema,
  UserSchema,
} from '../lib/effects/jira/schemas';

/**
 * Validates that a mock object conforms to the Effect schema
 * Throws an error if validation fails, providing detailed information about what's wrong
 */
export function validateMock<T>(schema: Schema.Schema<T>, mock: unknown, mockName: string): T {
  const result = Schema.decodeUnknownEither(schema)(mock);

  if (result._tag === 'Left') {
    // Format the error message
    const errors = JSON.stringify(result.left, null, 2);
    throw new Error(`Mock validation failed for ${mockName}:\n${errors}`);
  }

  return result.right;
}

/**
 * Creates a validated Issue mock that conforms to our Effect schema
 */
export function createValidIssue(overrides: Partial<TestIssue> = {}): TestIssue {
  const defaultFields = {
    summary: 'Test Issue Summary',
    description: 'Test issue description',
    status: {
      name: 'To Do',
    },
    assignee: {
      displayName: 'Test Assignee',
      emailAddress: 'assignee@test.com',
      accountId: 'test-assignee-id',
    },
    reporter: {
      displayName: 'Test Reporter',
      emailAddress: 'reporter@test.com',
      accountId: 'test-reporter-id',
    },
    priority: {
      name: 'Medium',
    },
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    project: {
      key: 'TEST',
      name: 'Test Project',
    },
    labels: [],
  };

  // Extract fields from overrides to handle separately
  const { fields: fieldOverrides, ...topLevelOverrides } = overrides;

  const defaultIssue: TestIssue = {
    key: 'TEST-123',
    self: 'https://test.atlassian.net/rest/api/3/issue/TEST-123',
    fields: {
      ...defaultFields,
      ...fieldOverrides, // This merges field overrides with defaults
    },
    ...topLevelOverrides, // Apply top-level overrides
  };

  // Update self URL to match key if key was overridden
  if (overrides.key && overrides.key !== 'TEST-123') {
    defaultIssue.self = `https://test.atlassian.net/rest/api/3/issue/${overrides.key}`;
  }

  // Validate the mock against our schema
  validateMock(IssueSchema, defaultIssue, 'Issue');
  return defaultIssue;
}

/**
 * Creates a validated JiraUser mock
 */
export function createValidUser(overrides: Partial<JiraUser> = {}): JiraUser {
  const defaultUser: JiraUser = {
    accountId: 'test-user-id',
    displayName: 'Test User',
    emailAddress: 'test@example.com',
    active: true,
    ...overrides,
  };

  return validateMock(UserSchema, defaultUser, 'JiraUser');
}

/**
 * Creates a validated Board mock
 */
export function createValidBoard(overrides: Partial<Board> = {}): Board {
  const defaultBoard: Board = {
    id: 1,
    name: 'Test Board',
    type: 'scrum',
    self: 'https://test.atlassian.net/rest/agile/1.0/board/1',
    location: {
      projectKey: 'TEST',
      projectName: 'Test Project',
    },
    ...overrides,
  };

  return validateMock(BoardSchema, defaultBoard, 'Board');
}

/**
 * Creates a validated Sprint mock
 */
export function createValidSprint(overrides: Partial<Sprint> = {}): Sprint {
  const defaultSprint: Sprint = {
    id: 1,
    self: 'https://test.atlassian.net/rest/agile/1.0/sprint/1',
    state: 'active',
    name: 'Sprint 1',
    startDate: '2024-01-01T00:00:00.000Z',
    endDate: '2024-01-14T00:00:00.000Z',
    originBoardId: 1,
    goal: 'Sprint goal',
    ...overrides,
  };

  return validateMock(SprintSchema, defaultSprint, 'Sprint');
}

/**
 * Creates a validated Project mock
 */
export function createValidProject(overrides: Partial<Project> = {}): Project {
  const defaultProject: Project = {
    id: '10000',
    key: 'TEST',
    name: 'Test Project',
    projectTypeKey: 'software',
    simplified: false,
    style: 'classic',
    ...overrides,
  };

  return validateMock(ProjectSchema, defaultProject, 'Project');
}

/**
 * Validates that MSW response data conforms to our schemas
 * Use this in MSW handlers to ensure mocks are valid
 */
export function validateAndReturn<T>(schema: Schema.Schema<T>, data: unknown, responseName: string): T {
  try {
    return validateMock(schema, data, responseName);
  } catch (error) {
    console.error(`MSW mock validation error for ${responseName}:`, error);
    throw error;
  }
}

/**
 * NOTE: Effect Schema Arbitrary generation has compatibility issues with our current schemas
 * The IssueSchema uses Schema.Unknown for fields, which generates unpredictable arbitrary data
 * For now, we'll keep the manual mock creation approach which gives us consistent, predictable mocks
 *
 * Future TODO: Create more specific schemas suitable for arbitrary generation, or
 * investigate Effect Schema Arbitrary compatibility with fast-check versions
 */

/**
 * Create an Issue mock using enhanced manual creation
 * This approach gives us full control over the generated data structure
 */
export function createArbitraryIssue(overrides: Partial<TestIssue> = {}, _seed = 12345): TestIssue {
  // For now, delegate to our proven manual creation approach
  return createValidIssue(overrides);
}

/**
 * Create a User mock using enhanced manual creation
 */
export function createArbitraryUser(overrides: Partial<JiraUser> = {}, _seed = 12345): JiraUser {
  // For now, delegate to our proven manual creation approach
  return createValidUser(overrides);
}

/**
 * Create multiple diverse Issues for comprehensive testing
 */
export function createDiverseIssues(count: number, _baseSeed = 12345): TestIssue[] {
  const diverseIssues: TestIssue[] = [];

  const variations = [
    { status: 'To Do', priority: 'High', project: 'ALPHA' },
    { status: 'In Progress', priority: 'Medium', project: 'BETA' },
    { status: 'In Review', priority: 'Low', project: 'GAMMA' },
    { status: 'Testing', priority: null, project: 'DELTA' },
  ];

  for (let i = 0; i < count; i++) {
    const variant = variations[i % variations.length];
    const issue = createValidIssue({
      key: `${variant.project}-${100 + i}`,
      fields: {
        summary: `Generated Issue ${i + 1}: Sample issue for testing`,
        status: { name: variant.status },
        priority: variant.priority ? { name: variant.priority } : null,
        project: { key: variant.project, name: `${variant.project} Project` },
        assignee: {
          displayName: `Developer ${i + 1}`,
          emailAddress: `dev${i + 1}@company.com`,
          accountId: `dev-${i + 1}-id`,
        },
        reporter: {
          displayName: `Reporter ${i + 1}`,
          emailAddress: `reporter${i + 1}@company.com`,
          accountId: `reporter-${i + 1}-id`,
        },
        labels: [`label-${i + 1}`],
        created: `2024-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
        updated: `2024-01-${String(i + 2).padStart(2, '0')}T15:30:00.000Z`,
      },
    });

    diverseIssues.push(issue);
  }

  return diverseIssues;
}
