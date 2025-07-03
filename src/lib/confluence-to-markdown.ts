// Convert Confluence storage format to Markdown for better LLM consumption
export function confluenceToMarkdown(storageFormat: string): string {
  if (!storageFormat) return '';

  let text = storageFormat;

  // Remove CDATA sections
  text = text.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');

  // Convert headings
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  text = text.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  text = text.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  // Convert lists
  text = text.replace(/<ul[^>]*>/gi, '\n');
  text = text.replace(/<\/ul>/gi, '\n');
  text = text.replace(/<ol[^>]*>/gi, '\n');
  text = text.replace(/<\/ol>/gi, '\n');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

  // Convert code blocks
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:parameter[^>]*ac:name="language"[^>]*>([^<]*)<\/ac:parameter>.*?<ac:plain-text-body><!\[CDATA\[(.*?)\]\]><\/ac:plain-text-body>.*?<\/ac:structured-macro>/gs,
    '\n```$1\n$2\n```\n',
  );
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:plain-text-body><!\[CDATA\[(.*?)\]\]><\/ac:plain-text-body>.*?<\/ac:structured-macro>/gs,
    '\n```\n$1\n```\n',
  );

  // Convert inline code
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Convert strong/bold
  text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');

  // Convert emphasis/italic
  text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');

  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Convert tables to markdown tables
  text = convertTablesToMarkdown(text);

  // Convert line breaks and paragraphs
  text = text.replace(/<br\s*\/?>/gi, '  \n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<div[^>]*>/gi, '');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Convert HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&rsquo;/g, "'");
  text = text.replace(/&ldquo;/g, '"');
  text = text.replace(/&rdquo;/g, '"');

  // Clean up excessive whitespace
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.trim();

  return text;
}

function convertTablesToMarkdown(html: string): string {
  // Match each table
  const tableRegex = /<table[^>]*>(.*?)<\/table>/gis;

  return html.replace(tableRegex, (_match, tableContent) => {
    const rows: string[][] = [];

    // Extract rows
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
      const rowContent = rowMatch[1];
      const cells: string[] = [];

      // Extract cells (th or td)
      const cellRegex = /<t[hd][^>]*>(.*?)<\/t[hd]>/gis;
      let cellMatch: RegExpExecArray | null;

      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        // Clean cell content
        const cellText = cellMatch[1]
          .replace(/<[^>]+>/g, '') // Remove any remaining HTML
          .replace(/\n/g, ' ') // Replace newlines with spaces
          .trim();
        cells.push(cellText);
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return '';

    // Build markdown table
    let markdown = '\n\n';

    // Add header row
    if (rows.length > 0) {
      markdown += `| ${rows[0].join(' | ')} |\n`;
      markdown += `|${rows[0].map(() => '---').join('|')}|\n`;

      // Add data rows
      for (let i = 1; i < rows.length; i++) {
        // Ensure row has same number of cells as header
        while (rows[i].length < rows[0].length) {
          rows[i].push('');
        }
        markdown += `| ${rows[i].join(' | ')} |\n`;
      }
    }

    return `${markdown}\n`;
  });
}

// Export a function to extract team ownership information specifically
export function extractTeamOwnership(markdown: string): Record<string, string[]> {
  const teams: Record<string, string[]> = {};

  // Look for patterns like "Team Name | Features/Products"
  const lines = markdown.split('\n');
  let currentTeam = '';

  for (const line of lines) {
    // Match team headers (e.g., "## EVAL" or "### Evaluate")
    const teamMatch = line.match(/^#{1,3}\s+([\w\s]+?)(?:\s*\([\w\s]+\))?\s*$/);
    if (teamMatch) {
      currentTeam = teamMatch[1].trim();
      teams[currentTeam] = [];
      continue;
    }

    // Match feature lists after team names
    if (currentTeam && line.includes('|')) {
      const parts = line.split('|').map((p) => p.trim());
      // Look for feature lists in table cells
      for (const part of parts) {
        if (part && !part.includes('---') && part.length > 3) {
          // Split by commas to get individual features
          const features = part
            .split(',')
            .map((f) => f.trim())
            .filter((f) => f);
          teams[currentTeam].push(...features);
        }
      }
    }
  }

  return teams;
}
