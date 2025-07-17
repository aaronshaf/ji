/**
 * Jira API Types and Interfaces
 * All type definitions and configuration constants for Jira operations
 */

import type { Board, Issue, Sprint } from './schemas.js';

// ============= Interface Definitions =============
export interface SearchOptions {
  startAt?: number;
  maxResults?: number;
  fields?: string[];
  expand?: string[];
}

export interface PaginatedResult<T> {
  values: T[];
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
}

export interface IssueSearchResult extends PaginatedResult<Issue> {}
export interface BoardSearchResult extends PaginatedResult<Board> {}
export interface SprintSearchResult extends PaginatedResult<Sprint> {}

// ============= Configuration =============
export const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'reporter',
  'priority',
  'project',
  'created',
  'updated',
  // Common sprint custom fields
  'customfield_10020',
  'customfield_10021',
  'customfield_10016',
  'customfield_10018',
  'customfield_10019',
];

// Re-export types from schemas for convenience
export type { Board, Issue, JiraUser, Project, Sprint } from './schemas.js';
