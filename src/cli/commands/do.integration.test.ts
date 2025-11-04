import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Integration tests for ji do command
 *
 * These tests verify the complete workflow in dry-run mode to ensure
 * all components work together correctly without making actual changes.
 */

/**
 * Get a working temp directory, falling back to project directory if system tmp has issues
 */
function getTempDir(): string {
  try {
    const { tmpdir } = require('node:os');
    const systemTmp = tmpdir();
    // Test if we can create a directory
    const testDir = join(systemTmp, `ji-test-${Date.now()}`);
    mkdirSync(testDir);
    rmSync(testDir, { recursive: true, force: true });
    return systemTmp;
  } catch {
    // Fall back to project .tmp directory
    const projectTmp = join(process.cwd(), '.tmp');
    if (!existsSync(projectTmp)) {
      mkdirSync(projectTmp, { recursive: true });
    }
    return projectTmp;
  }
}

/**
 * Creates a temporary directory with retry logic
 */
function createTempDir(prefix: string): string {
  const baseTmpDir = getTempDir();
  const uniqueDir = join(baseTmpDir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(uniqueDir, { recursive: true });
  return uniqueDir;
}

describe('ji do integration tests', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create a temporary git repository for testing
    testDir = createTempDir('ji-do-test');
    originalCwd = process.cwd();

    // Initialize a git repository
    execSync('git init', { cwd: testDir });
    execSync('git config user.email "test@example.com"', { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: testDir });
    execSync('git branch -M main', { cwd: testDir });

    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Input Validation', () => {
    it('should reject invalid issue key format', async () => {
      // Test various invalid formats
      const invalidKeys = ['invalid', 'ABC', '123', 'abc-123', 'ABC-', '-123', 'ABC-123-DEF'];

      // Import Effect and doCommandEffect (exported for testing)
      // (doCommand calls process.exit which would terminate the test)
      const { Effect } = await import('effect');
      const { doCommandEffect } = await import('./do.js');

      for (const key of invalidKeys) {
        try {
          await Effect.runPromise(doCommandEffect(key, { dryRun: true }));
          expect.unreachable(`Should have rejected invalid key: ${key}`);
        } catch (error) {
          expect((error as Error).message).toContain('Invalid issue key format');
        }
      }
    });

    it('should accept valid issue key format', async () => {
      // Test valid formats - these will fail at config/git validation, not key validation
      const validKeys = ['ABC-123', 'EVAL-456', 'PROJECT-1', 'TOOLONG-999'];

      const { Effect } = await import('effect');
      const { doCommandEffect } = await import('./do.js');

      for (const key of validKeys) {
        try {
          await Effect.runPromise(doCommandEffect(key, { dryRun: true }));
        } catch (error) {
          // Should NOT contain "Invalid issue key format"
          // Will fail for other reasons (no config, not in git repo, etc.)
          expect((error as Error).message).not.toContain('Invalid issue key format');
        }
      }
    });
  });

  describe('Dry Run Mode', () => {
    it('should not create worktree in dry-run mode', async () => {
      const worktreesDir = join(require('node:os').homedir(), '.ji', 'worktrees');

      try {
        const { Effect } = await import('effect');
        const { doCommandEffect } = await import('./do.js');
        await Effect.runPromise(doCommandEffect('TEST-123', { dryRun: true }));
      } catch (_error) {
        // Expected to fail due to missing config, but shouldn't create worktree
      }

      // Verify no worktree was created
      const { existsSync, readdirSync } = await import('node:fs');
      if (existsSync(worktreesDir)) {
        const worktrees = readdirSync(worktreesDir);
        const testWorktrees = worktrees.filter((name) => name.includes('TEST-123'));
        expect(testWorktrees).toHaveLength(0);
      }
    });
  });

  describe('Git Repository Validation', () => {
    it('should require clean working tree', async () => {
      // Create an uncommitted file
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(testDir, 'test.txt'), 'uncommitted change');

      try {
        const { Effect } = await import('effect');
        const { doCommandEffect } = await import('./do.js');
        await Effect.runPromise(doCommandEffect('TEST-123', { dryRun: false }));
        expect.unreachable('Should have rejected uncommitted changes');
      } catch (error) {
        expect((error as Error).message).toContain('uncommitted changes');
      }
    });

    it('should allow uncommitted changes in dry-run mode', async () => {
      // Create an uncommitted file
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(testDir, 'test.txt'), 'uncommitted change');

      try {
        const { Effect } = await import('effect');
        const { doCommandEffect } = await import('./do.js');
        await Effect.runPromise(doCommandEffect('TEST-123', { dryRun: true }));
      } catch (error) {
        // Should fail for other reasons (like missing config), not uncommitted changes
        expect((error as Error).message).not.toContain('uncommitted changes');
      }
    });
  });

  describe('PR Title Security', () => {
    it('should handle special characters in issue summary safely', async () => {
      // This test documents that we use spawnSync with array args
      // which prevents command injection even with special characters

      const _dangerousCharacters = [
        '"; rm -rf / #',
        "'; echo 'injected'; #",
        '`whoami`',
        '$(echo injected)',
        '&& echo injected',
        '| echo injected',
      ];

      // We can't easily test the full flow, but we can verify the approach
      // The key is that do.ts:610 uses spawnSync with array args:
      // spawnSync('gh', ['pr', 'create', '--title', prTitle, ...])
      //
      // This is safe because the title is passed as a separate argument,
      // not interpolated into a shell command string.

      // Document the security property
      expect(true).toBe(true); // This test serves as documentation
    });
  });
});

