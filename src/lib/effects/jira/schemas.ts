/**
 * Jira API Schemas
 * All Zod schemas for Jira API responses and validation
 */

import { z } from 'zod';

// ============= Jira API Schemas =============
export const IssueSchema = z.object({
  key: z.string(),
  self: z.string(),
  fields: z
    .object({
      summary: z.string(),
      description: z.any().nullable(),
      status: z.object({
        name: z.string(),
      }),
      assignee: z
        .object({
          displayName: z.string(),
          emailAddress: z.string().email().optional(),
          accountId: z.string(),
        })
        .nullable(),
      reporter: z.object({
        displayName: z.string(),
        emailAddress: z.string().email().optional(),
        accountId: z.string(),
      }),
      priority: z
        .object({
          name: z.string(),
        })
        .nullable(),
      project: z
        .object({
          key: z.string(),
          name: z.string(),
        })
        .optional(),
      created: z.string(),
      updated: z.string(),
      // Common sprint custom fields
      customfield_10020: z.any().optional(),
      customfield_10021: z.any().optional(),
      customfield_10016: z.any().optional(),
      customfield_10018: z.any().optional(),
      customfield_10019: z.any().optional(),
    })
    .catchall(z.any()),
});

export const SearchResultSchema = z.object({
  issues: z.array(IssueSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

export const BoardSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.enum(['scrum', 'kanban']),
  location: z
    .object({
      projectKey: z.string().optional(),
      projectName: z.string().optional(),
      projectTypeKey: z.string().optional(),
      avatarURI: z.string().optional(),
      name: z.string().optional(),
      displayName: z.string().optional(),
    })
    .optional(),
  self: z.string(),
});

export const BoardsResponseSchema = z.object({
  values: z.array(BoardSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

export const SprintSchema = z.object({
  id: z.number(),
  self: z.string(),
  state: z.enum(['active', 'closed', 'future']),
  name: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  completeDate: z.string().optional(),
  originBoardId: z.number(),
  goal: z.string().optional(),
});

export const SprintsResponseSchema = z.object({
  values: z.array(SprintSchema),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  projectTypeKey: z.string(),
  simplified: z.boolean().optional(),
  style: z.string().optional(),
});

export const UserSchema = z.object({
  accountId: z.string(),
  displayName: z.string(),
  emailAddress: z.string().email().optional(),
  active: z.boolean().optional(),
});

// ============= Exported Types =============
export type Issue = z.infer<typeof IssueSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Sprint = z.infer<typeof SprintSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type JiraUser = z.infer<typeof UserSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type BoardsResponse = z.infer<typeof BoardsResponseSchema>;
export type SprintsResponse = z.infer<typeof SprintsResponseSchema>;