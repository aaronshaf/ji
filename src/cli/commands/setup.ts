import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import { Console, Effect, pipe } from 'effect';

import { type Config, ConfigManager } from '../../lib/config.js';

// Effect wrapper for readline operations with default value
const askQuestionWithDefault = (
  question: string,
  defaultValue: string | undefined,
  rl: readline.Interface,
  isSecret = false,
) =>
  Effect.tryPromise({
    try: async () => {
      let prompt: string;
      if (defaultValue && !isSecret) {
        prompt = `${question} ${chalk.dim(`[${defaultValue}]`)}: `;
      } else if (defaultValue && isSecret) {
        prompt = `${question} ${chalk.dim('[<hidden>]')}: `;
      } else {
        prompt = `${question}: `;
      }
      const answer = await rl.question(prompt);
      return answer.trim() || defaultValue || '';
    },
    catch: (error) => new Error(`Failed to get user input: ${error}`),
  });

// Effect wrapper for yes/no questions
const askYesNo = (question: string, defaultValue = true, rl: readline.Interface) =>
  Effect.tryPromise({
    try: async () => {
      const defaultText = defaultValue ? 'Y/n' : 'y/N';
      const answer = await rl.question(`${question} ${chalk.dim(`[${defaultText}]`)}: `);
      const normalized = answer.trim().toLowerCase();
      if (!normalized) return defaultValue;
      return normalized === 'y' || normalized === 'yes';
    },
    catch: (error) => new Error(`Failed to get user input: ${error}`),
  });

// Effect wrapper for getting existing config
const getExistingConfig = () =>
  Effect.tryPromise({
    try: async (): Promise<Config | null> => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        return config;
      } finally {
        configManager.close();
      }
    },
    catch: () => new Error('Failed to get existing config'),
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

// Effect wrapper for verifying credentials
const verifyCredentials = (config: { jiraUrl: string; email: string; apiToken: string }) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${config.jiraUrl}/rest/api/3/myself`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    catch: (error) => {
      if (error instanceof Error) {
        if (error.message.includes('401')) {
          return new Error('Invalid credentials. Please check your email and API token.');
        }
        if (error.message.includes('ENOTFOUND')) {
          return new Error('Could not connect to Jira. Please check the URL.');
        }
        return error;
      }
      return new Error('Unknown error occurred');
    },
  });

// Effect wrapper for saving config
const saveConfig = (config: { jiraUrl: string; email: string; apiToken: string }) =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        await configManager.setConfig(config);
        return config;
      } finally {
        configManager.close();
      }
    },
    catch: (error) => new Error(`Failed to save configuration: ${error}`),
  });

// Check if a command exists
const checkCommand = (command: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve) => {
        const proc = spawn('which', [command], { stdio: 'ignore' });
        proc.on('close', (code) => resolve(code === 0));
      }),
    catch: () => false,
  });

// Install Meilisearch
const installMeilisearch = () =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        console.log(chalk.cyan('\nInstalling Meilisearch...'));
        const proc = spawn('brew', ['install', 'meilisearch'], {
          stdio: 'inherit',
        });
        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error('Failed to install Meilisearch'));
          }
        });
      }),
    catch: (error) => error as Error,
  });

// Check if Meilisearch is running
const checkMeilisearchRunning = () =>
  Effect.tryPromise({
    try: async () => {
      try {
        const response = await fetch('http://localhost:7700/health');
        return response.ok;
      } catch {
        return false;
      }
    },
    catch: () => false,
  });

// Start Meilisearch
const startMeilisearch = () =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve) => {
        console.log(chalk.cyan('Starting Meilisearch...'));
        const proc = spawn('meilisearch', ['--no-analytics'], {
          detached: true,
          stdio: 'ignore',
        });
        proc.unref();
        // Give it a moment to start
        setTimeout(resolve, 2000);
      }),
    catch: (error) => new Error(`Failed to start Meilisearch: ${error}`),
  });

// Check if Ollama model exists
const checkOllamaModel = (model: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve) => {
        const proc = spawn('ollama', ['list'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';

        proc.stdout?.on('data', (data) => {
          output += data.toString();
        });

        proc.on('close', () => {
          // Check if the model is in the list
          resolve(output.includes(model));
        });

        proc.on('error', () => {
          resolve(false);
        });
      }),
    catch: () => false,
  });

// Install Ollama
const installOllama = () =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        console.log(chalk.cyan('\nDownloading and installing Ollama...'));
        console.log(chalk.dim('This may take a few minutes...'));
        const proc = spawn('curl', ['-fsSL', 'https://ollama.ai/install.sh'], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });

        let script = '';
        proc.stdout?.on('data', (data) => {
          script += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            // Run the install script
            const install = spawn('sh', ['-c', script], {
              stdio: 'inherit',
            });
            install.on('close', (installCode) => {
              if (installCode === 0) {
                resolve();
              } else {
                reject(new Error('Failed to run Ollama installer'));
              }
            });
          } else {
            reject(new Error('Failed to download Ollama installer'));
          }
        });
      }),
    catch: (error) => error as Error,
  });

// Pull Ollama model
const pullOllamaModel = (model: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        console.log(chalk.cyan(`\nPulling ${model} model...`));
        console.log(chalk.dim('This will take a few minutes on first run...'));
        const proc = spawn('ollama', ['pull', model], {
          stdio: 'inherit',
        });
        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Failed to pull ${model} model`));
          }
        });
      }),
    catch: (error) => error as Error,
  });