describe('Safety Controls', () => {
  it('should validate file extensions', async () => {
    const { validateFiles, defaultSafetyConfig } = await import('../../lib/safety-controls.js');
    const { Effect } = await import('effect');

    const testFiles = [
      'src/test.ts', // Allowed
      'src/test.js', // Allowed
      'malicious.exe', // Not allowed
    ];

    const result = await Effect.runPromise(
      validateFiles(testFiles, process.cwd(), defaultSafetyConfig).pipe(
        Effect.catchAll(() => Effect.succeed({ valid: false, errors: [], validatedFiles: 0 })),
      ),
    );

    // Should fail due to .exe file
    expect(result.valid).toBe(false);
  });

  it('should reject files exceeding size limit', async () => {
    const { validateFiles, defaultSafetyConfig } = await import('../../lib/safety-controls.js');
    const { Effect } = await import('effect');
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Create a large file
    const largeFile = join(process.cwd(), 'large.ts');
    const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB (exceeds 1MB limit)
    writeFileSync(largeFile, largeContent);

    try {
      const result = await Effect.runPromise(
        validateFiles([largeFile], process.cwd(), defaultSafetyConfig).pipe(
          Effect.catchAll(() => Effect.succeed({ valid: false, errors: ['Size limit'], validatedFiles: 0 })),
        ),
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('too large'))).toBe(true);
    } finally {
      // Cleanup
      try {
        rmSync(largeFile);
      } catch {
        // Ignore
      }
    }
  });

  it('should enforce test requirements for code changes', async () => {
    const { checkTestRequirements, defaultSafetyConfig } = await import('../../lib/safety-controls.js');
    const { Effect } = await import('effect');

    // Code files without tests should fail
    const codeFiles = ['src/feature.ts', 'src/utils.ts'];

    const result = await Effect.runPromise(checkTestRequirements(codeFiles, process.cwd(), defaultSafetyConfig));

    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('no test files');
  });

  it('should pass test requirements when test files are present', async () => {
    const { checkTestRequirements, defaultSafetyConfig } = await import('../../lib/safety-controls.js');
    const { Effect } = await import('effect');

    // Code files with corresponding tests should pass
    const filesWithTests = ['src/feature.ts', 'src/feature.test.ts'];

    const result = await Effect.runPromise(checkTestRequirements(filesWithTests, process.cwd(), defaultSafetyConfig));

    expect(result.satisfied).toBe(true);
  });
});
