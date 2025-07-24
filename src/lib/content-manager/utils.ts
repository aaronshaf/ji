/**
 * Utilities for content management
 */

/**
 * Escape special characters in FTS5 queries to prevent syntax errors
 */
export function escapeFTS5Query(query: string): string {
  // FTS5 special characters that need escaping: " * ? ( ) [ ] { } \ : ^
  // We'll use double quotes to make it a phrase search, which handles most special chars
  // But first escape any existing double quotes
  const escaped = query.replace(/"/g, '""');

  // If the query contains special FTS5 operators, wrap in quotes
  if (/[*?()[\]{}\\:^]/.test(query)) {
    return `"${escaped}"`;
  }

  // For simple queries, return as-is (but still escape quotes)
  return escaped;
}
