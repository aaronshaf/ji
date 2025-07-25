import { describe, expect, it } from 'bun:test';

// Test Effect-style error handling without importing Effect (to avoid dependencies)
describe('Effect Error Handling', () => {
  describe('Custom error types', () => {
    it('should create validation errors with proper structure', () => {
      class ValidationError extends Error {
        readonly _tag = 'ValidationError';

        constructor(
          message: string,
          public readonly field?: string,
          public readonly value?: unknown,
        ) {
          super(message);
        }
      }

      const error = new ValidationError('Invalid email format', 'email', 'invalid-email');

      expect(error._tag).toBe('ValidationError');
      expect(error.message).toBe('Invalid email format');
      expect(error.field).toBe('email');
      expect(error.value).toBe('invalid-email');
      expect(error instanceof Error).toBe(true);
    });

    it('should create network errors with proper structure', () => {
      class NetworkError extends Error {
        readonly _tag = 'NetworkError';

        constructor(
          message: string,
          public readonly status?: number,
          public readonly url?: string,
        ) {
          super(message);
        }
      }

      const error = new NetworkError('Request failed', 404, 'https://api.example.com/data');

      expect(error._tag).toBe('NetworkError');
      expect(error.status).toBe(404);
      expect(error.url).toBe('https://api.example.com/data');
    });

    it('should create database errors with query context', () => {
      class DatabaseError extends Error {
        readonly _tag = 'DatabaseError';

        constructor(
          message: string,
          public readonly query?: string,
          public readonly params?: unknown[],
        ) {
          super(message);
        }
      }

      const error = new DatabaseError(
        'Foreign key constraint failed',
        'INSERT INTO issues (key, project_key) VALUES (?, ?)',
        ['TEST-1', 'NONEXISTENT'],
      );

      expect(error._tag).toBe('DatabaseError');
      expect(error.query).toContain('INSERT INTO issues');
      expect(error.params).toEqual(['TEST-1', 'NONEXISTENT']);
    });
  });

  describe('Error handling patterns', () => {
    it('should handle errors with discriminated unions', () => {
      type Result<T, E> = { success: true; data: T } | { success: false; error: E };

      const createResult = <T, E>(data?: T, error?: E): Result<T, E> => {
        if (error) {
          return { success: false, error };
        }
        return { success: true, data: data as T };
      };

      // Success case
      const successResult = createResult('test data');
      expect(successResult.success).toBe(true);
      if (successResult.success) {
        expect(successResult.data).toBe('test data');
      }

      // Error case
      const errorResult = createResult<string, string>(undefined, 'error message');
      expect(errorResult.success).toBe(false);
      if (!errorResult.success) {
        expect(errorResult.error).toBe('error message');
      }
    });

    it('should chain operations safely', () => {
      type Result<T, E> = { success: true; data: T } | { success: false; error: E };

      const chain = <T, U, E>(result: Result<T, E>, fn: (data: T) => Result<U, E>): Result<U, E> => {
        if (!result.success) {
          return result;
        }
        return fn(result.data);
      };

      const parseNumber = (str: string): Result<number, string> => {
        const num = parseInt(str);
        if (Number.isNaN(num)) {
          return { success: false, error: 'Invalid number' };
        }
        return { success: true, data: num };
      };

      const double = (num: number): Result<number, string> => {
        return { success: true, data: num * 2 };
      };

      // Success chain
      const result1 = chain(parseNumber('42'), double);
      expect(result1.success).toBe(true);
      if (result1.success) {
        expect(result1.data).toBe(84);
      }

      // Error chain
      const result2 = chain(parseNumber('invalid'), double);
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error).toBe('Invalid number');
      }
    });
  });

  describe('Schema validation patterns', () => {
    it('should validate issue schema', () => {
      interface Issue {
        key: string;
        summary: string;
        status: string;
        priority?: string;
      }

      const validateIssue = (data: unknown): Result<Issue, string[]> => {
        const errors: string[] = [];

        if (typeof data !== 'object' || data === null) {
          return { success: false, error: ['Data must be an object'] };
        }

        // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
        const obj = data as any;

        if (typeof obj.key !== 'string' || !obj.key.match(/^[A-Z]+-\d+$/)) {
          errors.push('Invalid issue key format');
        }

        if (typeof obj.summary !== 'string' || obj.summary.length === 0) {
          errors.push('Summary is required');
        }

        if (typeof obj.status !== 'string' || obj.status.length === 0) {
          errors.push('Status is required');
        }

        if (obj.priority !== undefined && typeof obj.priority !== 'string') {
          errors.push('Priority must be a string if provided');
        }

        if (errors.length > 0) {
          return { success: false, error: errors };
        }

        return {
          success: true,
          data: {
            key: obj.key,
            summary: obj.summary,
            status: obj.status,
            priority: obj.priority,
          },
        };
      };

      // Valid issue
      const validIssue = {
        key: 'TEST-123',
        summary: 'Test issue',
        status: 'Open',
        priority: 'High',
      };

      const result1 = validateIssue(validIssue);
      expect(result1.success).toBe(true);

      // Invalid issue
      const invalidIssue = {
        key: 'invalid-key',
        summary: '',
        status: 'Open',
      };

      const result2 = validateIssue(invalidIssue);
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error).toContain('Invalid issue key format');
        expect(result2.error).toContain('Summary is required');
      }
    });

    it('should validate configuration schema', () => {
      interface Config {
        jiraUrl: string;
        email: string;
        apiToken: string;
      }

      const validateConfig = (data: unknown): Result<Config, string[]> => {
        const errors: string[] = [];

        if (typeof data !== 'object' || data === null) {
          return { success: false, error: ['Config must be an object'] };
        }

        // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
        const obj = data as any;

        if (typeof obj.jiraUrl !== 'string' || !obj.jiraUrl.startsWith('https://')) {
          errors.push('jiraUrl must be a valid HTTPS URL');
        }

        if (typeof obj.email !== 'string' || !obj.email.includes('@')) {
          errors.push('email must be a valid email address');
        }

        if (typeof obj.apiToken !== 'string' || obj.apiToken.length < 10) {
          errors.push('apiToken must be at least 10 characters');
        }

        if (errors.length > 0) {
          return { success: false, error: errors };
        }

        return {
          success: true,
          data: {
            jiraUrl: obj.jiraUrl,
            email: obj.email,
            apiToken: obj.apiToken,
          },
        };
      };

      // Valid config
      const validConfig = {
        jiraUrl: 'https://company.atlassian.net',
        email: 'user@company.com',
        apiToken: 'very-long-api-token',
      };

      const result1 = validateConfig(validConfig);
      expect(result1.success).toBe(true);

      // Invalid config
      const invalidConfig = {
        jiraUrl: 'http://insecure.com',
        email: 'invalid-email',
        apiToken: 'short',
      };

      const result2 = validateConfig(invalidConfig);
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error).toHaveLength(3);
      }
    });
  });

  describe('Resource management patterns', () => {
    it('should handle resource acquisition and cleanup', () => {
      interface Resource {
        id: string;
        close(): void;
      }

      class ResourceManager {
        private resources: Resource[] = [];

        acquire(id: string): Resource {
          const resource: Resource = {
            id,
            close: () => {
              const index = this.resources.indexOf(resource);
              if (index > -1) {
                this.resources.splice(index, 1);
              }
            },
          };
          this.resources.push(resource);
          return resource;
        }

        closeAll(): void {
          this.resources.forEach((r) => r.close());
        }

        getActiveCount(): number {
          return this.resources.length;
        }
      }

      const manager = new ResourceManager();

      // Acquire resources
      const resource1 = manager.acquire('res1');
      const _resource2 = manager.acquire('res2');

      expect(manager.getActiveCount()).toBe(2);

      // Close one resource
      resource1.close();
      expect(manager.getActiveCount()).toBe(1);

      // Close all resources
      manager.closeAll();
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  describe('Async error handling', () => {
    it('should handle async operations safely', async () => {
      const safeAsync = async <T>(operation: () => Promise<T>): Promise<Result<T, string>> => {
        try {
          const data = await operation();
          return { success: true, data };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      };

      // Successful async operation
      const successOperation = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return 'success';
      };

      const result1 = await safeAsync(successOperation);
      expect(result1.success).toBe(true);
      if (result1.success) {
        expect(result1.data).toBe('success');
      }

      // Failing async operation
      const failOperation = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('Operation failed');
      };

      const result2 = await safeAsync(failOperation);
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error).toBe('Operation failed');
      }
    });
  });
});

// Type helpers for Result pattern
type Result<T, E> = { success: true; data: T } | { success: false; error: E };
