import { Effect, Option, pipe } from 'effect';
import { type ParseError, ValidationError } from './errors';

/**
 * Effect-based text transformation functions
 * These demonstrate pure functions with validation and error handling
 */

/**
 * Convert Confluence storage format to markdown with validation
 */
export const confluenceToMarkdown = (storageFormat: string): Effect.Effect<string, ValidationError> => {
  return pipe(
    Effect.sync(() => {
      if (!storageFormat || storageFormat.trim().length === 0) {
        throw new ValidationError('Storage format cannot be empty');
      }

      if (storageFormat.length > 1_000_000) {
        // 1MB limit
        throw new ValidationError('Content too large (max 1MB)');
      }

      let processed = storageFormat;

      // Headers
      processed = processed.replace(
        /<h([1-6])>(.*?)<\/h\1>/gi,
        (_, level, content) => `${'#'.repeat(parseInt(level))} ${content}\n\n`,
      );

      // Links
      processed = processed.replace(/<ac:link[^>]*>.*?<ri:page[^>]*title="([^"]*)"[^>]*\/>.*?<\/ac:link>/gi, '[$1]');

      // Code blocks
      processed = processed.replace(
        /<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>.*?<\/ac:structured-macro>/gi,
        '```\n$1\n```',
      );

      // Basic HTML tags
      processed = processed.replace(/<p>/gi, '\n');
      processed = processed.replace(/<\/p>/gi, '\n');
      processed = processed.replace(/<br\s*\/?>/gi, '\n');
      processed = processed.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');
      processed = processed.replace(/<em>(.*?)<\/em>/gi, '*$1*');

      // Clean up
      processed = processed.replace(/<[^>]+>/g, ''); // Remove remaining HTML
      processed = processed.replace(/\n{3,}/g, '\n\n'); // Multiple newlines

      return processed.trim();
    }),
    Effect.mapError((error: unknown) =>
      error instanceof ValidationError
        ? error
        : new ValidationError('Failed to convert to markdown', undefined, undefined, error),
    ),
  );
};

/**
 * Extract team ownership from markdown content
 */
export const extractTeamOwnership = (
  markdown: string,
): Effect.Effect<Option.Option<{ team: string; owner: string }>, ParseError> => {
  return Effect.sync(() => {
    if (!markdown) {
      return Option.none();
    }

    // Look for team section
    const teamMatch = markdown.match(/#{1,3}\s*Team\s*\n+([^\n#]+)/i);
    const team = teamMatch?.[1]?.trim();

    // Look for owner patterns
    const ownerPatterns = [
      /#{1,3}\s*(?:Tech Lead|Owner|Lead)\s*\n+([^\n#]+)/i,
      /\*\*(?:Tech Lead|Owner|Lead)\*\*:?\s*([^\n]+)/i,
      /(?:Tech Lead|Owner|Lead):\s*([^\n]+)/i,
    ];

    let owner: string | undefined;
    for (const pattern of ownerPatterns) {
      const match = markdown.match(pattern);
      if (match?.[1]) {
        owner = match[1].trim();
        break;
      }
    }

    if (team && owner) {
      return Option.some({ team, owner });
    }

    return Option.none();
  });
};

/**
 * Normalize text for comparison
 */
export const normalizeText = (
  text: string,
  options: {
    lowercase?: boolean;
    removeSpecialChars?: boolean;
    collapseWhitespace?: boolean;
    maxLength?: number;
  } = {},
): Effect.Effect<string, ValidationError> => {
  const defaults = {
    lowercase: true,
    removeSpecialChars: true,
    collapseWhitespace: true,
    maxLength: 1000,
  };

  const opts = { ...defaults, ...options };

  return pipe(
    Effect.sync(() => {
      if (!text) {
        throw new ValidationError('Text cannot be empty');
      }

      let normalized = text;

      if (opts.lowercase) {
        normalized = normalized.toLowerCase();
      }

      if (opts.removeSpecialChars) {
        normalized = normalized.replace(/[^a-zA-Z0-9\s]/g, ' ');
      }

      if (opts.collapseWhitespace) {
        normalized = normalized.replace(/\s+/g, ' ').trim();
      }

      if (opts.maxLength && normalized.length > opts.maxLength) {
        normalized = normalized.substring(0, opts.maxLength);
      }

      if (normalized.length === 0) {
        throw new ValidationError('Text became empty after normalization');
      }

      return normalized;
    }),
  );
};

/**
 * Extract code blocks from markdown
 */
export const extractCodeBlocks = (
  markdown: string,
): Effect.Effect<Array<{ language: string; code: string }>, never> => {
  return Effect.sync(() => {
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    const blocks: Array<{ language: string; code: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(markdown)) !== null) {
      blocks.push({
        language: match[1] || 'plaintext',
        code: match[2].trim(),
      });
    }

    return blocks;
  });
};
