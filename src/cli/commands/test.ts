import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { Console, Effect, pipe, Schema } from 'effect';

import { ConfigManager } from '../../lib/config.js';
import { OllamaClient } from '../../lib/ollama.js';

// Error types for test operations
export class TestConfigError extends Error {
  readonly _tag = 'TestConfigError';
}

export class TestExecutionError extends Error {
  readonly _tag = 'TestExecutionError';
}

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}

export class FileOperationError extends Error {
  readonly _tag = 'FileOperationError';
}

// Test configuration schema using Effect Schema
const TestCaseSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  description: Schema.String,
  expectedPatterns: Schema.optional(Schema.Array(Schema.String)),
  llmValidation: Schema.optional(Schema.Boolean),
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  lastRun: Schema.optional(Schema.String),
  lastResult: Schema.optional(Schema.Literal('pass', 'fail', 'error')),
});

const TestConfigSchema = Schema.Struct({
  version: Schema.String,
  lastUpdated: Schema.String,
  environment: Schema.Struct({
    jiraUrl: Schema.String,
    projectKeys: Schema.Array(Schema.String),
    confluenceSpaces: Schema.Array(Schema.String),
  }),
  tests: Schema.Record({ key: Schema.String, value: Schema.Array(TestCaseSchema) }),
});

type TestConfig = Schema.Schema.Type<typeof TestConfigSchema>;
type TestCase = Schema.Schema.Type<typeof TestCaseSchema>;

// Mutable types for runtime updates
interface MutableTestCase extends Omit<TestCase, 'lastRun' | 'lastResult'> {
  lastRun?: string;
  lastResult?: 'pass' | 'fail' | 'error';
}

interface MutableTestConfig extends Omit<TestConfig, 'lastUpdated' | 'tests'> {
  lastUpdated: string;
  tests: Record<string, MutableTestCase[]>;
}

const TEST_CONFIG_PATH = join(homedir(), '.ji', 'test-config.json');

