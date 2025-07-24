// Shared types for content management

export interface SearchableContentMetadata {
  status?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  [key: string]: string | number | undefined;
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
}

export interface SearchResult {
  content: SearchableContent;
  score: number;
  snippet: string;
  chunkIndex?: number;
}

// Atlassian Document Format node type
export interface ADFNode {
  type?: string;
  text?: string;
  content?: ADFNode[];
}
