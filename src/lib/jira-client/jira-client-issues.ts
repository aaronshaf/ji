import { Effect } from 'effect';
import type { Config } from '../config.js';
import { JiraClientIssuesRead } from './jira-client-issues-read.js';
import { JiraClientIssuesMutations } from './jira-client-issues-mutations.js';
import type { AuthenticationError, Issue, NetworkError, NotFoundError, ValidationError } from './jira-client-types.js';

/**
 * Unified Jira client for issue operations
 * Composes read and mutation operations into a single interface
 */
export class JiraClientIssues {
  private readOps: JiraClientIssuesRead;
  private mutationOps: JiraClientIssuesMutations;

  constructor(config: Config) {
    this.readOps = new JiraClientIssuesRead(config);
    this.mutationOps = new JiraClientIssuesMutations(config);
  }

  // ============= Read Operations =============

  async getIssue(issueKey: string): Promise<Issue> {
    return this.readOps.getIssue(issueKey);
  }

  async searchIssues(
    jql: string,
    options?: {
      startAt?: number;
      maxResults?: number;
      fields?: string[];
    },
  ): Promise<{ issues: Issue[]; total: number; startAt: number }> {
    return this.readOps.searchIssues(jql, options);
  }

  async getAllProjectIssues(
    projectKey: string,
    onProgress?: (current: number, total: number) => void,
    jql?: string,
  ): Promise<Issue[]> {
    return this.readOps.getAllProjectIssues(projectKey, onProgress, jql);
  }

  async getIssueTransitions(issueKey: string): Promise<Array<{ id: string; name: string }>> {
    return this.readOps.getIssueTransitions(issueKey);
  }

  async getCustomFields(): Promise<Array<{ id: string; name: string; description?: string; type: string }>> {
    return this.readOps.getCustomFields();
  }

  // ============= Mutation Operations =============

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    return this.mutationOps.transitionIssue(issueKey, transitionId);
  }

  async closeIssue(issueKey: string): Promise<void> {
    return Effect.runPromise(
      this.mutationOps.closeIssueEffect(issueKey, this.readOps.getIssueTransitionsEffect.bind(this.readOps)),
    );
  }

  async assignIssue(issueKey: string, accountId: string): Promise<void> {
    return this.mutationOps.assignIssue(issueKey, accountId);
  }

  // ============= Effect-based Read Operations =============

  getIssueEffect(
    issueKey: string,
  ): Effect.Effect<Issue, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return this.readOps.getIssueEffect(issueKey);
  }

  searchIssuesEffect(
    jql: string,
    options?: {
      startAt?: number;
      maxResults?: number;
      fields?: string[];
    },
  ): Effect.Effect<
    { issues: Issue[]; total: number; startAt: number },
    ValidationError | NetworkError | AuthenticationError
  > {
    return this.readOps.searchIssuesEffect(jql, options);
  }

  getAllProjectIssuesEffect(
    projectKey: string,
    options?: {
      jql?: string;
      onProgress?: (current: number, total: number) => void;
      maxConcurrency?: number;
    },
  ): Effect.Effect<Issue[], ValidationError | NetworkError | AuthenticationError> {
    return this.readOps.getAllProjectIssuesEffect(projectKey, options);
  }

  getIssueTransitionsEffect(
    issueKey: string,
  ): Effect.Effect<
    Array<{ id: string; name: string }>,
    ValidationError | NotFoundError | NetworkError | AuthenticationError
  > {
    return this.readOps.getIssueTransitionsEffect(issueKey);
  }

  getCustomFieldsEffect(): Effect.Effect<
    Array<{ id: string; name: string; description?: string; type: string }>,
    NetworkError | AuthenticationError
  > {
    return this.readOps.getCustomFieldsEffect();
  }

  // ============= Effect-based Mutation Operations =============

  transitionIssueEffect(
    issueKey: string,
    transitionId: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return this.mutationOps.transitionIssueEffect(issueKey, transitionId);
  }

  closeIssueEffect(
    issueKey: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return this.mutationOps.closeIssueEffect(issueKey, this.readOps.getIssueTransitionsEffect.bind(this.readOps));
  }

  assignIssueEffect(
    issueKey: string,
    accountId: string,
  ): Effect.Effect<void, ValidationError | NotFoundError | NetworkError | AuthenticationError> {
    return this.mutationOps.assignIssueEffect(issueKey, accountId);
  }
}