// Show sync instructions
const showSyncInstructions = (projectKey: string) =>
  Effect.sync(() => {
    console.log(chalk.cyan(`\nTo sync ${projectKey}, run:`));
    console.log(chalk.bold(`  ji issue sync ${projectKey}`));
    console.log(chalk.dim('\nNote: The sync command will fetch all issues from this project.'));
  });

// Pure Effect-based setup implementation
const setupEffect = (rl: readline.Interface) =>
  pipe(
    Console.log(chalk.bold.cyan('\n🚀 Welcome to ji - Jira & Confluence CLI\n')),
    Effect.flatMap(() => Console.log('This wizard will help you set up ji in just a few steps.\n')),

    // Step 1: Atlassian credentials
    Effect.flatMap(() => Console.log(chalk.bold('Step 1: Atlassian Credentials'))),
    Effect.flatMap(() => getExistingConfig()),
    Effect.flatMap((existingConfig) => {
      const hasConfig = existingConfig !== null;
      return pipe(
        hasConfig ? Console.log(chalk.dim('(Press Enter to keep existing values)\n')) : Effect.succeed(undefined),
        Effect.flatMap(() =>
          askQuestionWithDefault('Jira URL (e.g., https://company.atlassian.net)', existingConfig?.jiraUrl, rl),
        ),
        Effect.map((jiraUrl: string) => (jiraUrl.endsWith('/') ? jiraUrl.slice(0, -1) : jiraUrl)),
        Effect.flatMap((jiraUrl) =>
          pipe(
            askQuestionWithDefault('Email', existingConfig?.email, rl),
            Effect.flatMap((email: string) =>
              pipe(
                askQuestionWithDefault('API Token', existingConfig?.apiToken, rl, true),
                Effect.map((apiToken: string) => ({ jiraUrl, email, apiToken })),
              ),
            ),
          ),
        ),
      );
    }),
    Effect.tap(() => Console.log('\nVerifying credentials...')),
    Effect.flatMap((config) =>
      pipe(
        verifyCredentials(config),
        Effect.map((user) => ({ config, user })),
      ),
    ),
    Effect.tap((result) => {
      const user = result.user;
      if (typeof user === 'object' && user !== null && 'displayName' in user && 'emailAddress' in user) {
        return Console.log(chalk.green(`✓ Authenticated as ${user.displayName} (${user.emailAddress})`));
      } else {
        return Console.log(chalk.green('✓ Authentication successful'));
      }
    }),
    Effect.flatMap(({ config }) => saveConfig(config)),

    // Step 2: Search tools (Meilisearch)
    Effect.flatMap(() => Console.log(chalk.bold('\nStep 2: Search Tools'))),
    Effect.flatMap(() =>
      pipe(
        checkCommand('meilisearch'),
        Effect.flatMap((hasMeilisearch) => {
          if (hasMeilisearch) {
            return Console.log(chalk.green('✓ Meilisearch is already installed'));
          } else {
            return pipe(
              Console.log('Meilisearch provides lightning-fast search with typo tolerance.'),
              Effect.flatMap(() => askYesNo('Would you like to install Meilisearch?', true, rl)),
              Effect.flatMap((install) => {
                if (install) {
                  return pipe(
                    checkCommand('brew'),
                    Effect.flatMap((hasBrew) => {
                      if (hasBrew) {
                        return installMeilisearch();
                      } else {
                        return Console.log(
                          chalk.yellow('\nHomebrew not found. Please install Meilisearch manually:'),
                        ).pipe(
                          Effect.flatMap(() => Console.log('  brew install meilisearch')),
                          Effect.flatMap(() =>
                            Console.log(
                              '  or visit: https://www.meilisearch.com/docs/learn/getting_started/installation',
                            ),
                          ),
                        );
                      }
                    }),
                  );
                } else {
                  return Console.log(chalk.dim('Skipping Meilisearch installation'));
                }
              }),
            );
          }
        }),
        Effect.flatMap(() =>
          pipe(
            checkCommand('meilisearch'),
            Effect.flatMap((hasMeilisearch) => {
              if (hasMeilisearch) {
                return pipe(
                  checkMeilisearchRunning(),
                  Effect.flatMap((isRunning) => {
                    if (isRunning) {
                      return Console.log(chalk.green('✓ Meilisearch is already running'));
                    } else {
                      return askYesNo('Would you like to start Meilisearch now?', true, rl).pipe(
                        Effect.flatMap((start) => (start ? startMeilisearch() : Effect.succeed(undefined))),
                      );
                    }
                  }),
                );
              }
              return Effect.succeed(undefined);
            }),
          ),
        ),
      ),
    ),

    // Step 3: AI features (Ollama)
    Effect.flatMap(() => Console.log(chalk.bold('\nStep 3: AI Features (Optional)'))),
    Effect.flatMap(() =>
      pipe(
        checkCommand('ollama'),
        Effect.flatMap((hasOllama) => {
          if (hasOllama) {
            return Console.log(chalk.green('✓ Ollama is already installed'));
          } else {
            return pipe(
              Console.log('Ollama enables AI-powered Q&A about your Jira and Confluence content.'),
              Effect.flatMap(() => askYesNo('Would you like to install Ollama?', true, rl)),
              Effect.flatMap((install) => {
                if (install) {
                  return installOllama();
                } else {
                  return Console.log(chalk.dim('Skipping Ollama installation'));
                }
              }),
            );
          }
        }),
        Effect.flatMap(() =>
          pipe(
            checkCommand('ollama'),
            Effect.flatMap((hasOllama) => {
              if (hasOllama) {
                // Check and install required models
                const models = [
                  { name: 'mxbai-embed-large', description: 'embedding model for hybrid search', required: true },
                  { name: 'gemma3n', description: 'language model for AI Q&A', required: true },
                  {
                    name: 'phi4:latest',
                    description: 'advanced model for better analysis (optional)',
                    required: false,
                  },
                ];

                return pipe(
                  Effect.all(
                    models.map((model) =>
                      pipe(
                        checkOllamaModel(model.name),
                        Effect.map((hasModel) => ({ ...model, installed: hasModel })),
                      ),
                    ),
                  ),
                  Effect.flatMap((modelStatuses) => {
                    const missingModels = modelStatuses.filter((m) => !m.installed);

                    if (missingModels.length === 0) {
                      return Console.log(chalk.green('✓ All AI models are already installed'));
                    }

                    return pipe(
                      Console.log('\nThe following AI models are recommended:'),
                      Effect.flatMap(() =>
                        Effect.all(
                          modelStatuses.map((model) =>
                            Console.log(
                              model.installed
                                ? chalk.green(`  ✓ ${model.name} - ${model.description}`)
                                : chalk.yellow(`  ○ ${model.name} - ${model.description}`),
                            ),
                          ),
                        ),
                      ),
                      Effect.flatMap(() => {
                        const requiredMissing = missingModels.filter((m) => m.required);
                        const optionalMissing = missingModels.filter((m) => !m.required);

                        return pipe(
                          // Install required models
                          requiredMissing.length > 0
                            ? pipe(
                                Console.log(chalk.cyan('\nInstalling required models...')),
                                Effect.flatMap(() =>
                                  Effect.all(
                                    requiredMissing.map((model) =>
                                      pipe(
                                        Console.log(chalk.dim(`Downloading ${model.name}...`)),
                                        Effect.flatMap(() => pullOllamaModel(model.name)),
                                      ),
                                    ),
                                    { concurrency: 1 },
                                  ),
                                ),
                                Effect.map(() => undefined),
                              )
                            : Effect.succeed(undefined),
                          // Ask about optional models
                          Effect.flatMap(() =>
                            optionalMissing.length > 0
                              ? pipe(
                                  askYesNo(
                                    `\nWould you like to install the optional model ${optionalMissing[0].name}?`,
                                    false,
                                    rl,
                                  ),
                                  Effect.flatMap((install) =>
                                    install
                                      ? pullOllamaModel(optionalMissing[0].name)
                                      : Console.log(chalk.dim('Skipping optional model')),
                                  ),
                                  Effect.map(() => undefined),
                                )
                              : Effect.succeed(undefined),
                          ),
                        );
                      }),
                    );
                  }),
                );
              }
              return Effect.succeed(undefined);
            }),
          ),
        ),
      ),
    ),

    // Step 4: Initial sync
    Effect.flatMap(() => Console.log(chalk.bold('\nStep 4: Initial Sync'))),
    Effect.succeed([] as { key: string; name: string }[]), // No cached projects in API-only mode
    Effect.flatMap((existingProjects) => {
      if (existingProjects.length > 0) {
        return pipe(
          Console.log(chalk.cyan('Found existing synced projects:')),
          Effect.flatMap(() =>
            Effect.all(
              existingProjects.slice(0, 5).map((project) => {
                const syncInfo = project.lastSync
                  ? chalk.dim(` - ${project.issueCount} issues, last synced ${project.lastSync.toLocaleDateString()}`)
                  : chalk.dim(' - not synced yet');
                return Console.log(`  ${chalk.bold(project.key)} ${project.name}${syncInfo}`);
              }),
            ),
          ),
          Effect.flatMap(() => {
            if (existingProjects.length > 5) {
              return Console.log(chalk.dim(`  ... and ${existingProjects.length - 5} more projects`));
            }
            return Effect.succeed(undefined);
          }),
          Effect.flatMap(() => Console.log('\nYou can sync more projects later with:')),
          Effect.flatMap(() => Console.log(chalk.cyan('  ji issue sync <project-key>'))),
          Effect.flatMap(() => Console.log('\nOr sync all active workspaces with:')),
          Effect.flatMap(() => Console.log(chalk.cyan('  ji sync'))),
        );
      } else {
        return pipe(
          Console.log("Let's set up your first Jira project."),
          Effect.flatMap(() => askQuestionWithDefault('Project key (e.g., PROJ)', undefined, rl)),
          Effect.flatMap((projectKey) => {
            if (projectKey && typeof projectKey === 'string' && projectKey.trim()) {
              return showSyncInstructions(projectKey.trim().toUpperCase());
            } else {
              return Console.log(chalk.dim('Skipping project setup'));
            }
          }),
        );
      }
    }),

    // Success!
    Effect.flatMap(() =>
      pipe(
        Console.log(chalk.bold.green('\n✅ Setup complete!\n')),
        Effect.flatMap(() => Console.log('Here are some commands to get you started:')),
        Effect.flatMap(() => Console.log(`${chalk.cyan('  ji mine')}          - View your assigned issues`)),
        Effect.flatMap(() => Console.log(`${chalk.cyan('  ji search "bug"')}  - Search for issues`)),
        Effect.flatMap(() =>
          Console.log(`${chalk.cyan('  ji ask "..."')}     - Ask questions about your knowledge base`),
        ),
        Effect.flatMap(() => Console.log(`${chalk.cyan('  ji sync')}          - Sync all your workspaces`)),
        Effect.flatMap(() => Console.log(`\nRun ${chalk.cyan('ji --help')} to see all available commands.`)),
      ),
    ),

    Effect.catchAll((error) =>
      pipe(
        Console.error(chalk.red(`\nSetup failed: ${error instanceof Error ? error.message : 'Unknown error'}`)),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function initializeSetup() {
  const rl = readline.createInterface({ input, output });

  const program = setupEffect(rl);

  try {
    await Effect.runPromise(program as Effect.Effect<void, unknown, never>);
  } catch (_error) {
    // Error already displayed
    process.exit(1);
  } finally {
    rl.close();
  }
}
