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
  text = text.replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:plain-text-body><!\[CDATA\[(.*?)\]\]><\/ac:plain-text-body>.*?<\/ac:structured-macro>/gs, '\n```\n$1\n```\n');

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
export function extractPageMetadata(page: any): {
  labels?: string[];
  lastModified?: Date;
  author?: string;
} {
  const metadata: any = {};

  if (page.metadata?.labels?.results) {
    metadata.labels = page.metadata.labels.results.map((l: any) => l.name);
  }

  if (page.version?.when) {
    metadata.lastModified = new Date(page.version.when);
  }

  if (page.version?.by?.displayName) {
    metadata.author = page.version.by.displayName;
  }

  return metadata;
}