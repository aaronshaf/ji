import { Effect, pipe } from 'effect';
import { Schema } from '@effect/schema';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class ProjectConfigError extends Error {
  readonly _tag = 'ProjectConfigError';
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
  }
}

const ProjectConfigSchema = Schema.Struct({
  worktreeSetup: Schema.optional(Schema.String),
  publish: Schema.optional(Schema.String),
  checkBuild: Schema.optional(Schema.String), // Deprecated: use checkBuildStatus + checkBuildFailures
  checkBuildStatus: Schema.optional(Schema.String), // Returns JSON: { "state": "pending|running|success|failure" }
  checkBuildFailures: Schema.optional(Schema.String), // Returns failure logs (only called when status is "failure")
});

export type ProjectConfig = typeof ProjectConfigSchema.Type;

const DEFAULT_CONFIG_FILENAME = '.jiconfig.json';

const readProjectConfigFile = (configPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const content = await readFile(configPath, 'utf8');
      return JSON.parse(content);
    },
    catch: (error) => new ProjectConfigError(`Failed to read project config from ${configPath}: ${error}`),
  });

const decodeProjectConfig = (rawConfig: unknown) =>
  Schema.decodeUnknown(ProjectConfigSchema)(rawConfig).pipe(
    Effect.mapError((error) => new ProjectConfigError(`Invalid project configuration: ${error}`)),
  );

const findProjectConfigPath = (startDir: string) =>
  Effect.sync(() => {
    const configPath = join(startDir, DEFAULT_CONFIG_FILENAME);
    return existsSync(configPath) ? configPath : null;
  });

export const loadProjectConfig = (worktreePath: string) =>
  pipe(
    findProjectConfigPath(worktreePath),
    Effect.flatMap((configPath) => {
      if (!configPath) {
        // No project config found, return empty config
        return Effect.succeed({} as ProjectConfig);
      }

      return pipe(readProjectConfigFile(configPath), Effect.flatMap(decodeProjectConfig));
    }),
    Effect.catchAll((error) => {
      if (error instanceof ProjectConfigError) {
        return Effect.fail(error);
      }
      return Effect.fail(new ProjectConfigError(`Failed to load project config: ${error}`));
    }),
  );

export const validateWorktreeSetup = (setupCommand: string, worktreePath: string) =>
  Effect.sync(() => {
    // If it's a relative path (starts with ./), validate it exists
    if (setupCommand.startsWith('./') || setupCommand.startsWith('../')) {
      const fullSetupPath = join(worktreePath, setupCommand);
      if (!existsSync(fullSetupPath)) {
        throw new ProjectConfigError(`Setup script not found: ${setupCommand}`);
      }
      return fullSetupPath;
    }

    // Otherwise, treat it as a command to be executed directly
    return setupCommand;
  });
