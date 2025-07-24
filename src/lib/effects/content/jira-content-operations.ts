/**
 * Jira-specific content operations
 */

import { Effect, type Option, pipe } from 'effect';
import type { Issue } from '../../jira-client.js';
import {
  type ContentError,
  type ContentTooLargeError,
  type DataIntegrityError,
  type ParseError,
  type QueryError,
  ValidationError,
} from '../errors.js';
import type { DatabaseService, LoggerService } from '../layers.js';
import type { ADFNode, SearchableContent, SprintInfo } from './types.js';

export interface JiraContentOperations {
  readonly saveJiraIssue: (
    issue: Issue,
  ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>;
  readonly getJiraIssue: (
    issueKey: string,
  ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>;
  readonly deleteProjectContent: (projectKey: string) => Effect.Effect<void, ValidationError | QueryError>;
  readonly validateIssue: (issue: Issue) => Effect.Effect<void, ValidationError>;
  readonly validateIssueKey: (issueKey: string) => Effect.Effect<void, ValidationError>;
  readonly validateProjectKey: (projectKey: string) => Effect.Effect<void, ValidationError>;
  readonly buildJiraContent: (issue: Issue) => string;
  readonly extractSprintInfo: (issue: Issue) => SprintInfo | null;
}

export class JiraContentOperationsImpl implements JiraContentOperations {
  constructor(
    private db: DatabaseService,
    private logger: LoggerService,
    private saveContent: (
      content: SearchableContent,
    ) => Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError>,
    private getContent: (
      id: string,
    ) => Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError>,
  ) {}

  saveJiraIssue(
    issue: Issue,
  ): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError | DataIntegrityError> {
    return pipe(
      this.validateIssue(issue),
      Effect.flatMap(() => {
        const projectKey = issue.key.split('-')[0];
        const sprintInfo = this.extractSprintInfo(issue);
        const content = this.buildJiraContent(issue);

        return this.db.transaction(
          pipe(
            this.logger.debug('Saving Jira issue', { key: issue.key, projectKey }),
            // Save project
            Effect.flatMap(() =>
              this.db.execute('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)', [projectKey, projectKey]),
            ),
            // Save issue to issues table
            Effect.flatMap(() =>
              this.db.execute(
                `INSERT OR REPLACE INTO issues (
                  key, project_key, summary, status, priority,
                  assignee_name, assignee_email, reporter_name, reporter_email,
                  created, updated, description, raw_data, synced_at,
                  sprint_id, sprint_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  issue.key,
                  projectKey,
                  issue.fields.summary,
                  issue.fields.status.name,
                  issue.fields.priority?.name || null,
                  issue.fields.assignee?.displayName || null,
                  issue.fields.assignee?.emailAddress || null,
                  issue.fields.reporter.displayName,
                  issue.fields.reporter.emailAddress || null,
                  new Date(issue.fields.created).getTime(),
                  new Date(issue.fields.updated).getTime(),
                  this.extractDescription(
                    issue.fields.description as string | { content?: ADFNode[] } | null | undefined,
                  ),
                  JSON.stringify(issue),
                  Date.now(),
                  sprintInfo?.id || null,
                  sprintInfo?.name || null,
                ],
              ),
            ),
            // Save to searchable content
            Effect.flatMap(() =>
              this.saveContent({
                id: `jira:${issue.key}`,
                source: 'jira',
                type: 'issue',
                title: `${issue.key}: ${issue.fields.summary}`,
                content: content,
                url: `/browse/${issue.key}`,
                projectKey: projectKey,
                metadata: {
                  status: issue.fields.status.name,
                  priority: issue.fields.priority?.name,
                  assignee: issue.fields.assignee?.displayName,
                  reporter: issue.fields.reporter.displayName,
                },
                createdAt: new Date(issue.fields.created).getTime(),
                updatedAt: new Date(issue.fields.updated).getTime(),
                syncedAt: Date.now(),
              }),
            ),
            Effect.tap(() => this.logger.debug('Jira issue saved successfully', { key: issue.key })),
          ),
        );
      }),
    );
  }

  getJiraIssue(
    issueKey: string,
  ): Effect.Effect<Option.Option<SearchableContent>, ValidationError | QueryError | ParseError> {
    return pipe(
      this.validateIssueKey(issueKey),
      Effect.flatMap(() => this.getContent(`jira:${issueKey}`)),
    );
  }

  deleteProjectContent(projectKey: string): Effect.Effect<void, ValidationError | QueryError> {
    return pipe(
      this.validateProjectKey(projectKey),
      Effect.flatMap(() =>
        this.db.transaction(
          pipe(
            this.logger.debug('Deleting project content', { projectKey }),
            Effect.flatMap(() => this.db.execute('DELETE FROM issues WHERE project_key = ?', [projectKey])),
            Effect.flatMap(() =>
              this.db.execute('DELETE FROM searchable_content WHERE project_key = ? AND source = ?', [
                projectKey,
                'jira',
              ]),
            ),
            Effect.flatMap(() =>
              this.db.execute(
                'DELETE FROM content_fts WHERE id IN (SELECT id FROM searchable_content WHERE project_key = ? AND source = ?)',
                [projectKey, 'jira'],
              ),
            ),
            Effect.tap(() => this.logger.debug('Project content deleted successfully', { projectKey })),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }

  validateIssue(issue: Issue): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!issue || typeof issue !== 'object') {
        throw new ValidationError('Issue must be an object', 'issue', issue);
      }
      if (!issue.key || !issue.key.match(/^[A-Z]+-\d+$/)) {
        throw new ValidationError('Invalid issue key format', 'issue.key', issue.key);
      }
      if (!issue.fields) {
        throw new ValidationError('Issue must have fields', 'issue.fields', undefined);
      }
      if (!issue.fields.summary) {
        throw new ValidationError('Issue must have a summary', 'issue.fields.summary', undefined);
      }
      if (!issue.fields.status?.name) {
        throw new ValidationError('Issue must have a status', 'issue.fields.status', issue.fields.status);
      }
      if (!issue.fields.reporter?.displayName) {
        throw new ValidationError('Issue must have a reporter', 'issue.fields.reporter', issue.fields.reporter);
      }
    });
  }

  validateIssueKey(issueKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!issueKey || !issueKey.match(/^[A-Z]+-\d+$/)) {
        throw new ValidationError('Invalid issue key format', 'issueKey', issueKey);
      }
    });
  }

  validateProjectKey(projectKey: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!projectKey || projectKey.length === 0) {
        throw new ValidationError('Project key cannot be empty', 'projectKey', projectKey);
      }
    });
  }

  buildJiraContent(issue: Issue): string {
    const parts = [
      issue.fields.summary,
      `Status: ${issue.fields.status.name}`,
      issue.fields.priority ? `Priority: ${issue.fields.priority.name}` : '',
      issue.fields.assignee ? `Assignee: ${issue.fields.assignee.displayName}` : '',
      `Reporter: ${issue.fields.reporter.displayName}`,
      this.extractDescription(issue.fields.description as string | { content?: ADFNode[] } | null | undefined),
    ];

    return parts.filter(Boolean).join('\n');
  }

  extractSprintInfo(issue: Issue): SprintInfo | null {
    // Sprint information is typically stored in customfield_10020 or similar
    const fields = issue.fields as Record<string, unknown>;

    // Common sprint field names
    const sprintFieldNames = [
      'customfield_10020', // Most common
      'customfield_10021',
      'customfield_10016',
      'sprint',
      'sprints',
    ];

    for (const fieldName of sprintFieldNames) {
      const sprintData = fields[fieldName];
      if (!sprintData) continue;

      // Handle array of sprints (take the most recent/active one)
      if (Array.isArray(sprintData) && sprintData.length > 0) {
        const sprintString = sprintData[sprintData.length - 1];
        if (typeof sprintString === 'string') {
          // Parse sprint string format
          const idMatch = sprintString.match(/\[.*?id=(\d+)/i);
          const nameMatch = sprintString.match(/\[.*?name=([^,\]]+)/i);

          if (idMatch && nameMatch) {
            return {
              id: idMatch[1],
              name: nameMatch[1],
            };
          }
        } else if (typeof sprintString === 'object' && sprintString !== null) {
          const sprint = sprintString as { id?: unknown; name?: unknown };
          if (sprint.id && sprint.name) {
            return {
              id: String(sprint.id),
              name: String(sprint.name),
            };
          }
        }
      }

      // Handle single sprint object
      if (typeof sprintData === 'object' && sprintData !== null) {
        const sprint = sprintData as { id?: unknown; name?: unknown };
        if (sprint.id && sprint.name) {
          return {
            id: String(sprint.id),
            name: String(sprint.name),
          };
        }
      }
    }

    return null;
  }

  private extractDescription(description: string | { content?: ADFNode[] } | null | undefined): string {
    if (typeof description === 'string') {
      return description;
    }

    if (description?.content) {
      return this.parseADF(description);
    }

    return '';
  }

  private parseADF(doc: { content?: ADFNode[] }): string {
    let text = '';

    const parseNode = (node: ADFNode): string => {
      if (node.type === 'text') {
        return node.text || '';
      }

      if (node.type === 'paragraph' && node.content) {
        return `\n${node.content.map((n) => parseNode(n)).join('')}\n`;
      }

      if (node.content) {
        return node.content.map((n) => parseNode(n)).join('');
      }

      return '';
    };

    if (doc.content) {
      text = doc.content.map((node) => parseNode(node)).join('');
    }

    return text.trim();
  }
}
