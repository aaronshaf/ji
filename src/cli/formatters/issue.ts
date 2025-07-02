import chalk from 'chalk';

// Atlassian Document Format node type
interface ADFNode {
  type: string;
  text?: string;
  content?: ADFNode[];
  attrs?: Record<string, unknown>;
}

/**
 * Format issue description from Atlassian Document Format or plain text
 */
export function formatDescription(description: unknown): string {
  if (!description) return chalk.gray('No description');

  if (typeof description === 'string') {
    return description.trim() || chalk.gray('No description');
  }

  // Type guard for ADF format
  if (typeof description === 'object' && description !== null && 'version' in description && 'content' in description) {
    const adfDescription = description as { version: number; content: ADFNode[] };
    return parseADF(adfDescription.content);
  }

  return chalk.gray('No description');
}

/**
 * Parse Atlassian Document Format nodes into text
 */
export function parseADF(nodes: ADFNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'paragraph':
          return node.content ? parseADF(node.content) : '';
        case 'text':
          return node.text || '';
        case 'hardBreak':
          return '\n';
        case 'mention':
          return `@${node.attrs?.text || 'user'}`;
        case 'emoji':
          return node.attrs?.shortName || '';
        case 'bulletList':
        case 'orderedList':
          return node.content ? `\n${parseADF(node.content)}` : '';
        case 'listItem':
          return `  • ${node.content ? parseADF(node.content) : ''}`;
        case 'codeBlock':
          return node.content ? `\n\`\`\`\n${parseADF(node.content)}\n\`\`\`\n` : '';
        case 'heading': {
          const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
          const prefix = '#'.repeat(level);
          return node.content ? `\n${prefix} ${parseADF(node.content)}\n` : '';
        }
        case 'blockquote':
          return node.content ? `\n> ${parseADF(node.content)}\n` : '';
        case 'rule':
          return '\n---\n';
        case 'link': {
          const href = node.attrs?.href || '#';
          const text = node.content ? parseADF(node.content) : href;
          return `[${text}](${href})`;
        }
        default:
          return node.content ? parseADF(node.content) : '';
      }
    })
    .join('');
}

/**
 * Get emoji icon for Jira issue status
 */
export function getJiraStatusIcon(status: string): string {
  const statusLower = status.toLowerCase();
  if (statusLower.includes('done') || statusLower.includes('closed') || statusLower.includes('resolved')) {
    return '✅';
  } else if (statusLower.includes('progress') || statusLower.includes('review')) {
    return '🔄';
  } else if (statusLower.includes('blocked')) {
    return '🚫';
  } else if (statusLower.includes('todo') || statusLower.includes('open') || statusLower.includes('backlog')) {
    return '📋';
  }
  return '❓';
}
