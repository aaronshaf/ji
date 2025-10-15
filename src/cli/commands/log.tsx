/** @jsxImportSource react */
import chalk from 'chalk';
import { Effect, pipe } from 'effect';
import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useEffect, useState } from 'react';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';
import { formatSmartDate } from '../../lib/utils/date-formatter.js';
import { formatDescription } from '../formatters/issue.js';

// Define comment type
interface Comment {
  id: string;
  author: { displayName: string; emailAddress?: string };
  body: unknown;
  created: string;
  updated: string;
  jirareactions?: Array<{
    value: string;
    users: Array<{
      displayName: string;
    }>;
    count: number;
  }>;
}

// Map reaction values to emojis
const reactionEmojis: Record<string, string> = {
  thumbs_up: '👍',
  thumbs_down: '👎',
  heart: '❤️',
  thinking: '🤔',
  eyes: '👀',
  cry: '😢',
  laugh: '😂',
  surprised: '😮',
  sad: '😞',
  anger: '😠',
};

// Props for the main component
interface LogAppProps {
  issueKey: string;
  jiraClient: JiraClient;
  currentUserName: string;
  initialComments: Comment[];
}

// Comment display component
const CommentDisplay: React.FC<{ comment: Comment }> = ({ comment }) => {
  const formattedBody = formatDescription(comment.body);
  const bodyLines = formattedBody.split('\n');

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>- author:</Text> {comment.author.displayName}
      </Text>
      <Text>
        {'  '}
        <Text dimColor>time:</Text> <Text dimColor>{formatSmartDate(comment.created)}</Text>
      </Text>
      {comment.jirareactions && comment.jirareactions.length > 0 && (
        <Text>
          {'  '}
          <Text dimColor>reactions:</Text>{' '}
          {comment.jirareactions
            .map((reaction) => {
              const emoji = reactionEmojis[reaction.value] || reaction.value;
              const names = reaction.users.map((u) => u.displayName).join(', ');
              return `${emoji} ${names}`;
            })
            .join(' | ')}
        </Text>
      )}
      <Text>
        {'  '}
        <Text dimColor>comment:</Text> |
      </Text>
      {bodyLines.map((line, index) => (
        <Text key={`${comment.id}-line-${index}`}>
          {'    '}
          {line}
        </Text>
      ))}
    </Box>
  );
};

