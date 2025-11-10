import { Effect, pipe } from 'effect';
import { Schema } from '@effect/schema';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

export class SafetyViolationError extends Error {
  readonly _tag = 'SafetyViolationError';
  constructor(
    message: string,
    public readonly violationType: string,
  ) {
    super(message);
  }
}

export class FileValidationError extends Error {
  readonly _tag = 'FileValidationError';
}

const SafetyConfigSchema = Schema.Struct({
  maxFileSize: Schema.Number.pipe(Schema.positive()),
  maxFilesModified: Schema.Number.pipe(Schema.positive()),
  allowedExtensions: Schema.Array(Schema.String),
  forbiddenPaths: Schema.Array(Schema.String),
  forbiddenPatterns: Schema.Array(Schema.String),
  requireTests: Schema.Boolean,
  allowPackageJsonModification: Schema.Boolean,
  allowEnvFileModification: Schema.Boolean,
});

export type SafetyConfig = typeof SafetyConfigSchema.Type;

export const defaultSafetyConfig: SafetyConfig = {
  maxFileSize: 1024 * 1024, // 1MB
  maxFilesModified: 50,
  allowedExtensions: ['.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.yaml', '.yml', '.css', '.scss', '.html'],
  forbiddenPaths: [
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    'package-lock.json',
    'bun.lockb',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.git',
    'node_modules',
    '.ji',
  ],
  forbiddenPatterns: [
    '**/*.key',
    '**/*.pem',
    '**/*.p12',
    '**/*.pfx',
    '**/id_rsa*',
    '**/id_dsa*',
    '**/id_ed25519*',
    '**/secrets/**',
    '**/credentials/**',
  ],
  requireTests: true,
  allowPackageJsonModification: false,
  allowEnvFileModification: false,
};

const checkFileSize = (filePath: string, maxSize: number) =>
  Effect.tryPromise({
    try: async () => {
      const stats = await stat(filePath);
      return stats.size <= maxSize;
    },
    catch: (error) => new FileValidationError(`Failed to check file size for ${filePath}: ${error}`),
  });

const checkFileExtension = (filePath: string, allowedExtensions: readonly string[]) =>
  Effect.sync(() => {
    const extension = filePath.substring(filePath.lastIndexOf('.'));
    return allowedExtensions.includes(extension) || allowedExtensions.includes('.*');
  });

const checkForbiddenPaths = (filePath: string, basePath: string, forbiddenPaths: readonly string[]) =>
  Effect.sync(() => {
    const relativePath = relative(basePath, resolve(filePath));

    return !forbiddenPaths.some((forbidden) => {
      // Check if the path starts with a forbidden path
      if (relativePath.startsWith(forbidden)) return true;

      // Check if any part of the path matches a forbidden path
      const pathParts = relativePath.split('/');
      return pathParts.some((part) => part === forbidden);
    });
  });

const checkForbiddenPatterns = (filePath: string, basePath: string, forbiddenPatterns: readonly string[]) =>
  Effect.sync(() => {
    const relativePath = relative(basePath, resolve(filePath));

    return !forbiddenPatterns.some((pattern) => {
      // Simple glob pattern matching
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'));
      return regex.test(relativePath);
    });
  });