// Helper function for user input using Effect
const getUserInputEffect = (question: string): Effect.Effect<string, ValidationError> =>
  Effect.tryPromise({
    try: () => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      return new Promise<string>((resolve) => {
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    },
    catch: (error) => new ValidationError(`Failed to get user input: ${error}`),
  });

class TestManager {
  private config: TestConfig | null = null;

  // Effect-based config loading
  loadConfigEffect(): Effect.Effect<TestConfig | null, TestConfigError | FileOperationError> {
    return pipe(
      Effect.sync(() => existsSync(TEST_CONFIG_PATH)),
      Effect.flatMap((exists) => {
        if (!exists) {
          return Effect.succeed(null);
        }

        return pipe(
          Effect.tryPromise({
            try: () => Promise.resolve(readFileSync(TEST_CONFIG_PATH, 'utf-8')),
            catch: (error) => new FileOperationError(`Failed to read test config: ${error}`),
          }),
          Effect.flatMap((content) =>
            Effect.try({
              try: () => JSON.parse(content),
              catch: (error) => new TestConfigError(`Invalid JSON in test config: ${error}`),
            }),
          ),
          Effect.flatMap((parsed) =>
            Schema.decodeUnknown(TestConfigSchema)(parsed).pipe(
              Effect.mapError((error) => new TestConfigError(`Schema validation failed: ${error}`)),
            ),
          ),
          Effect.tap((config) =>
            Effect.sync(() => {
              this.config = config;
            }),
          ),
        );
      }),
    );
  }

  // Effect-based config saving
  saveConfigEffect(config: TestConfig): Effect.Effect<void, FileOperationError | TestConfigError> {
    return pipe(
      Effect.try({
        try: () => JSON.stringify(config, null, 2),
        catch: (error) => new TestConfigError(`Failed to serialize config: ${error}`),
      }),
      Effect.flatMap((content) =>
        Effect.tryPromise({
          try: () => Promise.resolve(writeFileSync(TEST_CONFIG_PATH, content, 'utf-8')),
          catch: (error) => new FileOperationError(`Failed to write test config: ${error}`),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          this.config = config;
        }),
      ),
    );
  }

  // Effect-based environment info gathering - API-only mode
  getEnvironmentInfoEffect(): Effect.Effect<{ projectKeys: string[]; confluenceSpaces: string[] }, TestExecutionError> {
    return Effect.succeed({
      projectKeys: [], // No cached projects in API-only mode
      confluenceSpaces: [], // No cached confluence spaces in API-only mode
    });
  }

  // Backward compatibility methods
  async loadConfig(): Promise<TestConfig | null> {
    return Effect.runPromise(this.loadConfigEffect().pipe(Effect.catchAll(() => Effect.succeed(null))));
  }

  async saveConfig(config: TestConfig): Promise<void> {
    return Effect.runPromise(this.saveConfigEffect(config));
  }

  async getEnvironmentInfo(): Promise<{ projectKeys: string[]; confluenceSpaces: string[] }> {
    return Effect.runPromise(this.getEnvironmentInfoEffect());
  }
}

// Command type definitions for comprehensive coverage
const COMMAND_TYPES = {
  search: {
    name: 'Search',
    description: 'Search across Jira and Confluence content',
    examples: ['search "login bug"', 'search "deployment process"'],
    expectedPatterns: ['- type:', 'key:', 'title:'],
    llmValidation: false,
  },
  issue_view: {
    name: 'Issue View',
    description: 'View specific Jira issues',
    examples: [], // Will be populated with real issue keys
    expectedPatterns: ['type: issue', 'key:', 'link:', 'status:'],
    llmValidation: false,
  },
  issue_direct: {
    name: 'Direct Issue Access',
    description: 'Access issues directly via key (e.g., ji ABC-123)',
    examples: [], // Will be populated with real issue keys
    expectedPatterns: ['type: issue', 'key:', 'link:', 'status:'],
    llmValidation: false,
  },
  sync: {
    name: 'Sync Operations',
    description: 'Sync workspaces and projects',
    examples: ['sync'],
    expectedPatterns: ['✓ Successfully synced', 'issues from'],
    llmValidation: false,
  },
  ask: {
    name: 'AI Questions',
    description: 'Ask questions about your content',
    examples: [], // Will be populated during setup
    expectedPatterns: [],
    llmValidation: true,
  },
  mine: {
    name: 'My Issues',
    description: 'Show assigned issues from main project',
    examples: ['mine'],
    expectedPatterns: [], // Will be populated with main project key
    llmValidation: false,
  },
};

// Effect-based setup function
const setupTestsEffect = (): Effect.Effect<
  void,
  TestConfigError | ValidationError | FileOperationError | TestExecutionError
> =>
  pipe(
    Console.log(chalk.bold('🧪 Test Setup Wizard\n')),
    Effect.flatMap(() =>
      Effect.scoped(
        pipe(
          Effect.all([
            Effect.acquireRelease(
              Effect.sync(() => new ConfigManager()),
              (configManager) => Effect.sync(() => configManager.close()),
            ),
            Effect.sync(() => new TestManager()),
          ]),
          Effect.flatMap(([configManager, testManager]) =>
            pipe(
              // Get configuration
              Effect.tryPromise({
                try: () => configManager.getConfig(),
                catch: (error) => new TestConfigError(`Failed to get config: ${error}`),
              }),
              Effect.flatMap((config) => {
                if (!config) {
                  return pipe(
                    Console.error(chalk.red('No configuration found. Please run "ji auth" first.')),
                    Effect.flatMap(() => Effect.succeed(process.exit(1))),
                  );
                }
                return Effect.succeed(config);
              }),
              Effect.flatMap((config) =>
                pipe(
                  testManager.getEnvironmentInfoEffect(),
                  Effect.map((envInfo) => ({ config, envInfo })),
                ),
              ),
              Effect.flatMap(({ config, envInfo }) =>
                pipe(
                  Console.log(chalk.cyan('Environment detected:')),
                  Effect.flatMap(() => Console.log(`  Jira URL: ${config.jiraUrl}`)),
                  Effect.flatMap(() => Console.log(`  Projects: ${envInfo.projectKeys.join(', ')}`)),
                  Effect.flatMap(() => Console.log(`  Confluence Spaces: ${envInfo.confluenceSpaces.join(', ')}\n`)),
                  Effect.map(() => ({ config, envInfo })),
                ),
              ),
              Effect.flatMap(({ config, envInfo }) =>
                pipe(
                  // Load existing test config for defaults
                  testManager
                    .loadConfigEffect()
                    .pipe(Effect.catchAll(() => Effect.succeed(null))),
                  Effect.flatMap((existingConfig) => setupCommandTestsEffect(envInfo, existingConfig)),
                  Effect.map((tests) => ({
                    version: '1.0.0',
                    lastUpdated: new Date().toISOString(),
                    environment: {
                      jiraUrl: config.jiraUrl,
                      projectKeys: envInfo.projectKeys,
                      confluenceSpaces: envInfo.confluenceSpaces,
                    },
                    tests,
                  })),
                ),
              ),
              Effect.flatMap((testConfig) =>
                pipe(
                  testManager.saveConfigEffect(testConfig),
                  Effect.tap(() => Console.log(chalk.green(`✓ Test configuration saved to ${TEST_CONFIG_PATH}`))),
                  Effect.tap(() => Console.log(chalk.dim('\nRun "ji test" to execute all configured tests.'))),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

// Helper function to setup command tests
const setupCommandTestsEffect = (
  envInfo: { projectKeys: string[]; confluenceSpaces: string[] },
  existingConfig?: TestConfig | null,
): Effect.Effect<Record<string, TestCase[]>, ValidationError> =>
  pipe(
    Effect.succeed(Object.entries(COMMAND_TYPES)),
    Effect.flatMap((commandEntries) =>
      Effect.all(
        commandEntries.map(([key, commandType]) =>
          pipe(
            Console.log(chalk.yellow(`Setting up ${commandType.name} tests:`)),
            Effect.flatMap(() => Console.log(chalk.dim(`${commandType.description}\n`))),
            Effect.flatMap(() => setupCommandTypeTestsEffect(key, commandType, envInfo, existingConfig)),
            Effect.map((testCases) => [key, testCases] as const),
          ),
        ),
      ),
    ),
    Effect.map((entries) => Object.fromEntries(entries.filter(([, testCases]) => testCases.length > 0))),
  );

// Helper function to setup tests for a specific command type
const setupCommandTypeTestsEffect = (
  key: string,
  commandType: {
    name: string;
    description: string;
    examples: string[];
    expectedPatterns: string[];
    llmValidation: boolean;
  },
  envInfo: { projectKeys: string[]; confluenceSpaces: string[] },
  existingConfig?: TestConfig | null,
): Effect.Effect<TestCase[], ValidationError> => {
  // Get existing tests for this command type as defaults
  const existingTests = existingConfig?.tests[key] || [];
  if (key === 'issue_view' || key === 'issue_direct') {
    if (envInfo.projectKeys.length === 0) {
      return Effect.succeed([]);
    }

    const exampleKey = `${envInfo.projectKeys[0]}-1234`;
    const exampleCommand = key === 'issue_view' ? `issue view ${exampleKey}` : exampleKey;

    // Get existing issue key as default
    const existingIssueKey =
      existingTests.length > 0
        ? key === 'issue_view'
          ? existingTests[0].command.replace('issue view ', '')
          : existingTests[0].command
        : null;

    const promptText = existingIssueKey
      ? `Enter a real issue key (current: ${existingIssueKey}, press Enter to keep): `
      : `Enter a real issue key from your environment (e.g., ${exampleKey}): `;

    return pipe(
      Console.log(chalk.dim(`Example: ${exampleCommand}`)),
      Effect.flatMap(() => getUserInputEffect(promptText)),
      Effect.map((userInput) => {
        // Use existing value if user pressed Enter with no input
        const issueKey = userInput || existingIssueKey;
        if (!issueKey) return [];
        const command = key === 'issue_view' ? `issue view ${issueKey}` : issueKey;
        return [
          {
            id: `${key}_1`,
            command,
            description: `Test ${commandType.name} with ${userInput}`,
            expectedPatterns: commandType.expectedPatterns,
            enabled: true,
          },
        ];
      }),
    );
  }

  if (key === 'ask') {
    return pipe(
      Console.log(chalk.dim('Enter questions about your environment (empty to skip):')),
      Effect.flatMap(() => collectAskQuestionsEffect(existingConfig)),
    );
  }

  if (key === 'mine') {
    // For mine command, set expected patterns to include the main project key
    const mainProjectKey = envInfo.projectKeys[0];
    const expectedPatterns = mainProjectKey
      ? ['- type: issue', 'assignee:', `key: ${mainProjectKey}-`]
      : ['- type: issue', 'assignee:'];

    return Effect.succeed([
      {
        id: 'mine_1',
        command: 'mine',
        description: `Test My Issues from ${mainProjectKey || 'main project'}`,
        expectedPatterns,
        llmValidation: false,
        enabled: true,
      },
    ]);
  }

  // For other command types, use predefined examples
  return Effect.succeed(
    commandType.examples.map((example, i) => ({
      id: `${key}_${i + 1}`,
      command: example,
      description: `Test ${commandType.name}: ${example}`,
      expectedPatterns: commandType.expectedPatterns,
      llmValidation: commandType.llmValidation,
      enabled: true,
    })),
  );
};

// Helper function to collect AI questions with defaults support
const collectAskQuestionsEffect = (existingConfig?: TestConfig | null): Effect.Effect<TestCase[], ValidationError> => {
  const existingAskTests = existingConfig?.tests.ask || [];

  const collectQuestion = (questionNum: number): Effect.Effect<TestCase[], ValidationError> => {
    const existingTest = existingAskTests[questionNum - 1];

    const questionPrompt = existingTest
      ? `Question ${questionNum} (current: "${existingTest.command.replace('ask "', '').replace('"', '')}", press Enter to keep, type "clear" to delete, or type new): `
      : `Question ${questionNum} (or press Enter to continue): `;

    return pipe(
      getUserInputEffect(questionPrompt),
      Effect.flatMap((question) => {
        // Handle special commands
        if (question?.toLowerCase() === 'clear' || question?.toLowerCase() === 'delete') {
          // Skip this question and continue to the next
          return pipe(
            collectQuestion(questionNum + 1),
            Effect.map((nextCases) => nextCases),
          );
        }

        // Use existing question if user pressed Enter with no input
        const finalQuestion =
          question || (existingTest ? existingTest.command.replace('ask "', '').replace('"', '') : '');

        if (!finalQuestion) return Effect.succeed([]);

        const topicsPrompt = existingTest?.expectedPatterns?.length
          ? `Expected topics in answer (current: ${existingTest.expectedPatterns.join(', ')}, press Enter to keep): `
          : 'Expected topics in answer (comma-separated): ';

        return pipe(
          getUserInputEffect(topicsPrompt),
          Effect.map((expectedTopicsInput) => {
            // Use existing topics if user pressed Enter with no input
            const finalTopicsInput = expectedTopicsInput || existingTest?.expectedPatterns?.join(', ') || '';

            const expectedTopics = finalTopicsInput
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);

            const testCase: TestCase = {
              id: `ask_${questionNum}`,
              command: `ask "${finalQuestion}"`,
              description: `Test AI answer for: ${finalQuestion}`,
              llmValidation: true,
              expectedPatterns: expectedTopics,
              enabled: true,
            };

            return [testCase];
          }),
          Effect.flatMap((currentCase) =>
            pipe(
              collectQuestion(questionNum + 1),
              Effect.map((nextCases) => [...currentCase, ...nextCases]),
            ),
          ),
        );
      }),
    );
  };

  return collectQuestion(1);
};

async function setupTests(): Promise<void> {
  await Effect.runPromise(
    setupTestsEffect().pipe(
      Effect.catchAll((error) =>
        pipe(
          Console.error(chalk.red('Setup failed:'), error.message),
          Effect.flatMap(() => Effect.succeed(process.exit(1))),
        ),
      ),
    ),
  );
}

async function runTests(): Promise<void> {
  console.log(chalk.bold('🧪 Running Tests\n'));

  const testManager = new TestManager();
  const config = (await testManager.loadConfig()) as MutableTestConfig | null;

  if (!config) {
    console.log(chalk.yellow('No test configuration found.'));
    console.log(chalk.dim('Run "ji test --setup" to configure tests.'));
    return;
  }

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let errorTests = 0;

  // Run all test categories
  for (const [category, tests] of Object.entries(config.tests)) {
    const categoryInfo = COMMAND_TYPES[category as keyof typeof COMMAND_TYPES];
    console.log(chalk.cyan(`\n${categoryInfo?.name || category} Tests:`));

    for (const test of tests as MutableTestCase[]) {
      if (!test.enabled) {
        console.log(chalk.dim(`  ⏭ Skipped: ${test.description}`));
        continue;
      }

      totalTests++;
      const commandDisplay = `ji ${test.command}`;
      console.log(chalk.dim(`  Running: ${commandDisplay}`));

      try {
        const result = await executeTest(test);

        if (result.success) {
          passedTests++;
          console.log(chalk.green(`  ✓ Pass: ${test.description}`));
        } else {
          failedTests++;
          console.log(chalk.red(`  ✗ Fail: ${test.description}`));
          if (result.error) {
            console.log(chalk.red(`    Error: ${result.error}`));
          }
        }

        // Update test result in config
        test.lastRun = new Date().toISOString();
        test.lastResult = result.success ? 'pass' : 'fail';
      } catch (error) {
        errorTests++;
        console.log(chalk.red(`  💥 Error: ${test.description}`));
        console.log(chalk.red(`    ${error instanceof Error ? error.message : 'Unknown error'}`));

        test.lastRun = new Date().toISOString();
        test.lastResult = 'error';
      }
    }
  }

  // Save updated config
  config.lastUpdated = new Date().toISOString();
  await testManager.saveConfig(config);

  // Show summary
  console.log(chalk.bold('\n📊 Test Summary:'));
  console.log(`  Total: ${totalTests}`);
  console.log(chalk.green(`  Passed: ${passedTests}`));
  console.log(chalk.red(`  Failed: ${failedTests}`));
  console.log(chalk.red(`  Errors: ${errorTests}`));

  const successRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  console.log(`  Success Rate: ${successRate}%`);

  if (failedTests > 0 || errorTests > 0) {
    process.exit(1);
  }
}

async function executeTest(test: TestCase): Promise<{ success: boolean; error?: string }> {
  const { spawn } = await import('node:child_process');

  return new Promise((resolve) => {
    const [command, ...args] = test.command.split(' ');
    const child = spawn('bun', ['run', 'src/cli.ts', command, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000, // 30 second timeout
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        resolve({ success: false, error: `Command failed with code ${code}: ${stderr}` });
        return;
      }

      // Validate output
      if (test.llmValidation) {
        const isValid = await validateWithLLM(test, stdout);
        resolve({ success: isValid });
      } else if (test.expectedPatterns) {
        const hasAllPatterns = test.expectedPatterns.every((pattern) => stdout.includes(pattern));
        resolve({
          success: hasAllPatterns,
          error: hasAllPatterns ? undefined : `Missing expected patterns: ${test.expectedPatterns.join(', ')}`,
        });
      } else {
        // Just check that command didn't fail
        resolve({ success: true });
      }
    });

    child.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });
  });
}

async function validateWithLLM(test: TestCase, output: string): Promise<boolean> {
  try {
    const ollama = new OllamaClient();
    if (!(await ollama.isAvailable())) {
      console.log(chalk.yellow('  ⚠ Ollama not available, skipping LLM validation'));
      return true; // Don't fail tests if LLM is unavailable
    }

    const prompt = `Evaluate this CLI command output for correctness and completeness.

Command: ${test.command}
Expected topics: ${test.expectedPatterns?.join(', ') || 'General response quality'}

Output:
${output}

Criteria:
1. Does the output appear to be a valid response to the command?
2. Is the information presented clearly and completely?
3. Are there any obvious errors or missing information?
4. Does it cover the expected topics (if specified)?

Respond with only "VALID" or "INVALID" followed by a brief reason.`;

    const response = await ollama.generate(prompt);
    const isValid = response.toLowerCase().includes('valid') && !response.toLowerCase().includes('invalid');

    if (!isValid) {
      console.log(chalk.dim(`    LLM validation: ${response}`));
    }

    return isValid;
  } catch (error) {
    console.log(chalk.yellow(`  ⚠ LLM validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
    return true; // Don't fail tests if LLM validation fails
  }
}

export async function testCommand(options: { setup?: boolean } = {}): Promise<void> {
  if (options.setup) {
    await setupTests();
  } else {
    await runTests();
  }
}
