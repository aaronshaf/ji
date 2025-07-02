/**
 * Error hierarchy for Effect-based code
 * These errors provide better type safety and error handling
 */

export abstract class JiError extends Error {
  abstract readonly _tag: string;
  abstract readonly module: string;
  
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ============= Database Errors =============
export class DatabaseError extends JiError {
  readonly _tag = 'DatabaseError';
  readonly module = 'database';
}

export class ConnectionError extends JiError {
  readonly _tag = 'ConnectionError';
  readonly module = 'database';
}

export class QueryError extends JiError {
  readonly _tag = 'QueryError';
  readonly module = 'database';
}

export class TransactionError extends JiError {
  readonly _tag = 'TransactionError';
  readonly module = 'database';
}

// ============= Cache Errors =============
export class CacheError extends JiError {
  readonly _tag = 'CacheError';
  readonly module = 'cache';
}

export class CacheCorruptedError extends JiError {
  readonly _tag = 'CacheCorruptedError';
  readonly module = 'cache';
}

// ============= Network Errors =============
export class NetworkError extends JiError {
  readonly _tag = 'NetworkError';
  readonly module = 'network';
}

export class TimeoutError extends JiError {
  readonly _tag = 'TimeoutError';
  readonly module = 'network';
}

export class RateLimitError extends JiError {
  readonly _tag = 'RateLimitError';
  readonly module = 'network';
  
  constructor(
    message: string,
    public readonly retryAfter?: number,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

// ============= Validation Errors =============
export class ValidationError extends JiError {
  readonly _tag = 'ValidationError';
  readonly module = 'validation';
  
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

export class ParseError extends JiError {
  readonly _tag = 'ParseError';
  readonly module = 'validation';
  
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

// ============= Configuration Errors =============
export class ConfigError extends JiError {
  readonly _tag = 'ConfigError';
  readonly module = 'config';
}

// ============= Not Found Errors =============
export class NotFoundError extends JiError {
  readonly _tag = 'NotFoundError';
  readonly module = 'general';
}

// ============= External Service Errors =============
export class JiraError extends JiError {
  readonly _tag = 'JiraError';
  readonly module = 'jira';
}

export class ConfluenceError extends JiError {
  readonly _tag = 'ConfluenceError';
  readonly module = 'confluence';
}

export class SpaceNotFoundError extends JiError {
  readonly _tag = 'SpaceNotFoundError';
  readonly module = 'confluence';
}

export class PageNotFoundError extends JiError {
  readonly _tag = 'PageNotFoundError';
  readonly module = 'confluence';
}

export class AuthenticationError extends JiError {
  readonly _tag = 'AuthenticationError';
  readonly module = 'auth';
}

export class OllamaError extends JiError {
  readonly _tag = 'OllamaError';
  readonly module = 'ollama';
}

// ============= Content Errors =============
export class ContentError extends JiError {
  readonly _tag = 'ContentError';
  readonly module = 'content';
}

export class ContentTooLargeError extends JiError {
  readonly _tag = 'ContentTooLargeError';
  readonly module = 'content';
  
  constructor(
    message: string,
    public readonly size: number,
    public readonly maxSize: number,
    cause?: unknown
  ) {
    super(message, cause);
  }
}