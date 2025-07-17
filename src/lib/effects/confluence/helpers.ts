/**
 * Confluence Client Helper Functions
 * Validation and utility functions
 */

import { Duration, Effect, pipe, Schedule } from 'effect';
import { ValidationError } from '../errors.js';
import type { ContentCreationOptions, ContentUpdateOptions } from './types.js';

// ============= Validation Methods =============
export const validateSpaceKey = (spaceKey: string): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!spaceKey || spaceKey.trim().length === 0) {
      throw new ValidationError('Space key cannot be empty', 'spaceKey', spaceKey);
    }
  });
};

export const validatePageId = (pageId: string): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!pageId || pageId.trim().length === 0) {
      throw new ValidationError('Page ID cannot be empty', 'pageId', pageId);
    }
  });
};

export const validateAttachmentId = (attachmentId: string): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!attachmentId || attachmentId.trim().length === 0) {
      throw new ValidationError('Attachment ID cannot be empty', 'attachmentId', attachmentId);
    }
  });
};

export const validateCQL = (cql: string): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!cql || cql.trim().length === 0) {
      throw new ValidationError('CQL query cannot be empty', 'cql', cql);
    }
    if (cql.length > 10000) {
      throw new ValidationError('CQL query too long', 'cql', cql);
    }
  });
};

export const validateNonEmpty = (value: string, fieldName: string): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!value || value.trim().length === 0) {
      throw new ValidationError(`${fieldName} cannot be empty`, fieldName, value);
    }
  });
};

export const validateContentCreationOptions = (
  options: ContentCreationOptions,
): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!options) {
      throw new ValidationError('Content creation options are required', 'options', options);
    }
    if (!options.title || options.title.trim().length === 0) {
      throw new ValidationError('Title is required', 'title', options.title);
    }
    if (!options.space?.key) {
      throw new ValidationError('Space key is required', 'space.key', options.space?.key);
    }
    if (!options.body?.storage?.value) {
      throw new ValidationError('Content body is required', 'body.storage.value', options.body?.storage?.value);
    }
  });
};

export const validateContentUpdateOptions = (options: ContentUpdateOptions): Effect.Effect<void, ValidationError> => {
  return Effect.sync(() => {
    if (!options) {
      throw new ValidationError('Content update options are required', 'options', options);
    }
    if (!options.version?.number || options.version.number <= 0) {
      throw new ValidationError('Valid version number is required', 'version.number', options.version?.number);
    }
  });
};

// ============= HTTP Helpers =============
export const getAuthHeaders = (config: { email: string; apiToken: string }): Record<string, string> => {
  const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
  };
};

export const createRetrySchedule = (): Schedule.Schedule<unknown, unknown, unknown> => {
  return pipe(Schedule.exponential(Duration.millis(100)), Schedule.intersect(Schedule.recurs(3)), Schedule.jittered);
};