const validateSingleFile = (filePath: string, basePath: string, config: SafetyConfig) =>
  pipe(
    Effect.all([
      checkFileSize(filePath, config.maxFileSize),
      checkFileExtension(filePath, config.allowedExtensions),
      checkForbiddenPaths(filePath, basePath, config.forbiddenPaths),
      checkForbiddenPatterns(filePath, basePath, config.forbiddenPatterns),
    ]),
    Effect.map(([sizeOk, extensionOk, pathOk, patternOk]) => {
      const errors: string[] = [];

      if (!sizeOk) {
        errors.push(`File too large: ${filePath} exceeds ${config.maxFileSize} bytes`);
      }

      if (!extensionOk) {
        errors.push(`Forbidden file extension: ${filePath}`);
      }

      if (!pathOk) {
        errors.push(`Forbidden path: ${filePath}`);
      }

      if (!patternOk) {
        errors.push(`Matches forbidden pattern: ${filePath}`);
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    }),
    Effect.catchAll((error) =>
      Effect.succeed({
        valid: false,
        errors: [`Validation failed for ${filePath}: ${error.message}`],
      }),
    ),
  );

export const validateFiles = (
  filePaths: readonly string[],
  basePath: string,
  config: SafetyConfig = defaultSafetyConfig,
) =>
  pipe(
    Effect.sync(() => {
      if (filePaths.length > config.maxFilesModified) {
        throw new SafetyViolationError(
          `Too many files modified: ${filePaths.length} exceeds limit of ${config.maxFilesModified}`,
          'MAX_FILES_EXCEEDED',
        );
      }
      return filePaths;
    }),
    Effect.flatMap((paths) =>
      pipe(
        Effect.all(
          Array.from(paths).map((path) => validateSingleFile(path, basePath, config)),
          { concurrency: 'unbounded' },
        ),
        Effect.map((results) => {
          const allErrors = results.flatMap((r) => r.errors);
          const allValid = results.every((r) => r.valid);

          return {
            valid: allValid,
            errors: allErrors,
            validatedFiles: paths.length,
          };
        }),
      ),
    ),
    Effect.catchAll((error: unknown) =>
      Effect.fail(
        error instanceof SafetyViolationError
          ? error
          : new SafetyViolationError(`File validation failed: ${String(error)}`, 'VALIDATION_ERROR'),
      ),
    ),
  );

export const validatePackageJsonChanges = (packageJsonPath: string, config: SafetyConfig = defaultSafetyConfig) =>
  pipe(
    Effect.sync(() => {
      if (!config.allowPackageJsonModification) {
        throw new SafetyViolationError(
          'package.json modification is not allowed by safety configuration',
          'PACKAGE_JSON_FORBIDDEN',
        );
      }
      return packageJsonPath;
    }),
    Effect.flatMap((path) =>
      Effect.tryPromise({
        try: async () => {
          const content = await readFile(path, 'utf8');
          const packageJson = JSON.parse(content);

          // Check for dangerous changes
          const dangerousFields = ['scripts.preinstall', 'scripts.postinstall', 'bin'];
          const warnings: string[] = [];

          for (const field of dangerousFields) {
            const fieldParts = field.split('.');
            let current = packageJson;

            for (const part of fieldParts) {
              if (current && typeof current === 'object' && part in current) {
                current = current[part];
              } else {
                current = undefined;
                break;
              }
            }

            if (current !== undefined) {
              warnings.push(`Potentially dangerous field detected: ${field}`);
            }
          }

          return {
            valid: warnings.length === 0,
            warnings,
            packageJson,
          };
        },
        catch: (error) => new FileValidationError(`Failed to validate package.json: ${error}`),
      }),
    ),
    Effect.catchAll((error) =>
      Effect.fail(
        error instanceof SafetyViolationError
          ? error
          : new SafetyViolationError(`package.json validation failed: ${error}`, 'PACKAGE_JSON_VALIDATION'),
      ),
    ),
  );

export const checkTestRequirements = (
  modifiedFiles: string[],
  _basePath: string,
  config: SafetyConfig = defaultSafetyConfig,
  testsWereRun = false, // NEW: indicate if tests were executed during iterations
) =>
  Effect.sync(() => {
    if (!config.requireTests) {
      return { satisfied: true, reason: 'Test requirements disabled' };
    }

    const codeFiles = modifiedFiles.filter((file) => {
      const extension = file.substring(file.lastIndexOf('.'));
      return ['.ts', '.js', '.tsx', '.jsx'].includes(extension) && !file.includes('.test.') && !file.includes('.spec.');
    });

    if (codeFiles.length === 0) {
      return { satisfied: true, reason: 'No code files modified' };
    }

    // NEW: If tests were run by the agent, that satisfies the requirement
    if (testsWereRun) {
      return {
        satisfied: true,
        reason: `Tests were executed by agent for ${codeFiles.length} modified code file(s)`,
      };
    }

    const testFiles = modifiedFiles.filter(
      (file) => file.includes('.test.') || file.includes('.spec.') || file.includes('__tests__/'),
    );

    if (testFiles.length === 0) {
      return {
        satisfied: false,
        reason: `Code files modified but no test files found. Modified: ${codeFiles.join(', ')}`,
      };
    }

    return {
      satisfied: true,
      reason: `Found ${testFiles.length} test files for ${codeFiles.length} code files`,
    };
  });

export const createSafetyReport = (
  validationResult: { valid: boolean; errors: string[]; validatedFiles: number },
  testRequirement: { satisfied: boolean; reason: string },
  additionalChecks: Record<string, boolean> = {},
) =>
  Effect.sync(() => ({
    overall: validationResult.valid && testRequirement.satisfied && Object.values(additionalChecks).every(Boolean),
    fileValidation: {
      valid: validationResult.valid,
      errors: validationResult.errors,
      filesValidated: validationResult.validatedFiles,
    },
    testRequirements: testRequirement,
    additionalChecks,
    summary: [
      `Files: ${validationResult.valid ? '✅' : '❌'} (${validationResult.validatedFiles} validated)`,
      `Tests: ${testRequirement.satisfied ? '✅' : '❌'} (${testRequirement.reason})`,
      ...Object.entries(additionalChecks).map(([check, passed]) => `${check}: ${passed ? '✅' : '❌'}`),
    ].join('\n'),
  }));
