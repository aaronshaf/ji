/**
 * Error hierarchy for Effect-based code
 * These errors provide better type safety and error handling
 */

export abstract class JiError extends Error {
  abstract readonly _tag: string;
  
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NetworkError extends JiError {
  readonly _tag = 'NetworkError';
}

export class DatabaseError extends JiError {
  readonly _tag = 'DatabaseError';
}

export class ParseError extends JiError {
  readonly _tag = 'ParseError';
}

export class ValidationError extends JiError {
  readonly _tag = 'ValidationError';
}

export class ConfigError extends JiError {
  readonly _tag = 'ConfigError';
}

export class NotFoundError extends JiError {
  readonly _tag = 'NotFoundError';
}

export class JiraError extends JiError {
  readonly _tag = 'JiraError';
}

export class ConfluenceError extends JiError {
  readonly _tag = 'ConfluenceError';
}

export class OllamaError extends JiError {
  readonly _tag = 'OllamaError';
}