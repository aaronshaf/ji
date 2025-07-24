/**
 * Shared types for content service operations
 */

// ============= Content Service Types =============
export interface SearchableContentMetadata {
  status?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  version?: { number?: number };
  [key: string]: unknown;
}

export interface SearchableContent {
  id: string;
  source: 'jira' | 'confluence';
  type: string;
  title: string;
  content: string;
  url: string;
  spaceKey?: string;
  projectKey?: string;
  metadata?: SearchableContentMetadata;
  createdAt?: number;
  updatedAt?: number;
  syncedAt: number;
  contentHash?: string;
}

export interface SearchOptions {
  source?: 'jira' | 'confluence';
  type?: string;
  spaceKey?: string;
  projectKey?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  content: SearchableContent;
  score: number;
  snippet: string;
  chunkIndex?: number;
}

export interface ContentStats {
  totalContent: number;
  jiraIssues: number;
  confluencePages: number;
  spaceStats: Record<string, number>;
  projectStats: Record<string, number>;
  lastSync: Date | null;
}

export interface SprintInfo {
  id: string;
  name: string;
}

// Atlassian Document Format node type
export interface ADFNode {
  type?: string;
  text?: string;
  content?: ADFNode[];
}

export interface ConfluencePageData {
  id: string;
  title: string;
  content: string;
  spaceKey: string;
  url: string;
  version?: { number: number };
  createdAt?: number;
  updatedAt?: number;
}

export interface PageVersionInfo {
  version: number;
  updatedAt: number;
  syncedAt: number;
}

// Database row types
export interface ContentRow {
  id: string;
  source: string;
  type: string;
  title: string;
  content: string;
  url: string;
  space_key?: string;
  project_key?: string;
  metadata?: string;
  created_at?: number;
  updated_at?: number;
  synced_at: number;
  content_hash?: string;
}

export interface ContentRowWithSnippet extends ContentRow {
  snippet: string;
}
