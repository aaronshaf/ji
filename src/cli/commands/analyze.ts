import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import { Console, Effect, pipe, Schema } from 'effect';
import { type Config, ConfigManager } from '../../lib/config.js';
import { type Issue, JiraClient } from '../../lib/jira-client.js';
import { formatDescription } from '../formatters/issue.js';
import { createAIClient, type AIProvider, type AIToolError } from '../../lib/ai-tools/index.ts';

// ============= Schemas =============
const IssueKeySchema = Schema.String.pipe(
  Schema.pattern(/^[A-Z]+-\d+$/, {
    message: () => 'Issue key must be in format PROJECT-123',
  }),
);

const AnalyzeOptionsSchema = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  tool: Schema.optional(
    Schema.Union(
      Schema.Literal('claude'),
      Schema.Literal('gemini'),
      Schema.Literal('codex'),
      Schema.Literal('opencode'),
    ),
  ),
  comment: Schema.optional(Schema.Boolean),
  yes: Schema.optional(Schema.Boolean),
});

// ============= Error Types =============
export class AnalysisError extends Error {
  readonly _tag = 'AnalysisError';
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class ToolNotFoundError extends Error {
  readonly _tag = 'ToolNotFoundError';
  constructor(
    message: string,
    public readonly tools?: string[],
  ) {
    super(message);
  }
}

export class ResponseExtractionError extends Error {
  readonly _tag = 'ResponseExtractionError';
  constructor(
    message: string,
    public readonly output?: string,
  ) {
    super(message);
  }
}

export class ConfigurationError extends Error {
  readonly _tag = 'ConfigurationError';
}

export class JiraApiError extends Error {
  readonly _tag = 'JiraApiError';
  constructor(
    message: string,
    public readonly issueKey?: string,
  ) {
    super(message);
  }
}

// Type for all errors
type AnalyzeError =
  | AnalysisError
  | ToolNotFoundError
  | ResponseExtractionError
  | ConfigurationError
  | JiraApiError
  | AIToolError;

// ============= AI Tool Management =============
const getAvailableProvider = (): Effect.Effect<AIProvider, ToolNotFoundError> =>
  pipe(
    Effect.sync(() => createAIClient()),
    Effect.flatMap((client) => client.getAvailableProviders()),
    Effect.flatMap((providers) => {
      if (providers.length === 0) {
        return Effect.fail(
          new ToolNotFoundError('No AI tools found. Please install claude, gemini, codex, or opencode.', [
            'claude',
            'gemini',
            'codex',
            'opencode',
          ]),
        );
      }
      // Prefer Claude first, then others
      if (providers.includes('claude')) return Effect.succeed('claude' as AIProvider);
      return Effect.succeed(providers[0]);
    }),
  );

// ============= Configuration =============
const getConfiguration = Effect.gen(function* () {
  const configManager = new ConfigManager();
  try {
    const config = yield* Effect.tryPromise({
      try: () => configManager.getConfig(),
      catch: () => new ConfigurationError('Failed to load configuration'),
    });

    if (!config) {
      return yield* Effect.fail(new ConfigurationError('Not authenticated. Please run "ji setup" first.'));
    }

    return config;
  } finally {
    configManager.close();
  }
});

// ============= Issue Fetching =============
const fetchIssue = (
  issueKey: string,
): Effect.Effect<{ issue: Issue; config: Config }, JiraApiError | ConfigurationError> =>
  pipe(
    getConfiguration,
    Effect.flatMap((config) =>
      Effect.gen(function* () {
        const jiraClient = new JiraClient(config);

        const issue = yield* Effect.tryPromise({
          try: async () => (await jiraClient.getIssue(issueKey)) as Issue,
          catch: (error) =>
            new JiraApiError(
              `Failed to fetch issue ${issueKey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              issueKey,
            ),
        });

        return { issue, config };
      }),
    ),
  );

// ============= XML Formatting =============
const formatIssueAsXml = (issue: Issue, jiraUrl: string): Effect.Effect<string, never> =>
  Effect.sync(() => {
    let xml = '<issue>\n';
    xml += `  <key>${issue.key}</key>\n`;
    xml += `  <summary>${escapeXml(issue.fields.summary)}</summary>\n`;
    xml += `  <status>${issue.fields.status.name}</status>\n`;
    xml += `  <priority>${issue.fields.priority?.name || 'None'}</priority>\n`;

    // Handle issue type safely
    const issueType = issue.fields.issuetype;
    if (issueType && typeof issueType === 'object' && 'name' in issueType) {
      xml += `  <type>${issueType.name}</type>\n`;
    }

    xml += `  <assignee>${issue.fields.assignee?.displayName || 'Unassigned'}</assignee>\n`;
    xml += `  <reporter>${issue.fields.reporter?.displayName || 'Unknown'}</reporter>\n`;
    xml += `  <created>${issue.fields.created}</created>\n`;
    xml += `  <updated>${issue.fields.updated}</updated>\n`;
    xml += `  <link>${jiraUrl}/browse/${issue.key}</link>\n`;

    // Handle epic/parent safely
    if (issue.fields.parent && typeof issue.fields.parent === 'object' && 'key' in issue.fields.parent) {
      xml += '  <epic>\n';
      xml += `    <key>${issue.fields.parent.key}</key>\n`;
      if (
        'fields' in issue.fields.parent &&
        issue.fields.parent.fields &&
        typeof issue.fields.parent.fields === 'object' &&
        'summary' in issue.fields.parent.fields
      ) {
        xml += `    <summary>${escapeXml(String(issue.fields.parent.fields.summary))}</summary>\n`;
      }
      xml += '  </epic>\n';
    }

    // Add description
    if (issue.fields.description) {
      const formattedDescription = formatDescription(issue.fields.description);
      xml += '  <description>\n';
      xml += `    ${escapeXml(formattedDescription)}\n`;
      xml += '  </description>\n';
    }

    // Add acceptance criteria if present
    const acceptanceCriteria = issue.fields.customfield_10035 || issue.fields.customfield_10014;
    if (acceptanceCriteria) {
      const formattedCriteria = formatDescription(acceptanceCriteria);
      xml += '  <acceptance_criteria>\n';
      xml += `    ${escapeXml(formattedCriteria)}\n`;
      xml += '  </acceptance_criteria>\n';
    }

    xml += '</issue>';
    return xml;
  });

// Helper function to escape XML special characters
const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// ============= Comments Fetching =============
const fetchComments = (issueKey: string, jiraClient: JiraClient): Effect.Effect<string, JiraApiError> =>
  Effect.tryPromise({
    try: async () => {
      const comments = await jiraClient.getComments(issueKey);
      if (comments.length === 0) return '';

      let xml = '  <comments>\n';
      for (const comment of comments) {
        const formattedBody = formatDescription(comment.body);
        xml += '    <comment>\n';
        xml += `      <author>${escapeXml(comment.author.displayName)}</author>\n`;
        xml += `      <created>${comment.created}</created>\n`;
        xml += `      <body>${escapeXml(formattedBody)}</body>\n`;
        xml += '    </comment>\n';
      }
      xml += '  </comments>\n';
      return xml;
    },
    catch: (error) =>
      new JiraApiError(
        `Failed to fetch comments: ${error instanceof Error ? error.message : 'Unknown error'}`,
        issueKey,
      ),
  });

// Helper to expand tilde in file paths
const expandTilde = (path: string): string => {
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
};

// ============= Prompt Loading =============
const loadPrompt = (promptPath?: string): Effect.Effect<string, ConfigurationError | null> =>
  Effect.gen(function* () {
    // Try custom prompt path first
    if (promptPath) {
      const expandedPath = expandTilde(promptPath);
      if (!existsSync(expandedPath)) {
        return yield* Effect.fail(new ConfigurationError(`Prompt file not found: ${promptPath}`));
      }
      return yield* Effect.try({
        try: () => readFileSync(expandedPath, 'utf-8'),
        catch: (error) => new ConfigurationError(`Failed to read prompt file: ${error}`),
      });
    }

    // Check config for default prompt (removed analysisPrompt support)
    yield* Effect.tryPromise<Config | null, null>({
      try: async () => {
        const configManager = new ConfigManager();
        try {
          return await configManager.getConfig();
        } finally {
          configManager.close();
        }
      },
      catch: () => null,
    });

    // Use default prompt
    const defaultPromptPath = join(import.meta.dir, '../../assets/default-analysis-prompt.md');
    if (existsSync(defaultPromptPath)) {
      return yield* Effect.try({
        try: () => readFileSync(defaultPromptPath, 'utf-8'),
        catch: (error) => new ConfigurationError(`Failed to read default prompt: ${error}`),
      });
    }

    // Fallback inline prompt
    return `# Jira Issue Analysis

Please analyze the following Jira issue and provide actionable recommendations for resolution.

Consider the following aspects in your analysis:
- Current status and blockers
- Technical approach and implementation suggestions
- Potential risks or dependencies
- Time estimation if applicable
- Next steps for the assignee

Focus on providing practical, specific guidance that will help move this issue forward.`;
  });

// ============= AI Tool Execution =============
const executeAnalysis = (provider: AIProvider, input: string): Effect.Effect<string, AnalysisError | AIToolError> =>
  pipe(
    Effect.sync(() => createAIClient()),
    Effect.flatMap((client) =>
      client.execute(input, {
        provider,
        maxTurns: 1,
        systemPrompt: `You are an expert Jira issue analyst. Analyze the provided issue data and provide actionable recommendations.

CRITICAL FORMATTING REQUIREMENT:
Your ENTIRE response must be wrapped in opening <ji-response> and closing </ji-response> tags EXACTLY like this:

<ji-response>
Your analysis goes here...
</ji-response>

REQUIREMENTS:
- Use lowercase "ji-response" (not JI-Response, JI-RESPONSE, or ji-response with attributes)
- Include BOTH opening <ji-response> and closing </ji-response> tags
- Put ALL content between the tags
- Do NOT include any text before <ji-response> or after </ji-response>
- The tags must be on their own lines`,
      }),
    ),
    Effect.map((response) => response.content),
    Effect.mapError((error) => {
      if (error._tag === 'AIProviderError' || error._tag === 'SDKError' || error._tag === 'ProcessExecutionError') {
        return new AnalysisError(`AI tool execution failed: ${error.message}`, error);
      }
      return new AnalysisError(`Analysis failed: ${String(error)}`, error);
    }),
  );

// ============= Response Extraction =============
const extractResponse = (output: string): Effect.Effect<string, ResponseExtractionError> =>
  Effect.gen(function* () {
    // Try multiple regex patterns for flexibility
    const patterns = [
      /<ji-response>([\s\S]*?)<\/ji-response>/i, // Standard case-insensitive
      /<ji-response[^>]*>([\s\S]*?)<\/ji-response>/i, // With attributes
      /<JI-Response>([\s\S]*?)<\/JI-Response>/, // Title case
      /<JI-RESPONSE>([\s\S]*?)<\/JI-RESPONSE>/, // All caps
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match?.[1]) {
        const response = match[1].trim();
        if (response) {
          return response;
        }
        // Empty response tags
        return yield* Effect.fail(new ResponseExtractionError('Empty response in tags', output));
      }
    }

    // Check for partial matches - closing tag without opening tag
    const hasClosingTag = /<\/ji-response>/i.test(output);
    if (hasClosingTag) {
      // Try to extract content before the closing tag, but skip common prefixes
      const lines = output.trim().split('\n');
      const closingTagIndex = lines.findIndex((line) => /<\/ji-response>/i.test(line));

      if (closingTagIndex > 0) {
        // Extract everything before the closing tag, skipping metadata lines
        const contentLines = lines.slice(0, closingTagIndex);
        const filteredLines = contentLines.filter((line) => {
          const trimmed = line.trim();
          // Skip common metadata patterns
          return (
            !trimmed.startsWith('Model:') &&
            !trimmed.startsWith('Usage:') &&
            !trimmed.startsWith('Tokens:') &&
            !trimmed.startsWith('Cost:') &&
            trimmed.length > 0
          );
        });

        if (filteredLines.length > 0) {
          const extractedContent = filteredLines.join('\n').trim();
          if (extractedContent) {
            if (process.env.DEBUG) {
              console.log('DEBUG: Extracted content from output with missing opening tag');
            }
            return extractedContent;
          }
        }
      }
    }

    // Debug: Let's see if we can find any ji-response tags at all
    const hasAnyResponseTag = /<\/?ji-response[^>]*>/i.test(output);
    if (hasAnyResponseTag && process.env.DEBUG) {
      console.log('DEBUG: Found ji-response tags in output, but regex failed to match content');
      console.log('DEBUG: All ji-response tag occurrences:', output.match(/<\/?ji-response[^>]*>/gi));
    }

    // No response tags found - provide detailed debugging info
    const trimmed = output.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(new ResponseExtractionError('No output received from analysis tool', output));
    }

    // Build detailed error message with debugging info
    const lines = trimmed.split('\n');
    const totalLines = lines.length;
    const outputLength = trimmed.length;

    // Find where ji-response tags appear in the text
    const openTagLine = lines.findIndex((line) => /<ji-response[^>]*>/i.test(line));
    const closeTagLine = lines.findIndex((line) => /<\/ji-response>/i.test(line));

    let debugInfo = `Tool output does not contain <ji-response> tags. The analysis tool must wrap its response in <ji-response> tags.

Debugging Information:
- Output length: ${outputLength} characters
- Total lines: ${totalLines}`;

    // Show context around where tags appear or should appear
    if (openTagLine >= 0) {
      const contextStart = Math.max(0, openTagLine - 2);
      const contextEnd = Math.min(lines.length, openTagLine + 3);
      debugInfo += `
- Opening tag found at line ${openTagLine + 1}, context:
${lines.slice(contextStart, contextEnd).join('\n')}`;
    } else {
      debugInfo += `
- First 5 lines:
${lines.slice(0, 5).join('\n')}`;
    }

    if (closeTagLine >= 0 && closeTagLine !== openTagLine) {
      const contextStart = Math.max(0, closeTagLine - 2);
      const contextEnd = Math.min(lines.length, closeTagLine + 3);
      debugInfo += `
- Closing tag found at line ${closeTagLine + 1}, context:
${lines.slice(contextStart, contextEnd).join('\n')}`;
    } else if (lines.length > 5) {
      debugInfo += `
- Last 3 lines:
${lines.slice(-3).join('\n')}`;
    }

    // Check for common issues with more detailed analysis
    const hasResponseWord = trimmed.toLowerCase().includes('ji-response');

    // Check for various tag formats
    const checks = {
      standardOpen: trimmed.includes('<ji-response>'),
      standardClose: trimmed.includes('</ji-response>'),
      titleCaseOpen: trimmed.includes('<JI-Response>'),
      titleCaseClose: trimmed.includes('</JI-Response>'),
      upperCaseOpen: trimmed.includes('<JI-RESPONSE>'),
      upperCaseClose: trimmed.includes('</JI-RESPONSE>'),
      hasAttributes: /<ji-response[^>]+>/i.test(trimmed),
    };

    // Build specific feedback
    if (hasResponseWord) {
      debugInfo += '\n- Contains word "ji-response" but no properly matched tags';
    }

    // Check for tag mismatches
    const anyOpen = checks.standardOpen || checks.titleCaseOpen || checks.upperCaseOpen || checks.hasAttributes;
    const anyClose = checks.standardClose || checks.titleCaseClose || checks.upperCaseClose;

    if (anyOpen && anyClose) {
      debugInfo += '\n- Found both opening and closing tags but they may not match properly';
      if (checks.hasAttributes) {
        debugInfo += '\n- Opening tag appears to have attributes (not supported)';
      }
      if (checks.titleCaseOpen || checks.titleCaseClose) {
        debugInfo += '\n- Found title case tags (JI-Response) - should be lowercase (ji-response)';
      }
      if (checks.upperCaseOpen || checks.upperCaseClose) {
        debugInfo += '\n- Found uppercase tags (JI-RESPONSE) - should be lowercase (ji-response)';
      }
    } else if (anyOpen && !anyClose) {
      debugInfo += '\n- Has opening ji-response tag but missing closing tag';
    } else if (!anyOpen && anyClose) {
      debugInfo += '\n- Has closing ji-response tag but missing opening tag';
    } else {
      debugInfo += '\n- Missing both opening and closing ji-response tags';
    }

    // Check if this looks like tool metadata only
    const metadataLines = lines.filter(
      (line) =>
        line.startsWith('Model:') ||
        line.startsWith('Usage:') ||
        line.startsWith('Tokens:') ||
        line.startsWith('Cost:') ||
        line.trim().length === 0,
    );

    if (metadataLines.length === lines.length) {
      debugInfo += '\n- Output appears to contain only tool metadata, no actual response content';
    }

    debugInfo += `\n\nTo see full output, run with: DEBUG=1 ji analyze ${process.argv[3] || 'ISSUE-KEY'} --comment`;

    return yield* Effect.fail(new ResponseExtractionError(debugInfo, output));
  });

// ============= Comment Posting =============
const postComment = (issueKey: string, comment: string): Effect.Effect<void, JiraApiError | ConfigurationError> =>
  pipe(
    getConfiguration,
    Effect.flatMap((config) =>
      Effect.tryPromise({
        try: async () => {
          const jiraClient = new JiraClient(config);
          await jiraClient.addComment(issueKey, comment);
        },
        catch: (error) =>
          new JiraApiError(
            `Failed to post comment: ${error instanceof Error ? error.message : 'Unknown error'}`,
            issueKey,
          ),
      }),
    ),
  );

// ============= User Interaction =============
const showAnalysis = (analysis: string): Effect.Effect<void, never> =>
  Effect.sync(() => {
    console.log(`\n${chalk.yellow('─'.repeat(60))}`);
    console.log(`${chalk.yellow('│')} Analysis:`);
    console.log(chalk.yellow('─'.repeat(60)));
    console.log(analysis);
    console.log(`${chalk.yellow('─'.repeat(60))}\n`);
  });

const confirmComment = Effect.gen(function* () {
  const rl = readline.createInterface({ input, output });

  const result = yield* Effect.tryPromise({
    try: async () => {
      const answer = await rl.question('Post this comment? [y/N]: ');
      return answer.toLowerCase() === 'y';
    },
    catch: (error) => new AnalysisError(`Failed to get user input: ${error}`),
  });

  yield* Effect.sync(() => rl.close());
  return result;
});

// ============= Main Analysis Pipeline =============
const analyzeIssueEffect = (
  issueKey: string,
  options: {
    prompt?: string;
    tool?: string;
    comment?: boolean;
    yes?: boolean;
  },
): Effect.Effect<void, AnalyzeError | null> =>
  Effect.gen(function* () {
    // Extract issue key from URL if provided
    let extractedKey = issueKey;
    const urlMatch = issueKey.match(/\/browse\/([A-Z]+-\d+)/);
    if (urlMatch?.[1]) {
      extractedKey = urlMatch[1];
    }

    // Validate issue key
    yield* Schema.decodeUnknown(IssueKeySchema)(extractedKey).pipe(
      Effect.mapError(() => new ConfigurationError(`Invalid issue key: ${extractedKey}`)),
    );

    // Validate options
    yield* Schema.decodeUnknown(AnalyzeOptionsSchema)(options).pipe(
      Effect.mapError((error) => new ConfigurationError(`Invalid options: ${error}`)),
    );

    // Get configuration
    const config = yield* getConfiguration;

    // Determine AI provider to use
    const provider: AIProvider = yield* (() => {
      if (options.tool) {
        // Validate the specified tool is available
        return pipe(
          Effect.sync(() => createAIClient()),
          Effect.flatMap((client) => client.checkProviderAvailability(options.tool as AIProvider)),
          Effect.flatMap((available) => {
            if (!available) {
              return Effect.fail(new ToolNotFoundError(`AI provider '${options.tool}' not available`));
            }
            return Effect.succeed(options.tool as AIProvider);
          }),
        );
      }
      if (config.analysisCommand) {
        // Map old commands to new providers
        const cmd = config.analysisCommand.toLowerCase();
        if (cmd.includes('claude')) return Effect.succeed('claude' as AIProvider);
        if (cmd.includes('gemini')) return Effect.succeed('gemini' as AIProvider);
        if (cmd.includes('opencode')) return Effect.succeed('opencode' as AIProvider);
        if (cmd.includes('codex')) return Effect.succeed('codex' as AIProvider);
      }
      return getAvailableProvider();
    })();

    // Load prompt
    const prompt = yield* loadPrompt(options.prompt);

    // Fetch and format issue
    const fetchResult = yield* fetchIssue(extractedKey);
    const issue = fetchResult.issue;
    const issueConfig = fetchResult.config;

    // Format issue as XML
    const issueXml = yield* formatIssueAsXml(issue, issueConfig.jiraUrl);

    // Fetch comments
    const jiraClient = new JiraClient(issueConfig);
    const commentsXml = yield* fetchComments(extractedKey, jiraClient).pipe(
      Effect.orElse(() => Effect.succeed('')), // Continue even if comments fail
    );

    // Build complete issue data
    const fullIssueXml = commentsXml ? issueXml.replace('</issue>', `${commentsXml}</issue>`) : issueXml;

    // Build input for AI analysis
    const fullInput = `${prompt}\n\n${fullIssueXml}`;

    // Run analysis using AI client
    const toolOutput = yield* executeAnalysis(provider, fullInput);

    // Extract response
    const response = yield* extractResponse(toolOutput);

    // For default output mode, just print the analysis directly
    if (!options.comment) {
      yield* Console.log(response);
      return;
    }

    // Show analysis with formatting for comment mode
    yield* showAnalysis(response);

    // Handle comment posting
    const shouldPost = options.yes
      ? true
      : yield* pipe(
          Console.log('Do you want to post this analysis as a comment to the Jira issue?'),
          Effect.flatMap(() => confirmComment),
        );

    if (shouldPost) {
      yield* Console.log('Posting comment...');
      yield* postComment(extractedKey, response);
      yield* Console.log(chalk.green('✓ Comment posted successfully'));
    } else {
      yield* Console.log(chalk.yellow('Comment not posted'));
    }
  });

// ============= Error Handling =============
const handleAnalyzeError = (error: AnalyzeError | null): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (!error) {
      yield* Console.error(chalk.red('An unknown error occurred'));
      return;
    }
    switch (error._tag) {
      case 'ToolNotFoundError':
        yield* Console.error(chalk.red(`Tool Error: ${error.message}`));
        if (error.tools) {
          yield* Console.error(chalk.dim(`Available tools: ${error.tools.join(', ')}`));
        }
        break;
      case 'ResponseExtractionError':
        yield* Console.error(chalk.red(`Response Error: ${error.message}`));
        if (error.output && process.env.DEBUG) {
          yield* Console.error(chalk.dim('\n=== Full Tool Output ==='));
          yield* Console.error(chalk.dim(error.output));
          yield* Console.error(chalk.dim('=== End Tool Output ===\n'));
        }
        break;
      case 'JiraApiError':
        yield* Console.error(chalk.red(`Jira API Error: ${error.message}`));
        if (error.issueKey) {
          yield* Console.error(chalk.dim(`Issue: ${error.issueKey}`));
        }
        break;
      case 'ConfigurationError':
        yield* Console.error(chalk.red(`Configuration Error: ${error.message}`));
        break;
      case 'AnalysisError':
        yield* Console.error(chalk.red(`Analysis Error: ${error.message}`));
        if (error.cause && process.env.DEBUG) {
          yield* Console.error(chalk.dim(`Cause: ${JSON.stringify(error.cause)}`));
        }
        break;
      case 'AIProviderError':
        yield* Console.error(chalk.red(`AI Provider Error: ${error.message}`));
        break;
      case 'SDKError':
        yield* Console.error(chalk.red(`SDK Error: ${error.message}`));
        break;
      case 'ProcessExecutionError':
        yield* Console.error(chalk.red(`Process Execution Error: ${error.message}`));
        break;
      case 'StreamingError':
        yield* Console.error(chalk.red(`Streaming Error: ${error.message}`));
        break;
      default:
        yield* Console.error(chalk.red(`Error: ${(error as Error).message || 'Unknown error'}`));
    }
  });

// ============= Public API =============
export async function analyzeIssue(
  issueKey: string,
  options: {
    prompt?: string;
    tool?: string;
    comment?: boolean;
    yes?: boolean;
  } = {},
): Promise<void> {
  await Effect.runPromise(
    pipe(
      analyzeIssueEffect(issueKey, options),
      Effect.catchAll((error) => {
        // In test mode, only re-throw validation errors for test assertions
        if (process.env.NODE_ENV === 'test' && error?._tag === 'ConfigurationError') {
          const message = error.message;
          if (message.includes('Invalid issue key') || message.includes('Invalid options')) {
            return Effect.fail(error);
          }
        }
        // Otherwise handle the error gracefully
        return handleAnalyzeError(error);
      }),
    ),
  );
}
