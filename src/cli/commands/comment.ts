import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun';
import chalk from 'chalk';
import { Effect, pipe, Schema } from 'effect';

import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

// Schema for validating issue key format
const IssueKeySchema = Schema.String.pipe(
  Schema.pattern(/^[A-Z]+-\d+$/),
  Schema.annotations({
    message: () => 'Invalid issue key format. Expected format: PROJECT-123',
  }),
);

// Schema for non-empty comment
const CommentSchema = Schema.transform(Schema.String, Schema.String.pipe(Schema.minLength(1)), {
  decode: (s) => {
    const trimmed = s.trim();
    if (trimmed.length === 0) {
      throw new Error('Comment cannot be empty');
    }
    return trimmed;
  },
  encode: (s) => s,
});

// Get configuration
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        return { config, configManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Open editor for comment
const openEditorEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const editor = process.env.EDITOR || 'vi';
      const tmpFile = join(tmpdir(), `ji-comment-${Date.now()}.md`);

      // Create temp file with template
      await Bun.write(tmpFile, '# Enter your comment below (lines starting with # will be ignored)\n\n');

      // Open editor
      const proc = spawn([editor, tmpFile], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });

      await proc.exited;

      // Read content
      const content = await Bun.file(tmpFile).text();

      // Clean up
      await unlink(tmpFile);

      // Remove comment lines and trim
      const comment = content
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .trim();

      if (!comment) {
        throw new Error('Comment was empty');
      }

      return comment;
    },
    catch: (error) => new Error(`Failed to get comment from editor: ${error}`),
  });

// Read from stdin
const readStdinEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const decoder = new TextDecoder();
      const chunks: Uint8Array[] = [];

      for await (const chunk of Bun.stdin.stream()) {
        chunks.push(chunk);
      }

      const buffer = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }

      return decoder.decode(buffer).trim();
    },
    catch: (error) => new Error(`Failed to read from stdin: ${error}`),
  });

// Check if stdin is piped
const isStdinPiped = () => {
  // In Bun, check if stdin is a TTY
  return !process.stdin.isTTY;
};

// Add comment to issue
const addCommentEffect = (issueKey: string, comment: string) =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) => {
      const jiraClient = new JiraClient(config);

      return pipe(
        // Use the Effect-based method
        jiraClient.addCommentEffect(issueKey, comment),
        Effect.tap(() =>
          Effect.sync(() => {
            console.log(chalk.green(`✓ Comment added to ${issueKey}`));

            // Show comment preview
            const lines = comment.split('\n');
            const preview = lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n${chalk.dim('...')}` : comment;

            console.log(chalk.dim('\nComment:'));
            console.log(
              chalk.gray(
                preview
                  .split('\n')
                  .map((line) => `  ${line}`)
                  .join('\n'),
              ),
            );
          }),
        ),
        // Comment added successfully - no local cache update needed
        Effect.tap(() => Effect.sync(() => configManager.close())),
      );
    }),
    Effect.catchAll((error) =>
      pipe(
        Effect.sync(() => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(chalk.red('Error:'), message);
        }),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

// Main comment function
const commentEffect = (issueKey: string, inlineComment?: string) =>
  pipe(
    // Validate issue key
    Schema.decodeUnknown(IssueKeySchema)(issueKey),
    Effect.mapError((error) => new Error(`Invalid issue key: ${error}`)),
    Effect.flatMap((_validIssueKey) =>
      pipe(
        // Determine comment source
        (() => {
          if (inlineComment) {
            // Mode 1: Inline comment provided
            return Effect.succeed(inlineComment);
          } else if (isStdinPiped()) {
            // Mode 3: Comment from pipe
            return readStdinEffect();
          } else {
            // Mode 2: Open editor
            return openEditorEffect();
          }
        })(),
        // Validate comment
        Effect.flatMap((comment) =>
          pipe(
            Schema.decodeUnknown(CommentSchema)(comment),
            Effect.mapError((error) => new Error(`Invalid comment: ${error}`)),
          ),
        ),
        Effect.flatMap((validComment) => addCommentEffect(issueKey, validComment)),
      ),
    ),
  );

export async function addComment(issueKey: string, inlineComment?: string) {
  try {
    await Effect.runPromise(commentEffect(issueKey, inlineComment));
  } catch (_error) {
    process.exit(1);
  }
}
