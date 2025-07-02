import { Effect } from 'effect';
import TurndownService from 'turndown';

// Initialize Turndown with optimized settings for Confluence
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  strongDelimiter: '**',
  emDelimiter: '_',
});

// Configure Turndown to better handle tables
turndownService.keep(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

// Convert Confluence storage format to Markdown (better for LLMs)
export function confluenceToMarkdown(storageFormat: string): string {
  if (!storageFormat) return '';

  // Pre-process Confluence-specific XML
  let processed = storageFormat;

  // Handle CDATA sections
  processed = processed.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');

  // Convert Confluence code macros to standard HTML
  processed = processed.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:parameter[^>]*ac:name="language"[^>]*>([^<]*)<\/ac:parameter>.*?<ac:plain-text-body><!\[CDATA\[(.*?)\]\]><\/ac:plain-text-body>.*?<\/ac:structured-macro>/gs,
    '<pre><code class="language-$1">$2</code></pre>',
  );

  // Convert to markdown
  let markdown = turndownService.turndown(processed);

  // Post-process tables to ensure they're properly formatted
  markdown = markdown.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_match: string, tableContent: string) => {
    const rows = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
    if (rows.length === 0) return '';

    let mdTable = '\n\n';
    let headerProcessed = false;

    for (const row of rows) {
      const cells = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g) || [];
      const cellContents = cells.map((cell: string) =>
        cell
          .replace(/<t[hd][^>]*>|<\/t[hd]>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim(),
      );

      if (cellContents.length > 0) {
        mdTable += `| ${cellContents.join(' | ')} |\n`;

        if (!headerProcessed) {
          mdTable += `|${cellContents.map(() => '---').join('|')}|\n`;
          headerProcessed = true;
        }
      }
    }

    return `${mdTable}\n`;
  });

  // Clean up excessive newlines
  return markdown
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/\[\s*\]/g, '')
    .trim();
}

class ConversionError extends Error {
  readonly _tag = 'ConversionError';
}

export function confluenceToMarkdownEffect(storageFormat: string): Effect.Effect<string, ConversionError> {
  return Effect.try({
    try: () => confluenceToMarkdown(storageFormat),
    catch: (e: unknown) => new ConversionError(`Failed to convert Confluence storage format to Markdown: ${e}`),
  });
}

// Convert Confluence storage format (XML/HTML) to plain text
export function confluenceToText(storageFormat: string): string {
  if (!storageFormat) return '';

  let text = storageFormat;

  // Remove CDATA sections
  text = text.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');

  // Convert line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');

  // Convert lists
  text = text.replace(/<li>/gi, '• ');
  text = text.replace(/<\/li>/gi, '\n');

  // Convert code blocks
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:plain-text-body><!\[CDATA\[(.*?)\]\]><\/ac:plain-text-body>.*?<\/ac:structured-macro>/gs,
    '\n```\n$1\n```\n',
  );

  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)');

  // Convert tables to simple text
  text = text.replace(/<table[^>]*>/gi, '\n');
  text = text.replace(/<\/table>/gi, '\n');
  text = text.replace(/<tr[^>]*>/gi, '');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<t[hd][^>]*>/gi, '| ');
  text = text.replace(/<\/t[hd]>/gi, ' ');

  // Remove all other HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Convert HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");

  // Clean up excessive whitespace
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.trim();

  return text;
}

// Extract metadata from Confluence page for better search
export function extractPageMetadata(page: {
  metadata?: {
    labels?: {
      results?: Array<{ name: string }>;
    };
  };
  version?: {
    when?: string;
    by?: {
      displayName?: string;
    };
  };
}): {
  labels?: string[];
  lastModified?: Date;
  author?: string;
} {
  const metadata: {
    labels?: string[];
    lastModified?: Date;
    author?: string;
  } = {};

  if (page.metadata?.labels?.results) {
    metadata.labels = page.metadata.labels.results.map((l) => l.name);
  }

  if (page.version?.when) {
    metadata.lastModified = new Date(page.version.when);
  }

  if (page.version?.by?.displayName) {
    metadata.author = page.version.by.displayName;
  }

  return metadata;
}
