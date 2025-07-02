/**
 * Extract team name from content
 */
export function getTeamFromMetadata(content: { metadata?: Record<string, unknown>; spaceKey?: string }): string {
  // Try to extract team from metadata
  if (content.metadata?.spaceName && typeof content.metadata.spaceName === 'string') {
    return content.metadata.spaceName;
  }
  if (content.metadata?.assignee && typeof content.metadata.assignee === 'string') {
    return content.metadata.assignee.split('@')[0]; // Simple team extraction
  }
  if (content.spaceKey) {
    return content.spaceKey;
  }
  return 'Unknown';
}
