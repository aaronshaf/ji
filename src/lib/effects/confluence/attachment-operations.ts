/**
 * Confluence Attachment Operations
 * All attachment-related operations
 */

import { Effect, pipe, Schema } from 'effect';
import {
  AuthenticationError,
  type ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  type ValidationError,
} from '../errors.js';
import type { ConfigService, HttpClientService, LoggerService } from '../layers.js';
import { createRetrySchedule, getAuthHeaders, validateAttachmentId, validatePageId } from './helpers.js';
import { type Attachment, AttachmentSchema } from './schemas.js';
import type { AllErrors, CommonErrors } from './types.js';

export class AttachmentOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
    private baseUrl: string,
  ) {}

  getPageAttachments(pageId: string): Effect.Effect<Attachment[], AllErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${pageId}/child/attachment?expand=version,container,metadata`;

        return pipe(
          this.logger.debug('Fetching page attachments', { pageId }),
          Effect.flatMap(() => this.makeRequest<unknown>(url)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = data as { results: unknown[] };
                return result.results.map((attachment) => Schema.decodeUnknownSync(AttachmentSchema)(attachment));
              },
              catch: (error) =>
                new ParseError('Failed to parse attachments response', 'attachments', String(data), error),
            }),
          ),
          Effect.tap((attachments) =>
            this.logger.debug('Page attachments fetched successfully', { pageId, count: attachments.length }),
          ),
        );
      }),
    );
  }

  downloadAttachment(attachmentId: string): Effect.Effect<ArrayBuffer, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      validateAttachmentId(attachmentId),
      Effect.flatMap(() => {
        const url = `${this.baseUrl}/content/${attachmentId}/download`;

        return pipe(
          this.logger.debug('Downloading attachment', { attachmentId }),
          Effect.flatMap(() => this.makeRawRequest(url)),
          Effect.tap(() => this.logger.debug('Attachment downloaded successfully', { attachmentId })),
        );
      }),
    );
  }

  uploadAttachment(pageId: string, file: globalThis.File, comment?: string): Effect.Effect<Attachment, AllErrors> {
    return pipe(
      validatePageId(pageId),
      Effect.flatMap(() => {
        const formData = new globalThis.FormData();
        formData.append('file', file);
        if (comment) {
          formData.append('comment', comment);
        }

        const url = `${this.baseUrl}/content/${pageId}/child/attachment`;

        return pipe(
          this.logger.debug('Uploading attachment', { pageId, fileName: file.name }),
          Effect.flatMap(() => this.makeFormRequest<unknown>(url, formData)),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                const result = data as { results: unknown[] };
                return Schema.decodeUnknownSync(AttachmentSchema)(result.results[0]);
              },
              catch: (error) => new ParseError('Failed to parse upload response', 'attachment', String(data), error),
            }),
          ),
          Effect.tap((attachment) =>
            this.logger.info('Attachment uploaded successfully', { pageId, attachmentId: attachment.id }),
          ),
        );
      }),
    );
  }

  // ============= Private Helper Methods =============
  private makeRequest<T>(
    url: string,
    options: RequestInit = {},
  ): Effect.Effect<
    T,
    NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ParseError | ConfigError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = getAuthHeaders(config);

        return pipe(
          this.http.request<T>(url, {
            ...options,
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              ...options.headers,
            },
          }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(createRetrySchedule()),
        ) as Effect.Effect<
          T,
          NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ParseError | ConfigError,
          never
        >;
      }),
    );
  }

  private makeRawRequest(
    url: string,
  ): Effect.Effect<
    ArrayBuffer,
    NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = getAuthHeaders(config);

        return pipe(
          this.http.request<ArrayBuffer>(url, { headers }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(createRetrySchedule()),
        ) as Effect.Effect<
          ArrayBuffer,
          NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError,
          never
        >;
      }),
    );
  }

  private makeFormRequest<T>(
    url: string,
    formData: globalThis.FormData,
  ): Effect.Effect<
    T,
    NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const headers = getAuthHeaders(config);
        // Don't set Content-Type for FormData - let the browser set it with boundary
        delete headers['Content-Type'];

        return pipe(
          this.http.request<T>(url, {
            method: 'POST',
            headers,
            body: formData,
          }),
          Effect.mapError(this.mapHttpError),
          Effect.retry(createRetrySchedule()),
        ) as Effect.Effect<
          T,
          NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError,
          never
        >;
      }),
    );
  }

  private mapHttpError = (
    error: unknown,
  ): NetworkError | AuthenticationError | NotFoundError | RateLimitError | TimeoutError | ConfigError => {
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
}
