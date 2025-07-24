/**
 * Content Manager - Barrel export to maintain backward compatibility
 *
 * This file ensures all existing imports continue to work while we
 * split the large content-manager.ts file
 */

// Re-export everything from the original content-manager.ts
export * from '../content-manager.js';
// Search functionality that will eventually be moved
export type { SearchOptions } from './search.js';
export { searchContent, searchContentEffect } from './search.js';
// Types that will eventually be moved
export type {
  ADFNode,
  SearchableContent,
  SearchableContentMetadata,
  SearchResult,
} from './types.js';
// Utilities that will eventually be moved
export { escapeFTS5Query } from './utils.js';
