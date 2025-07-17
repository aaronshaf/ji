import type { Config } from './config.js';
import { JiraClientBase } from './jira-client/jira-client-base.js';
import { JiraClientBoards } from './jira-client/jira-client-boards.js';
import { JiraClientComments } from './jira-client/jira-client-comments.js';
import { JiraClientIssues } from './jira-client/jira-client-issues.js';
import { JiraClientSprints } from './jira-client/jira-client-sprints.js';
import { JiraClientUsers } from './jira-client/jira-client-users.js';

// Re-export types for backward compatibility
export * from './jira-client/jira-client-types.js';

/**
 * Main JiraClient class that composes all client modules
 * This provides the same public API as before while internally using the modular structure
 */
export class JiraClient extends JiraClientBase {
  private issuesClient: JiraClientIssues;
  private commentsClient: JiraClientComments;
  private boardsClient: JiraClientBoards;
  private sprintsClient: JiraClientSprints;
  private usersClient: JiraClientUsers;

  constructor(config: Config) {
    super(config);
    this.issuesClient = new JiraClientIssues(config);
    this.commentsClient = new JiraClientComments(config);
    this.boardsClient = new JiraClientBoards(config);
    this.sprintsClient = new JiraClientSprints(config);
    this.usersClient = new JiraClientUsers(config);
  }

  // ============= Issue Operations =============
  async getIssue(issueKey: string) {
    return this.issuesClient.getIssue(issueKey);
  }

  async searchIssues(jql: string, options?: { startAt?: number; maxResults?: number; fields?: string[] }) {
    return this.issuesClient.searchIssues(jql, options);
  }

  async getAllProjectIssues(projectKey: string, onProgress?: (current: number, total: number) => void, jql?: string) {
    return this.issuesClient.getAllProjectIssues(projectKey, onProgress, jql);
  }

  getIssueEffect(issueKey: string) {
    return this.issuesClient.getIssueEffect(issueKey);
  }

  searchIssuesEffect(jql: string, options?: { startAt?: number; maxResults?: number; fields?: string[] }) {
    return this.issuesClient.searchIssuesEffect(jql, options);
  }

  getAllProjectIssuesEffect(
    projectKey: string,
    options?: { jql?: string; onProgress?: (current: number, total: number) => void; maxConcurrency?: number },
  ) {
    return this.issuesClient.getAllProjectIssuesEffect(projectKey, options);
  }

  async getIssueTransitions(issueKey: string) {
    return this.issuesClient.getIssueTransitions(issueKey);
  }

  async transitionIssue(issueKey: string, transitionId: string) {
    return this.issuesClient.transitionIssue(issueKey, transitionId);
  }

  async closeIssue(issueKey: string) {
    return this.issuesClient.closeIssue(issueKey);
  }

  getIssueTransitionsEffect(issueKey: string) {
    return this.issuesClient.getIssueTransitionsEffect(issueKey);
  }

  transitionIssueEffect(issueKey: string, transitionId: string) {
    return this.issuesClient.transitionIssueEffect(issueKey, transitionId);
  }

  closeIssueEffect(issueKey: string) {
    return this.issuesClient.closeIssueEffect(issueKey);
  }

  async assignIssue(issueKey: string, accountId: string) {
    return this.issuesClient.assignIssue(issueKey, accountId);
  }

  assignIssueEffect(issueKey: string, accountId: string) {
    return this.issuesClient.assignIssueEffect(issueKey, accountId);
  }

  async getCustomFields() {
    return this.issuesClient.getCustomFields();
  }

  getCustomFieldsEffect() {
    return this.issuesClient.getCustomFieldsEffect();
  }

  // ============= Comment Operations =============
  async addComment(issueKey: string, comment: string) {
    return this.commentsClient.addComment(issueKey, comment);
  }

  addCommentEffect(issueKey: string, comment: string) {
    return this.commentsClient.addCommentEffect(issueKey, comment);
  }

  async getComments(issueKey: string) {
    return this.commentsClient.getComments(issueKey);
  }

  getCommentsEffect(issueKey: string) {
    return this.commentsClient.getCommentsEffect(issueKey);
  }

  // ============= Board Operations =============
  async getBoards(options?: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' }) {
    return this.boardsClient.getBoards(options);
  }

  async getBoardsForProject(projectKey: string) {
    return this.boardsClient.getBoardsForProject(projectKey);
  }

  async getUserActiveProjects(userEmail: string) {
    return this.boardsClient.getUserActiveProjects(userEmail);
  }

  async getUserBoards(userEmail: string) {
    return this.boardsClient.getUserBoards(userEmail);
  }

  async getBoardConfiguration(boardId: number) {
    return this.boardsClient.getBoardConfiguration(boardId);
  }

  async getBoardIssues(boardId: number) {
    return this.boardsClient.getBoardIssues(boardId);
  }

  getBoardsEffect(options?: { projectKeyOrId?: string; type?: 'scrum' | 'kanban' }) {
    return this.boardsClient.getBoardsEffect(options);
  }

  getUserBoardsEffect(userEmail: string) {
    return this.boardsClient.getUserBoardsEffect(userEmail);
  }

  getBoardIssuesEffect(boardId: number, options?: { maxResults?: number }) {
    return this.boardsClient.getBoardIssuesEffect(boardId, options);
  }

  // ============= Sprint Operations =============
  async getActiveSprints(boardId: number) {
    return this.sprintsClient.getActiveSprints(boardId);
  }

  async getSprintIssues(sprintId: number, options?: { startAt?: number; maxResults?: number }) {
    return this.sprintsClient.getSprintIssues(sprintId, options);
  }

  async getUserActiveSprints(userEmail: string) {
    return this.sprintsClient.getUserActiveSprints(userEmail);
  }

  getActiveSprintsEffect(boardId: number) {
    return this.sprintsClient.getActiveSprintsEffect(boardId);
  }

  getSprintIssuesEffect(sprintId: number, options?: { startAt?: number; maxResults?: number }) {
    return this.sprintsClient.getSprintIssuesEffect(sprintId, options);
  }

  getUserActiveSprintsEffect(userEmail: string) {
    return this.sprintsClient.getUserActiveSprintsEffect(userEmail);
  }

  // ============= User Operations =============
  async getCurrentUser() {
    return this.usersClient.getCurrentUser();
  }

  getCurrentUserEffect() {
    return this.usersClient.getCurrentUserEffect();
  }
}
