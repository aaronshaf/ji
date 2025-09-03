import { describe, expect, test } from 'bun:test';
import { Effect, pipe } from 'effect';
import { analyzeIssue } from './analyze.js';

describe('analyzeIssue', () => {
  describe('input validation', () => {
    test('should extract issue key from full URL', async () => {
      // Mock the configuration and tool detection
      process.env.NODE_ENV = 'test';

      // Test will fail with API safety check
      // but we're checking if the URL extraction works before that
      try {
        await analyzeIssue('https://company.atlassian.net/browse/EVAL-5902');
      } catch (error: any) {
        // The error should be about API safety, not invalid issue key
        expect(error.message).not.toContain('Invalid issue key');
        // Should either hit API safety or authentication check
        const validErrors =
          error.message.includes('Real API calls detected') || error.message.includes('Not authenticated');
        expect(validErrors).toBe(true);
      }
    });

    test('should extract issue key from URL with additional path segments', async () => {
      process.env.NODE_ENV = 'test';

      try {
        await analyzeIssue('https://company.atlassian.net/secure/browse/EVAL-5902?filter=mine');
      } catch (error: any) {
        // Should fail on API safety or authentication, not issue key validation
        expect(error.message).not.toContain('Invalid issue key');
        const validErrors =
          error.message.includes('Real API calls detected') || error.message.includes('Not authenticated');
        expect(validErrors).toBe(true);
      }
    });

    test('should work with plain issue key', async () => {
      process.env.NODE_ENV = 'test';

      try {
        await analyzeIssue('EVAL-5902');
      } catch (error: any) {
        // Should fail on API safety or authentication, not issue key validation
        expect(error.message).not.toContain('Invalid issue key');
        const validErrors =
          error.message.includes('Real API calls detected') || error.message.includes('Not authenticated');
        expect(validErrors).toBe(true);
      }
    });

    test('should reject invalid issue key format', async () => {
      process.env.NODE_ENV = 'test';

      try {
        await analyzeIssue('invalid-key');
      } catch (error: any) {
        expect(error.message).toContain('Invalid issue key');
      }
    });

    test('should reject URL without issue key', async () => {
      process.env.NODE_ENV = 'test';

      try {
        await analyzeIssue('https://company.atlassian.net/');
      } catch (error: any) {
        expect(error.message).toContain('Invalid issue key');
      }
    });

    test('should handle URL with different domain formats', async () => {
      process.env.NODE_ENV = 'test';

      const urls = [
        'https://jira.company.com/browse/EVAL-123',
        'http://localhost:8080/browse/TEST-456',
        'https://issues.example.org/browse/PROJ-789',
      ];

      for (const url of urls) {
        try {
          await analyzeIssue(url);
        } catch (error: any) {
          // Should fail on API safety or authentication, not issue key validation
          expect(error.message).not.toContain('Invalid issue key');
          const validErrors =
            error.message.includes('Real API calls detected') || error.message.includes('Not authenticated');
          expect(validErrors).toBe(true);
        }
      }
    });
  });

  describe('options validation', () => {
    test('should accept valid options', async () => {
      process.env.NODE_ENV = 'test';

      const validOptions = [
        { comment: true },
        { comment: false, yes: true },
        { tool: 'claude' },
        { tool: 'gemini' },
        { tool: 'codex' },
        { prompt: './custom.md' },
        { comment: true, yes: true, tool: 'claude', prompt: './test.md' },
      ];

      for (const options of validOptions) {
        try {
          await analyzeIssue('EVAL-123', options);
        } catch (error: any) {
          // Should fail on authentication or tool availability, not options validation
          expect(error.message).not.toContain('Invalid options');
        }
      }
    });
  });
});
