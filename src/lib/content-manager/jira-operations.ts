/**
 * Jira-specific operations for content management
 */

import type { Database } from 'bun:sqlite';
import { Effect, pipe } from 'effect';
import { type ContentError, type ContentTooLargeError, QueryError, ValidationError } from '../effects/errors.js';
import type { Issue } from '../jira-client.js';
import type { ADFNode } from './types.js';

/**
 * Effect-based save Jira issue with validation and transaction support
 */
export function saveJiraIssueEffect(
  db: Database,
  issue: Issue,
): Effect.Effect<void, ValidationError | QueryError | ContentError | ContentTooLargeError> {
  return pipe(
    // Validate issue
    Effect.sync(() => {
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
    }),
    Effect.flatMap(() => {
      const projectKey = issue.key.split('-')[0];
      const sprintInfo = extractSprintInfo(issue);

      return Effect.try(() => {
        // Use transaction for atomicity
        db.transaction(() => {
          // Save project
          const projectStmt = db.prepare('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)');
          projectStmt.run(projectKey, projectKey);

          // Save issue
          const issueStmt = db.prepare(`
            INSERT OR REPLACE INTO issues (
              key, project_key, summary, status, priority,
              assignee_name, assignee_email, reporter_name, reporter_email,
              created, updated, description, raw_data, synced_at,
              sprint_id, sprint_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          issueStmt.run(
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
            extractDescription(issue.fields.description as string | { content?: ADFNode[] } | null | undefined),
            JSON.stringify(issue),
            Date.now(),
            sprintInfo?.id || null,
            sprintInfo?.name || null,
          );
        })();
      }).pipe(Effect.mapError((error) => new QueryError(`Failed to save issue to database: ${error}`)));
    }),
  );
}

/**
 * Legacy async version of saveJiraIssue
 */
export async function saveJiraIssue(db: Database, issue: Issue): Promise<void> {
  const projectKey = issue.key.split('-')[0];

  // Save to issues table (existing logic)
  const projectStmt = db.prepare('INSERT OR IGNORE INTO projects (key, name) VALUES (?, ?)');
  projectStmt.run(projectKey, projectKey);

  // Extract sprint information from custom fields
  const sprintInfo = extractSprintInfo(issue);

  const issueStmt = db.prepare(`
    INSERT OR REPLACE INTO issues (
      key, project_key, summary, status, priority,
      assignee_name, assignee_email, reporter_name, reporter_email,
      created, updated, description, raw_data, synced_at,
      sprint_id, sprint_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  issueStmt.run(
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
    extractDescription(issue.fields.description as string | { content?: ADFNode[] } | null | undefined),
    JSON.stringify(issue),
    Date.now(),
    sprintInfo?.id || null,
    sprintInfo?.name || null,
  );
}

/**
 * Build searchable content from a Jira issue
 */
export function buildJiraContent(issue: Issue): string {
  const parts = [
    issue.fields.summary,
    `Status: ${issue.fields.status.name}`,
    issue.fields.priority ? `Priority: ${issue.fields.priority.name}` : '',
    issue.fields.assignee ? `Assignee: ${issue.fields.assignee.displayName}` : '',
    `Reporter: ${issue.fields.reporter.displayName}`,
    extractDescription(issue.fields.description as string | { content?: ADFNode[] } | null | undefined),
  ];

  return parts.filter(Boolean).join('\n');
}

/**
 * Extract description from various formats
 */
export function extractDescription(description: string | { content?: ADFNode[] } | null | undefined): string {
  if (typeof description === 'string') {
    return description;
  }

  if (description?.content) {
    return parseADF(description);
  }

  return '';
}

/**
 * Parse Atlassian Document Format to plain text
 */
export function parseADF(doc: { content?: ADFNode[] }): string {
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

/**
 * Extract sprint information from Jira issue
 */
export function extractSprintInfo(issue: Issue): { id: string; name: string } | null {
  // Sprint information is typically stored in customfield_10020 or similar
  // The format is usually an array of sprint strings
  const fields = issue.fields as Record<string, unknown>;

  // Note: Sprint detection now uses Jira Agile API directly instead of custom fields
  // since custom field IDs vary between Jira instances

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
        // Parse sprint string format: "com.atlassian.greenhopper.service.sprint.Sprint@1234[id=123,name=Sprint 1,...]"
        const idMatch = sprintString.match(/\[.*?id=(\d+)/i);
        const nameMatch = sprintString.match(/\[.*?name=([^,\]]+)/i);

        if (idMatch && nameMatch) {
          return {
            id: idMatch[1],
            name: nameMatch[1],
          };
        }
      } else if (typeof sprintString === 'object' && sprintString.id && sprintString.name) {
        // Sometimes it's already an object
        return {
          id: String(sprintString.id),
          name: sprintString.name,
        };
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
