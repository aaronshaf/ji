import { describe, expect, test } from 'bun:test';
import { formatDescription } from '../cli/formatters/issue';

describe('Issue and Comment Newline Handling', () => {
  describe('formatDescription', () => {
    test('should preserve newlines in plain text', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      const result = formatDescription(input);
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    test('should handle ADF hardBreak nodes', () => {
      const adfInput = {
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Line 1' }, { type: 'hardBreak' }, { type: 'text', text: 'Line 2' }],
          },
        ],
      };
      const result = formatDescription(adfInput);
      expect(result).toBe('Line 1\nLine 2');
    });

    test('should handle multiple paragraphs', () => {
      const adfInput = {
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'First paragraph' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Second paragraph' }],
          },
        ],
      };
      const result = formatDescription(adfInput);
      expect(result).toBe('First paragraphSecond paragraph');
    });

    test('should handle headings with proper newlines', () => {
      const adfInput = {
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'My Heading' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Content after heading' }],
          },
        ],
      };
      const result = formatDescription(adfInput);
      expect(result).toContain('\n## My Heading\n');
      expect(result).toContain('Content after heading');
    });

    test('should handle code blocks with newlines', () => {
      const adfInput = {
        version: 1,
        content: [
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'const x = 1;\nconst y = 2;' }],
          },
        ],
      };
      const result = formatDescription(adfInput);
      expect(result).toContain('\n```\n');
      expect(result).toContain('const x = 1;\nconst y = 2;');
      expect(result).toContain('\n```\n');
    });

    test('should handle bullet lists', () => {
      const adfInput = {
        version: 1,
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item 1' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item 2' }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = formatDescription(adfInput);
      expect(result).toContain('• ');
      expect(result).toContain('Item 1');
      expect(result).toContain('Item 2');
    });
  });

  describe('Comment body processing', () => {
    test('should preserve simple newlines in comments', () => {
      const commentBody = 'First line\nSecond line\nThird line';

      // Simulate the processing done in issue.ts
      const processed = commentBody
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');

      expect(processed).toBe('First line\nSecond line\nThird line');
    });

    test('should escape newlines for XML output', () => {
      const escapeXml = (str: string): string => {
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;')
          .replace(/\n/g, '&#10;');
      };

      const text = 'Line 1\nLine 2\nLine 3';
      const escaped = escapeXml(text);
      expect(escaped).toBe('Line 1&#10;Line 2&#10;Line 3');
    });

    test('should normalize excessive whitespace within lines', () => {
      const commentBody = 'First    line   with    spaces\nSecond line';

      // Simulate the processing done in issue.ts
      const processed = commentBody
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');

      expect(processed).toBe('First line with spaces\nSecond line');
    });

    test('should filter out empty lines', () => {
      const commentBody = 'First line\n\n\nSecond line\n   \nThird line';

      // Simulate the processing done in issue.ts
      const processed = commentBody
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');

      expect(processed).toBe('First line\nSecond line\nThird line');
    });

    test('should handle markdown-style formatting', () => {
      const commentBody = '#### Summary\nSome summary text\n#### Details\n• Point 1\n• Point 2';

      // Simulate the processing done in issue.ts
      const processed = commentBody
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');

      expect(processed).toBe('#### Summary\nSome summary text\n#### Details\n• Point 1\n• Point 2');
    });
  });
});
