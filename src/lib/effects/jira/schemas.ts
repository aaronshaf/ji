/**
 * Jira API Schemas
 * All Effect schemas for Jira API responses and validation
 */

import { Schema } from 'effect';

// ============= Jira API Schemas =============
export const IssueSchema = Schema.Struct({
  key: Schema.String,
  self: Schema.String,
  fields: Schema.Unknown, // Accept any fields structure for flexibility
});

export const SearchResultSchema = Schema.Struct({
  issues: Schema.Array(IssueSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

export const BoardSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  type: Schema.Literal('scrum', 'kanban'),
  location: Schema.optional(
    Schema.Struct({
      projectKey: Schema.optional(Schema.String),
      projectName: Schema.optional(Schema.String),
      projectTypeKey: Schema.optional(Schema.String),
      avatarURI: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
    }),
  ),
  self: Schema.String,
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
  state: Schema.Literal('active', 'closed', 'future'),
  name: Schema.String,
  startDate: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
  completeDate: Schema.optional(Schema.String),
  originBoardId: Schema.Number,
  goal: Schema.optional(Schema.String),
});

export const SprintsResponseSchema = Schema.Struct({
  values: Schema.Array(SprintSchema),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number,
});

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  projectTypeKey: Schema.String,
  simplified: Schema.optional(Schema.Boolean),
  style: Schema.optional(Schema.String),
});

export const UserSchema = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.String,
  emailAddress: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
});

// ============= Exported Types =============
export type Issue = Schema.Schema.Type<typeof IssueSchema>;
export type Board = Schema.Schema.Type<typeof BoardSchema>;
export type Sprint = Schema.Schema.Type<typeof SprintSchema>;
export type Project = Schema.Schema.Type<typeof ProjectSchema>;
export type JiraUser = Schema.Schema.Type<typeof UserSchema>;
export type SearchResult = Schema.Schema.Type<typeof SearchResultSchema>;
export type BoardsResponse = Schema.Schema.Type<typeof BoardsResponseSchema>;
export type SprintsResponse = Schema.Schema.Type<typeof SprintsResponseSchema>;
