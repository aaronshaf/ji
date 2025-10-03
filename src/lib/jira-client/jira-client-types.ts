import { Schema } from 'effect';

// Schema definitions
export const IssueSchema = Schema.Struct({
  key: Schema.String,
  self: Schema.String,
  fields: Schema.Unknown, // Accept any fields structure
});

export const SearchResultSchema = Schema.Struct({
  issues: Schema.Array(IssueSchema),
  startAt: Schema.Number.pipe(Schema.optional),
  maxResults: Schema.Number.pipe(Schema.optional),
  total: Schema.Number.pipe(Schema.optional),
  nextPageToken: Schema.String.pipe(Schema.optional),
});

export const BoardSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  type: Schema.String,
  location: Schema.Struct({
    projectKey: Schema.String.pipe(Schema.optional),
    projectName: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
});

export const BoardsResponseSchema = Schema.Struct({
  values: Schema.Array(BoardSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

export const SprintSchema = Schema.Struct({
  id: Schema.Number,
  self: Schema.String,
  state: Schema.String,
  name: Schema.String,
  startDate: Schema.String.pipe(Schema.optional),
  endDate: Schema.String.pipe(Schema.optional),
  originBoardId: Schema.Number,
  goal: Schema.String.pipe(Schema.optional),
});

export const SprintsResponseSchema = Schema.Struct({
  values: Schema.Array(SprintSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

// Type definitions
export interface Issue {
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string };
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter: { displayName: string; emailAddress?: string };
    priority?: { name: string } | null;
    created: string;
    updated: string;
    labels?: string[];
    comment?: unknown;
    project?: { key: string; name: string };
    [key: string]: unknown; // Allow additional custom fields
  };
}

export type Board = Schema.Schema.Type<typeof BoardSchema>;
export type Sprint = Schema.Schema.Type<typeof SprintSchema>;

// Error types for Jira operations
export class JiraError extends Error {
  readonly _tag = 'JiraError';
}

export class NetworkError extends Error {
  readonly _tag = 'NetworkError';
}

export class AuthenticationError extends Error {
  readonly _tag = 'AuthenticationError';
}

export class NotFoundError extends Error {
  readonly _tag = 'NotFoundError';
}

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

// Standard fields to fetch for issues
// Note: Using '*' doesn't work reliably - Jira API sometimes omits the 'fields' property
// when using the wildcard, so we specify fields explicitly
export const ISSUE_FIELDS = [
  'summary',
  'status',
  'assignee',
  'reporter',
  'priority',
  'created',
  'updated',
  'description',
  'labels',
  'comment',
  'project',
  'parent', // Parent issue (for subtasks and epics in next-gen projects)
  'customfield_10014', // Epic Link (common)
  'customfield_10008', // Epic Link (alternative)
  'customfield_10001', // Epic Link (alternative)
  'customfield_10020', // Sprint (common field)
  'customfield_10021', // Sprint (alternative)
  'customfield_10016', // Sprint (alternative)
  'customfield_10018', // Sprint (alternative)
  'customfield_10019', // Sprint (alternative)
  '*navigable', // Get all navigable custom fields
];
