/**
 * Jira Project Operations Module
 * Contains all project-related operations extracted from jira-client-service.ts
 */

import { Duration, Effect, pipe, Schedule, Schema } from 'effect';
import {
  AuthenticationError,
  type ConfigError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.js';
import type { ConfigService, HttpClientService, LoggerService } from '../layers.js';
import { type Project, ProjectSchema } from './schemas.js';

// Re-export Project type for backward compatibility
export type { Project };

// ============= Project Operations Interface =============
export interface ProjectOperations {
  getProject(
    projectKey: string,
  ): Effect.Effect<
    Project,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  >;

  getAllProjects(): Effect.Effect<
    Project[],
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  >;
}

// ============= Project Operations Implementation =============
export class ProjectOperationsImpl implements ProjectOperations {
  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
  ) {}

  getProject(
    projectKey: string,
  ): Effect.Effect<
    Project,
    | ValidationError
    | NotFoundError
    | NetworkError
    | AuthenticationError
    | ParseError
    | TimeoutError
    | RateLimitError
    | ConfigError
  > {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() => this.config.getConfig),
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/project/${projectKey}`;

        return pipe(
          this.logger.debug('Fetching project', { projectKey }),
          Effect.flatMap(() => this.http.get<unknown>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(ProjectSchema)(data),
              catch: (error) => new ParseError('Failed to parse project response', 'project', String(data), error),
            }),
          ),
          Effect.tap(() => this.logger.debug('Project fetched successfully', { projectKey })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Project,
      | ValidationError
      | NotFoundError
      | NetworkError
      | AuthenticationError
      | ParseError
      | TimeoutError
      | RateLimitError
      | ConfigError,
      never
    >;
  }

  getAllProjects(): Effect.Effect<
    Project[],
    NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError
  > {
    return pipe(
      this.config.getConfig,
      Effect.flatMap((config) => {
        const url = `${config.jiraUrl}/rest/api/3/project`;

        return pipe(
          this.logger.debug('Fetching all projects'),
          Effect.flatMap(() => this.http.get<unknown[]>(url, this.getAuthHeaders(config))),
          Effect.mapError(this.mapHttpError),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => {
                if (!Array.isArray(data)) {
                  throw new Error('Projects response is not an array');
                }
                return data.map((project) => Schema.decodeUnknownSync(ProjectSchema)(project));
              },
              catch: (error) => new ParseError('Failed to parse projects response', 'projects', String(data), error),
            }),
          ),
          Effect.tap((projects) => this.logger.debug('All projects fetched successfully', { count: projects.length })),
          Effect.retry(this.createRetrySchedule()),
        );
      }),
    ) as Effect.Effect<
      Project[],
      NetworkError | AuthenticationError | ParseError | TimeoutError | RateLimitError | ConfigError | NotFoundError,
      never
    >;
  }

  // ============= Private Helper Methods =============
  private getAuthHeaders(config: { email: string; apiToken: string }): Record<string, string> {
    const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private mapHttpError = (
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

  private createRetrySchedule(): Schedule.Schedule<unknown, unknown, unknown> {
    return pipe(Schedule.exponential(Duration.millis(100)), Schedule.intersect(Schedule.recurs(3)), Schedule.jittered);
  }

  private validateProjectKey(projectKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!projectKey || projectKey.length === 0) {
        throw new ValidationError('Project key cannot be empty', 'projectKey', projectKey);
      }
      if (!/^[A-Z][A-Z0-9]*$/.test(projectKey)) {
        throw new ValidationError('Invalid project key format', 'projectKey', projectKey);
      }
    });
  }
}
