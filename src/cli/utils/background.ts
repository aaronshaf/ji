import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

export async function refreshInBackground(projectKey: string, issueKey: string) {
  console.log(`refreshInBackground ${projectKey} ${issueKey} - Not yet implemented`);
}

export async function refreshSprintInBackground(sprintId: string, _config: string) {
  console.log(`refreshSprintInBackground ${sprintId} - Not yet implemented`);
}

export async function syncMyIssuesInBackground(_email: string, projectFilter?: string) {
  const configManager = new ConfigManager();
  let cacheManager: CacheManager | null = null;

  try {
    const config = await configManager.getConfig();
    if (!config) {
      return; // Silent fail in background
    }

    cacheManager = new CacheManager();
    const jiraClient = new JiraClient(config);

    // Get projects to sync
    let projectKeys: string[] = [];
    if (projectFilter) {
      projectKeys = [projectFilter.toUpperCase()];
    } else {
      // Get all tracked projects
      const workspaces = await cacheManager.getActiveWorkspaces();
      projectKeys = workspaces.filter((w) => w.type === 'jira_project').map((w) => w.keyOrId);
    }

    // Sync issues for each project
    for (const projectKey of projectKeys) {
      try {
        const jql = `project = ${projectKey} AND assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)`;
        const searchResult = await jiraClient.searchIssues(jql);

        // Save each issue to cache
        for (const issue of searchResult.issues) {
          await cacheManager.saveIssue(issue);
        }
      } catch (_err) {
        // Silent fail - this is background sync
      }
    }
  } catch (_err) {
    // Silent fail - this is background sync
  } finally {
    if (cacheManager) {
      cacheManager.close();
    }
    configManager.close();
  }
}
