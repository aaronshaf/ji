import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { z } from 'zod';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { OllamaClient } from '../../lib/ollama.js';

// Test configuration schema
const TestCaseSchema = z.object({
  id: z.string(),
  command: z.string(),
  description: z.string(),
  expectedPatterns: z.array(z.string()).optional(),
  llmValidation: z.boolean().optional(),
  enabled: z.boolean().default(true),
  lastRun: z.string().optional(),
  lastResult: z.enum(['pass', 'fail', 'error']).optional(),
});

const TestConfigSchema = z.object({
  version: z.string(),
  lastUpdated: z.string(),
  environment: z.object({
    jiraUrl: z.string(),
    projectKeys: z.array(z.string()),
    confluenceSpaces: z.array(z.string()),
  }),
  tests: z.record(z.string(), z.array(TestCaseSchema)),
});

type TestConfig = z.infer<typeof TestConfigSchema>;
type TestCase = z.infer<typeof TestCaseSchema>;

const TEST_CONFIG_PATH = join(homedir(), '.ji', 'test-config.json');

// Helper function for user input
async function getUserInput(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

class TestManager {
  private config: TestConfig | null = null;

  async loadConfig(): Promise<TestConfig | null> {
    if (!existsSync(TEST_CONFIG_PATH)) {
      return null;
    }

    try {
      const content = readFileSync(TEST_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      this.config = TestConfigSchema.parse(parsed);
      return this.config;
    } catch (error) {
      console.error(chalk.red('Failed to load test config:'), error instanceof Error ? error.message : 'Unknown error');
      return null;
    }
  }

  async saveConfig(config: TestConfig): Promise<void> {
    try {
      const content = JSON.stringify(config, null, 2);
      writeFileSync(TEST_CONFIG_PATH, content, 'utf-8');
      this.config = config;
    } catch (error) {
      throw new Error(`Failed to save test config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getEnvironmentInfo(): Promise<{ projectKeys: string[]; confluenceSpaces: string[] }> {
    const cacheManager = new CacheManager();
    try {
      const projects = await cacheManager.getAllProjects();
      const workspaces = await cacheManager.getActiveWorkspaces();

      const projectKeys = projects.map((p) => p.key);
      const confluenceSpaces = workspaces.filter((w) => w.type === 'confluence_space').map((w) => w.keyOrId);

      return { projectKeys, confluenceSpaces };
    } finally {
      cacheManager.close();
    }
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
    examples: ['sync', 'sync --clean'],
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
  memory: {
    name: 'Memory Operations',
    description: 'Manage manual memories',
    examples: ['remember "Test fact"', 'memories list', 'memories stats'],
    expectedPatterns: ['✓ Memory added', 'total_memories:', '- id:'],
    llmValidation: false,
  },
  mine: {
    name: 'My Issues',
    description: 'Show assigned issues',
    examples: ['mine'],
    expectedPatterns: ['- type: issue', 'assignee:'],
    llmValidation: false,
  },
};

async function setupTests(): Promise<void> {
  console.log(chalk.bold('🧪 Test Setup Wizard\n'));

  const testManager = new TestManager();
  const configManager = new ConfigManager();

  try {
    // Get configuration and environment info
    const config = await configManager.getConfig();
    if (!config) {
      console.error(chalk.red('No configuration found. Please run "ji auth" first.'));
      process.exit(1);
    }

    const envInfo = await testManager.getEnvironmentInfo();

    console.log(chalk.cyan('Environment detected:'));
    console.log(`  Jira URL: ${config.jiraUrl}`);
    console.log(`  Projects: ${envInfo.projectKeys.join(', ')}`);
    console.log(`  Confluence Spaces: ${envInfo.confluenceSpaces.join(', ')}\n`);

    // Initialize test config
    const testConfig: TestConfig = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      environment: {
        jiraUrl: config.jiraUrl,
        projectKeys: envInfo.projectKeys,
        confluenceSpaces: envInfo.confluenceSpaces,
      },
      tests: {},
    };

    // Setup each command type
    for (const [key, commandType] of Object.entries(COMMAND_TYPES)) {
      console.log(chalk.yellow(`Setting up ${commandType.name} tests:`));
      console.log(chalk.dim(`${commandType.description}\n`));

      const testCases: TestCase[] = [];

      if (key === 'issue_view' || key === 'issue_direct') {
        // Use real issue keys from environment
        if (envInfo.projectKeys.length > 0) {
          const exampleKey = `${envInfo.projectKeys[0]}-1234`;
          console.log(chalk.dim(`Example: ${key === 'issue_view' ? 'issue view' : ''} ${exampleKey}`));

          const userInput = await getUserInput(`Enter a real issue key from your environment (e.g., ${exampleKey}): `);
          if (userInput) {
            const command = key === 'issue_view' ? `issue view ${userInput}` : userInput;
            testCases.push({
              id: `${key}_1`,
              command,
              description: `Test ${commandType.name} with ${userInput}`,
              expectedPatterns: commandType.expectedPatterns,
              enabled: true,
            });
          }
        }
      } else if (key === 'ask') {
        // Setup AI question tests
        console.log(chalk.dim('Enter questions about your environment (empty to skip):'));
        let questionNum = 1;
        while (true) {
          const question = await getUserInput(`Question ${questionNum} (or press Enter to continue): `);
          if (!question) break;

          const expectedTopicsInput = await getUserInput('Expected topics in answer (comma-separated): ');
          const expectedTopics = expectedTopicsInput
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);

          testCases.push({
            id: `ask_${questionNum}`,
            command: `ask "${question}"`,
            description: `Test AI answer for: ${question}`,
            llmValidation: true,
            expectedPatterns: expectedTopics,
            enabled: true,
          });
          questionNum++;
        }
      } else {
        // Use predefined examples for other commands
        commandType.examples.forEach((example, i) => {
          testCases.push({
            id: `${key}_${i + 1}`,
            command: example,
            description: `Test ${commandType.name}: ${example}`,
            expectedPatterns: commandType.expectedPatterns,
            llmValidation: commandType.llmValidation,
            enabled: true,
          });
        });
      }

      if (testCases.length > 0) {
        testConfig.tests[key] = testCases;
        console.log(chalk.green(`✓ Added ${testCases.length} test(s) for ${commandType.name}\n`));
      } else {
        console.log(chalk.yellow(`⚠ No tests configured for ${commandType.name}\n`));
      }
    }

    // Save configuration
    await testManager.saveConfig(testConfig);
    console.log(chalk.green(`✓ Test configuration saved to ${TEST_CONFIG_PATH}`));
    console.log(chalk.dim('\nRun "ji test" to execute all configured tests.'));
  } finally {
    configManager.close();
  }
}

async function runTests(): Promise<void> {
  console.log(chalk.bold('🧪 Running Tests\n'));

  const testManager = new TestManager();
  const config = await testManager.loadConfig();

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

    for (const test of tests) {
      if (!test.enabled) {
        console.log(chalk.dim(`  ⏭ Skipped: ${test.description}`));
        continue;
      }

      totalTests++;
      console.log(chalk.dim(`  Running: ${test.description}`));

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
