/**
 * Confluence Client Types and Interfaces
 * All types and interfaces for the Confluence client
 */

import type {
  AuthenticationError,
  ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.js';
import type { Page, Space } from './schemas.js';

// ============= Common Error Types =============
export type CommonErrors =
  | NetworkError
  | AuthenticationError
  | ParseError
  | TimeoutError
  | RateLimitError
  | ConfigError;
export type AllErrors = CommonErrors | ValidationError | NotFoundError;

// ============= Search and Pagination Types =============
export interface SearchOptions {
  start?: number;
  limit?: number;
  expand?: string[];
  spaceKey?: string;
  type?: 'page' | 'blogpost' | 'attachment' | 'comment';
}

export interface PaginatedResult<T> {
  values: readonly T[] | T[];
  start: number;
  limit: number;
  size: number;
  totalSize?: number;
  isLast: boolean;
}

export interface PageSearchResult extends PaginatedResult<Page> {}
export interface SpaceSearchResult extends PaginatedResult<Space> {}

export interface PageSummary {
  id: string;
  title: string;
  version: {
    number: number;
    when: string;
    by?: {
      displayName: string;
    };
  };
  webUrl: string;
  spaceKey?: string;
}

// ============= Content Operation Types =============
export interface SpaceContentOptions {
  start?: number;
  limit?: number;
  expand?: string[];
  depth?: 'all' | 'root';
  status?: 'current' | 'trashed' | 'draft';
}

export interface ContentCreationOptions {
  type: 'page' | 'blogpost';
  title: string;
  space: { key: string };
  body: {
    storage: {
      value: string;
      representation: 'storage';
    };
  };
  ancestors?: Array<{ id: string }>;
}

export interface ContentUpdateOptions {
  version: { number: number };
  title?: string;
  body?: {
    storage: {
      value: string;
      representation: 'storage';
    };
  };
  status?: 'current' | 'draft';
}
