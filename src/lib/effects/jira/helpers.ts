/**
 * Jira Client Helper Functions
 * Utility functions for validation, authentication, and error handling
 */

import { Duration, Effect, pipe, Schedule } from 'effect';
import {
  AuthenticationError,
  type ConfigError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.js';

// ============= Authentication Helpers =============
export function getAuthHeaders(config: { email: string; apiToken: string }): Record<string, string> {
  const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

// ============= Error Mapping =============
export const mapHttpError = (
  error: unknown,
): NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError => {
  // This would need to be implemented based on the HttpClientService error types
  if (error instanceof Error) {
    if (error.message.includes('401') || error.message.includes('403')) {
      return new AuthenticationError(error.message);
    }
    if (error.message.includes('404')) {
      return new NotFoundError(error.message);
    }
    if (error.message.includes('429')) {
      return new RateLimitError(error.message);
    }
    if (error.message.includes('timeout')) {
      return new TimeoutError(error.message);
    }
  }
  return new NetworkError(String(error));
};

// ============= Retry Strategy =============
export function createRetrySchedule(): Schedule.Schedule<unknown, unknown, unknown> {
  return pipe(Schedule.exponential(Duration.millis(100)), Schedule.intersect(Schedule.recurs(3)), Schedule.jittered);
}

// ============= Validation Functions =============
export function validateIssueKey(issueKey: string): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
      throw new ValidationError('Invalid issue key format. Expected format: PROJECT-123', 'issueKey', issueKey);
    }
  });
}

export function validateProjectKey(projectKey: string): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!projectKey || projectKey.length === 0) {
      throw new ValidationError('Project key cannot be empty', 'projectKey', projectKey);
    }
    if (!/^[A-Z][A-Z0-9]*$/.test(projectKey)) {
      throw new ValidationError('Invalid project key format', 'projectKey', projectKey);
    }
  });
}

export function validateAccountId(accountId: string): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!accountId || accountId.trim().length === 0) {
      throw new ValidationError('Account ID cannot be empty', 'accountId', accountId);
    }
  });
}

export function validateEmail(email: string): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!email || !email.includes('@')) {
      throw new ValidationError('Invalid email format', 'email', email);
    }
  });
}

export function validateBoardId(boardId: number): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!boardId || boardId <= 0) {
      throw new ValidationError('Board ID must be a positive number', 'boardId', boardId);
    }
  });
}

export function validateSprintId(sprintId: number): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!sprintId || sprintId <= 0) {
      throw new ValidationError('Sprint ID must be a positive number', 'sprintId', sprintId);
    }
  });
}

export function validateJQL(jql: string): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!jql || jql.trim().length === 0) {
      throw new ValidationError('JQL query cannot be empty', 'jql', jql);
    }
    if (jql.length > 10000) {
      throw new ValidationError('JQL query too long', 'jql', jql);
    }
  });
}

export function validateNonEmpty(value: string, fieldName: string): Effect.Effect<void, ValidationError> {
  return Effect.sync(() => {
    if (!value || value.trim().length === 0) {
      throw new ValidationError(`${fieldName} cannot be empty`, fieldName, value);
    }
  });
}
