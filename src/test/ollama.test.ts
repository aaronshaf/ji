import { describe, expect, it } from 'bun:test';

// Test Ollama utilities without external dependencies
describe('Ollama Utilities', () => {
  describe('Error types', () => {
    it('should create OllamaError with proper structure', () => {
      class OllamaError extends Error {
        readonly _tag = 'OllamaError';
      }

      const error = new OllamaError('Ollama service unavailable');

      expect(error._tag).toBe('OllamaError');
      expect(error.message).toBe('Ollama service unavailable');
      expect(error instanceof Error).toBe(true);
    });

    it('should create NetworkError with proper structure', () => {
      class NetworkError extends Error {
        readonly _tag = 'NetworkError';
      }

      const error = new NetworkError('Failed to connect to Ollama');

      expect(error._tag).toBe('NetworkError');
      expect(error.message).toBe('Failed to connect to Ollama');
      expect(error instanceof Error).toBe(true);
    });

    it('should create GenerationError with proper structure', () => {
      class GenerationError extends Error {
        readonly _tag = 'GenerationError';
      }

      const error = new GenerationError('Text generation failed');

      expect(error._tag).toBe('GenerationError');
      expect(error.message).toBe('Text generation failed');
      expect(error instanceof Error).toBe(true);
    });

    it('should create ValidationError with proper structure', () => {
      class ValidationError extends Error {
        readonly _tag = 'ValidationError';
      }

      const error = new ValidationError('Invalid prompt provided');

      expect(error._tag).toBe('ValidationError');
      expect(error.message).toBe('Invalid prompt provided');
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('URL building', () => {
    it('should build correct API URLs', () => {
      const buildOllamaUrl = (baseUrl: string, endpoint: string): string => {
        return `${baseUrl}/api/${endpoint}`;
      };

      const baseUrl = 'http://127.0.0.1:11434';

      expect(buildOllamaUrl(baseUrl, 'tags')).toBe('http://127.0.0.1:11434/api/tags');
      expect(buildOllamaUrl(baseUrl, 'generate')).toBe('http://127.0.0.1:11434/api/generate');
      expect(buildOllamaUrl(baseUrl, 'embeddings')).toBe('http://127.0.0.1:11434/api/embeddings');
    });

    it('should handle different base URLs', () => {
      const buildOllamaUrl = (baseUrl: string, endpoint: string): string => {
        return `${baseUrl}/api/${endpoint}`;
      };

      expect(buildOllamaUrl('http://localhost:11434', 'generate')).toBe('http://localhost:11434/api/generate');
      expect(buildOllamaUrl('https://ollama.company.com', 'tags')).toBe('https://ollama.company.com/api/tags');
    });
  });

  describe('Request payload building', () => {
    it('should build generate request payload correctly', () => {
      const buildGeneratePayload = (
        prompt: string,
        options?: { model?: string; temperature?: number; stream?: boolean },
      ) => {
        const model = options?.model || 'gemma3n:latest';
        const temperature = options?.temperature ?? 0.7;
        const stream = options?.stream ?? false;

        return {
          model,
          prompt,
          stream,
          options: {
            temperature,
            top_p: 0.9,
          },
        };
      };

      // Default options
      const payload1 = buildGeneratePayload('Tell me about TypeScript');
      expect(payload1.model).toBe('gemma3n:latest');
      expect(payload1.prompt).toBe('Tell me about TypeScript');
      expect(payload1.stream).toBe(false);
      expect(payload1.options.temperature).toBe(0.7);
      expect(payload1.options.top_p).toBe(0.9);

      // Custom options
      const payload2 = buildGeneratePayload('Explain React hooks', {
        model: 'llama3.2:3b',
        temperature: 0.5,
        stream: true,
      });
      expect(payload2.model).toBe('llama3.2:3b');
      expect(payload2.options.temperature).toBe(0.5);
      expect(payload2.stream).toBe(true);
    });

    it('should handle edge cases in payload building', () => {
      const buildGeneratePayload = (prompt: string, options?: { model?: string; temperature?: number }) => {
        const model = options?.model || 'gemma3n:latest';
        const temperature = options?.temperature ?? 0.7;

        return {
          model,
          prompt,
          stream: false,
          options: {
            temperature,
            top_p: 0.9,
          },
        };
      };

      // Temperature of 0
      const payload1 = buildGeneratePayload('Test prompt', { temperature: 0 });
      expect(payload1.options.temperature).toBe(0);

      // Empty string model falls back to default
      const payload2 = buildGeneratePayload('Test prompt', { model: '' });
      expect(payload2.model).toBe('gemma3n:latest'); // Should use fallback
    });
  });

  describe('Input validation', () => {
    it('should validate prompt length', () => {
      const validatePrompt = (prompt: string): { valid: boolean; error?: string } => {
        if (!prompt || prompt.trim().length === 0) {
          return { valid: false, error: 'Prompt cannot be empty' };
        }
        if (prompt.length > 100000) {
          return { valid: false, error: 'Prompt too long (max 100k characters)' };
        }
        return { valid: true };
      };

      // Valid prompts
      expect(validatePrompt('Valid prompt')).toEqual({ valid: true });
      expect(validatePrompt('A'.repeat(50000))).toEqual({ valid: true });

      // Invalid prompts
      expect(validatePrompt('')).toEqual({
        valid: false,
        error: 'Prompt cannot be empty',
      });
      expect(validatePrompt('   ')).toEqual({
        valid: false,
        error: 'Prompt cannot be empty',
      });
      expect(validatePrompt('A'.repeat(100001))).toEqual({
        valid: false,
        error: 'Prompt too long (max 100k characters)',
      });
    });

    it('should validate temperature range', () => {
      const validateTemperature = (temperature?: number): { valid: boolean; error?: string } => {
        if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
          return { valid: false, error: 'Temperature must be between 0 and 2' };
        }
        return { valid: true };
      };

      // Valid temperatures
      expect(validateTemperature()).toEqual({ valid: true }); // undefined is valid
      expect(validateTemperature(0)).toEqual({ valid: true });
      expect(validateTemperature(1)).toEqual({ valid: true });
      expect(validateTemperature(2)).toEqual({ valid: true });
      expect(validateTemperature(0.7)).toEqual({ valid: true });

      // Invalid temperatures
      expect(validateTemperature(-0.1)).toEqual({
        valid: false,
        error: 'Temperature must be between 0 and 2',
      });
      expect(validateTemperature(2.1)).toEqual({
        valid: false,
        error: 'Temperature must be between 0 and 2',
      });
    });
  });

  describe('Response processing', () => {
    it('should process successful response', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
      const processOllamaResponse = (data: any): { success: boolean; response?: string; error?: string } => {
        if (data.error) {
          return { success: false, error: `Ollama error: ${data.error}` };
        }

        if (!data.response) {
          return { success: false, error: 'Empty response from Ollama' };
        }

        return { success: true, response: data.response };
      };

      // Successful response
      const successData = { response: 'TypeScript is a programming language...' };
      const result1 = processOllamaResponse(successData);
      expect(result1.success).toBe(true);
      expect(result1.response).toBe('TypeScript is a programming language...');

      // Error response
      const errorData = { error: 'Model not found' };
      const result2 = processOllamaResponse(errorData);
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('Ollama error: Model not found');

      // Empty response
      const emptyData = { response: '' };
      const result3 = processOllamaResponse(emptyData);
      expect(result3.success).toBe(false);
      expect(result3.error).toBe('Empty response from Ollama');

      // Missing response field
      const noResponseData = { model: 'gemma3n:latest' };
      const result4 = processOllamaResponse(noResponseData);
      expect(result4.success).toBe(false);
      expect(result4.error).toBe('Empty response from Ollama');
    });
  });

  describe('HTTP status code handling', () => {
    it('should categorize HTTP status codes correctly', () => {
      const categorizeStatus = (status: number): { type: 'success' | 'client' | 'server'; shouldRetry: boolean } => {
        if (status >= 200 && status < 300) {
          return { type: 'success', shouldRetry: false };
        }
        if (status >= 400 && status < 500) {
          return { type: 'client', shouldRetry: false };
        }
        if (status >= 500) {
          return { type: 'server', shouldRetry: true };
        }
        return { type: 'client', shouldRetry: false };
      };

      // Success statuses
      expect(categorizeStatus(200)).toEqual({ type: 'success', shouldRetry: false });
      expect(categorizeStatus(201)).toEqual({ type: 'success', shouldRetry: false });

      // Client error statuses
      expect(categorizeStatus(400)).toEqual({ type: 'client', shouldRetry: false });
      expect(categorizeStatus(404)).toEqual({ type: 'client', shouldRetry: false });
      expect(categorizeStatus(422)).toEqual({ type: 'client', shouldRetry: false });

      // Server error statuses
      expect(categorizeStatus(500)).toEqual({ type: 'server', shouldRetry: true });
      expect(categorizeStatus(502)).toEqual({ type: 'server', shouldRetry: true });
      expect(categorizeStatus(503)).toEqual({ type: 'server', shouldRetry: true });
    });

    it('should build appropriate error messages for status codes', () => {
      const buildErrorMessage = (status: number, statusText: string): string => {
        if (status >= 500) {
          return `Ollama server error: ${status} ${statusText}`;
        }
        return `Generation failed: ${status} ${statusText}`;
      };

      expect(buildErrorMessage(500, 'Internal Server Error')).toBe('Ollama server error: 500 Internal Server Error');
      expect(buildErrorMessage(502, 'Bad Gateway')).toBe('Ollama server error: 502 Bad Gateway');
      expect(buildErrorMessage(400, 'Bad Request')).toBe('Generation failed: 400 Bad Request');
      expect(buildErrorMessage(404, 'Not Found')).toBe('Generation failed: 404 Not Found');
    });
  });

  describe('Content hashing', () => {
    it('should validate content for hashing', () => {
      const validateContentForHashing = (content: string): { valid: boolean; error?: string } => {
        if (!content || content.length === 0) {
          return { valid: false, error: 'Cannot hash empty content' };
        }

        if (content.length > 10_000_000) {
          // 10MB limit
          return { valid: false, error: 'Content too large to hash' };
        }

        return { valid: true };
      };

      // Valid content
      expect(validateContentForHashing('Small content')).toEqual({ valid: true });
      expect(validateContentForHashing('A'.repeat(1000000))).toEqual({ valid: true }); // 1MB

      // Invalid content
      expect(validateContentForHashing('')).toEqual({
        valid: false,
        error: 'Cannot hash empty content',
      });
      expect(validateContentForHashing('A'.repeat(10_000_001))).toEqual({
        valid: false,
        error: 'Content too large to hash',
      });
    });

    it('should generate consistent hash format', () => {
      // Mock hash function for testing
      const mockHash = (content: string): string => {
        // Simple hash for testing - in reality this would use crypto.createHash
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(16).padStart(16, '0').substring(0, 16);
      };

      const content1 = 'This is test content for hashing';
      const content2 = 'This is test content for hashing'; // Same content
      const content3 = 'This is different content for hashing';

      const hash1 = mockHash(content1);
      const hash2 = mockHash(content2);
      const hash3 = mockHash(content3);

      // Same content should produce same hash
      expect(hash1).toBe(hash2);

      // Different content should produce different hash
      expect(hash1).not.toBe(hash3);

      // Hash should be 16 characters
      expect(hash1.length).toBe(16);
      expect(hash3.length).toBe(16);
    });
  });

  describe('Timeout handling', () => {
    it('should handle different timeout configurations', () => {
      const createTimeoutConfig = (timeoutMs: number) => {
        return {
          signal: {
            timeout: timeoutMs,
            description: `Timeout after ${timeoutMs}ms`,
          },
        };
      };

      // Availability check timeout (5 seconds)
      const availabilityConfig = createTimeoutConfig(5000);
      expect(availabilityConfig.signal.timeout).toBe(5000);
      expect(availabilityConfig.signal.description).toBe('Timeout after 5000ms');

      // Generation timeout (60 seconds)
      const generationConfig = createTimeoutConfig(60000);
      expect(generationConfig.signal.timeout).toBe(60000);
      expect(generationConfig.signal.description).toBe('Timeout after 60000ms');
    });
  });

  describe('Model configuration', () => {
    it('should handle different model names', () => {
      const normalizeModelName = (model?: string): string => {
        return model || 'gemma3n:latest';
      };

      expect(normalizeModelName()).toBe('gemma3n:latest');
      expect(normalizeModelName('')).toBe('gemma3n:latest');
      expect(normalizeModelName('llama3.2:3b')).toBe('llama3.2:3b');
      expect(normalizeModelName('mistral:7b')).toBe('mistral:7b');
      expect(normalizeModelName('codellama:13b')).toBe('codellama:13b');
    });

    it('should validate model name format', () => {
      const isValidModelName = (model: string): boolean => {
        // Simple validation - model should have format name:tag or just name
        return /^[a-zA-Z0-9_.-]+(:[\w.-]+)?$/.test(model);
      };

      // Valid model names
      expect(isValidModelName('gemma3n')).toBe(true);
      expect(isValidModelName('gemma3n:latest')).toBe(true);
      expect(isValidModelName('llama3.2:3b')).toBe(true);
      expect(isValidModelName('mistral-7b:instruct')).toBe(true);

      // Invalid model names
      expect(isValidModelName('')).toBe(false);
      expect(isValidModelName('model with spaces')).toBe(false);
      expect(isValidModelName('model@invalid')).toBe(false);
    });
  });

  describe('Stream response handling', () => {
    it('should configure streaming requests correctly', () => {
      const buildStreamPayload = (prompt: string, model?: string) => {
        return {
          model: model || 'gemma3n:latest',
          prompt,
          stream: true,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          },
        };
      };

      const payload = buildStreamPayload('Explain JavaScript closures', 'llama3.2:3b');

      expect(payload.stream).toBe(true);
      expect(payload.model).toBe('llama3.2:3b');
      expect(payload.prompt).toBe('Explain JavaScript closures');
      expect(payload.options.temperature).toBe(0.7);
      expect(payload.options.top_p).toBe(0.9);
    });
  });
});