// Main Ink app component
const LogApp: React.FC<LogAppProps> = ({ issueKey, jiraClient, currentUserName, initialComments }) => {
  const { exit } = useApp();
  const [comments, setComments] = useState<Comment[]>(initialComments);
  const [inputValue, setInputValue] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExiting, setIsExiting] = useState(false);

  // Track if we're refreshing
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justPressedCtrlR, setJustPressedCtrlR] = useState(false);

  // Handle keyboard shortcuts
  useInput(async (input, key) => {
    if (key.ctrl && input === 'c') {
      setIsExiting(true);
      setTimeout(() => exit(), 50); // Small delay to allow UI update
    }

    if (key.ctrl && input === 'r') {
      setJustPressedCtrlR(true);
      setIsRefreshing(true);

      // Clear the 'r' that gets added
      setTimeout(() => {
        setInputValue((prev) => (prev.endsWith('r') ? prev.slice(0, -1) : prev));
        setJustPressedCtrlR(false);
      }, 0);

      try {
        const fetchedComments = await jiraClient.getComments(issueKey);
        setComments(fetchedComments);
        setError(null);
      } catch (_err) {
        setError('Failed to refresh comments');
      } finally {
        setIsRefreshing(false);
      }
    }
  });

  // Auto-refresh every 2 minutes
  useEffect(() => {
    const checkForNewComments = async () => {
      try {
        const fetchedComments = await jiraClient.getComments(issueKey);
        const currentCommentIds = new Set(comments.map((c) => c.id));
        const newComments = fetchedComments.filter((c: Comment) => !currentCommentIds.has(c.id));

        if (newComments.length > 0) {
          setComments((prev) => [...prev, ...newComments]);
        }
      } catch (_error) {
        // Silently ignore refresh errors
      }
    };

    const interval = setInterval(checkForNewComments, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [issueKey, jiraClient, comments]);

  // Handle input submission
  const handleSubmit = async (value: string) => {
    const trimmedValue = value.trim();

    // Check for exit command - only /exit should work
    if (trimmedValue.toLowerCase() === '/exit') {
      setIsExiting(true);
      setTimeout(() => exit(), 50); // Small delay to allow UI update
      return;
    }

    // Handle empty input
    if (trimmedValue === '') {
      return;
    }

    // Post the comment
    setIsPosting(true);
    setError(null);

    try {
      await jiraClient.addComment(issueKey, trimmedValue);

      // Add the newly posted comment
      const newComment: Comment = {
        id: `local-${Date.now()}`,
        author: { displayName: currentUserName },
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        body: trimmedValue,
      };

      setComments((prev) => [...prev, newComment]);
      setInputValue('');
    } catch (err) {
      setError(`Failed to post comment: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>issue:</Text> <Text bold>{issueKey}</Text>
      </Text>
      <Text dimColor>comments:</Text>

      {comments.length === 0 ? (
        <Text dimColor> # No comments yet</Text>
      ) : (
        <Box flexDirection="column">
          {comments.map((comment) => (
            <CommentDisplay key={comment.id} comment={comment} />
          ))}
        </Box>
      )}

      {error && !isExiting && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {!isExiting && (
        <Box marginTop={1} borderStyle="round" borderColor="gray" paddingLeft={1} paddingRight={1}>
          <Box>
            <Text dimColor>
              {isPosting || isRefreshing ? (isPosting ? 'Posting comment... ' : 'Refreshing... ') : '> '}
            </Text>
            {!isPosting && !isRefreshing && (
              <TextInput
                value={inputValue}
                onChange={(newValue) => {
                  // Don't update if we just pressed Ctrl+R and the only change is adding 'r'
                  if (justPressedCtrlR && newValue === `${inputValue}r`) {
                    return;
                  }
                  setInputValue(newValue);
                }}
                onSubmit={handleSubmit}
                placeholder="Type /exit or Ctrl+C to quit, Ctrl+R to refresh"
              />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};

// Effect wrapper for getting configuration
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji setup" first.');
        }
        return { config, configManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Effect wrapper for getting comments
const getCommentsEffect = (jiraClient: JiraClient, issueKey: string) =>
  Effect.tryPromise({
    try: () => jiraClient.getComments(issueKey),
    catch: (error) => {
      if (error instanceof Error) {
        if (error.message.includes('404')) {
          return new Error(`Issue ${issueKey} not found`);
        }
        if (error.message.includes('401')) {
          return new Error('Authentication failed. Please run "ji setup" again.');
        }
        return error;
      }
      return new Error('Failed to fetch comments');
    },
  });

// Main effect for showing issue log
const showIssueLogEffect = (issueKey: string) =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) => {
      const jiraClient = new JiraClient(config);

      return pipe(
        getCommentsEffect(jiraClient, issueKey),
        Effect.flatMap((comments) =>
          pipe(
            // Get current user for displaying their name on new comments
            Effect.tryPromise({
              try: async () => {
                const currentUser = await jiraClient.getCurrentUser();
                return currentUser.displayName;
              },
              catch: () => 'You', // Fallback if we can't get current user
            }),
            Effect.tap((currentUserName) =>
              Effect.sync(() => {
                // Render the Ink app
                render(
                  <LogApp
                    issueKey={issueKey}
                    jiraClient={jiraClient}
                    currentUserName={currentUserName}
                    initialComments={comments}
                  />,
                );
              }),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          pipe(
            Effect.sync(() => {
              console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
              configManager.close();
            }),
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }),
  );

export async function showIssueLog(issueKey: string) {
  try {
    await Effect.runPromise(showIssueLogEffect(issueKey));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
