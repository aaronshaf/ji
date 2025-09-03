import type { AIProvider } from './types.ts';

// Base error classes with _tag for discriminated unions
export class AIProviderError extends Error {
  readonly _tag = 'AIProviderError';
  constructor(
    public readonly provider: AIProvider,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
  }
}

export class ConfigurationError extends Error {
  readonly _tag = 'ConfigurationError';
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class ProcessExecutionError extends Error {
  readonly _tag = 'ProcessExecutionError';
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string,
    message?: string,
  ) {
    super(message || `Command failed: ${command} (exit ${exitCode})`);
  }
}

export class StreamingError extends Error {
  readonly _tag = 'StreamingError';
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class SDKError extends Error {
  readonly _tag = 'SDKError';
  constructor(
    public readonly provider: string,
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(`SDK Error [${provider}]: ${message}`);
  }
}

// Union type for all AI tool errors
export type AIToolError = AIProviderError | ConfigurationError | ProcessExecutionError | StreamingError | SDKError;
