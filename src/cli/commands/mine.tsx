import chalk from 'chalk';
import { formatDistanceToNow } from 'date-fns';
import { Effect, pipe } from 'effect';
import { Box, render, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useState } from 'react';
import { CacheManager } from '../../lib/cache.js';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient, type Issue as JiraIssue } from '../../lib/jira-client.js';

// Types
interface Issue {
  key: string;
  project_key: string;
  summary: string;
  status: string;
  priority: string;
  assignee_name: string | null;
  updated: string | number; // Can be ISO string from API or timestamp from cache
}

interface GroupedIssues {
  [projectKey: string]: Issue[];
}

interface AppProps {
  email: string;
  jiraClient: JiraClient;
  cacheManager: CacheManager;
  configManager: ConfigManager;
  projectFilter?: string;
}

// Helper to get status color
const getStatusColor = (status: string): string => {
  const statusLower = status.toLowerCase();
  if (statusLower.includes('progress') || statusLower.includes('development')) {
    return 'blue';
  } else if (statusLower.includes('review') || statusLower.includes('feedback')) {
    return 'magenta';
  } else if (statusLower.includes('done') || statusLower.includes('complete')) {
    return 'green';
  } else if (statusLower.includes('blocked')) {
    return 'red';
  } else if (statusLower.includes('todo') || statusLower.includes('open')) {
    return 'yellow';
  }
  return 'white';
};

// Issue display component
const IssueDisplay: React.FC<{ issue: Issue }> = ({ issue }) => {
  const statusColor = getStatusColor(issue.status);
  // Handle both timestamp numbers and ISO date strings
  const updatedDate = typeof issue.updated === 'number' ? new Date(issue.updated) : new Date(issue.updated);
  const updatedTime = formatDistanceToNow(updatedDate, { addSuffix: true });

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text dimColor>- key:</Text> <Text bold>{issue.key}</Text>
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text dimColor>title:</Text> {issue.summary}
        </Text>
        <Text>
          <Text dimColor>status:</Text> <Text color={statusColor}>{issue.status}</Text>
        </Text>
        <Text>
          <Text dimColor>updated:</Text> <Text dimColor>{updatedTime}</Text>
        </Text>
      </Box>
    </Box>
  );
};

// Project display component
const ProjectDisplay: React.FC<{ projectKey: string; issues: Issue[]; isLast?: boolean }> = ({
  projectKey,
  issues,
  isLast,
}) => {
  return (
    <Box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      <Text>
        <Text color="cyan">- name:</Text> <Text bold>{projectKey}</Text>
      </Text>
      <Box marginLeft={2}>
        <Text color="cyan">issues:</Text>
      </Box>
      {issues.map((issue) => (
        <IssueDisplay key={issue.key} issue={issue} />
      ))}
    </Box>
  );
};

// Main app component
const MyIssuesApp: React.FC<AppProps> = ({ email, jiraClient, cacheManager, configManager, projectFilter }) => {
  const { exit } = useApp();
  const [cachedIssues, setCachedIssues] = useState<Issue[]>([]);
  const [freshIssues, setFreshIssues] = useState<Issue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cacheManager.close();
      configManager.close();
    };
  }, [cacheManager, configManager]);

  // Load cached data immediately
  useEffect(() => {
    const loadCachedData = async () => {
      try {
        const issues = await cacheManager.listMyOpenIssues(email);
        setCachedIssues(issues);
        setIsLoading(false);
      } catch (_err) {
        setError('Failed to load cached issues');
        setIsLoading(false);
      }
    };

    loadCachedData();
  }, [email, cacheManager]);

  // Fetch fresh data after showing cached
  useEffect(() => {
    if (!isLoading && cachedIssues.length > 0) {
      const fetchFreshData = async () => {
        setIsFetching(true);
        try {
          // Get all unique project keys
          let projectKeys = [...new Set(cachedIssues.map((i) => i.project_key))];

          // If project filter is specified, only fetch for that project
          if (projectFilter) {
            projectKeys = projectKeys.filter((key) => key === projectFilter.toUpperCase());
          }

          // Fetch fresh issues for each project
          const allFreshIssues: Issue[] = [];
          for (const projectKey of projectKeys) {
            try {
              // Using JQL to get my open issues for this project
              const jql = `project = ${projectKey} AND assignee = currentUser() AND status NOT IN (Closed, Done, Resolved)`;
              const searchResult = await jiraClient.searchIssues(jql);

              // Convert to our Issue format
              const projectIssues: Issue[] = searchResult.issues.map((jiraIssue: JiraIssue) => ({
                key: jiraIssue.key,
                project_key: projectKey,
                summary: jiraIssue.fields.summary,
                status: jiraIssue.fields.status.name,
                priority: jiraIssue.fields.priority?.name || 'None',
                assignee_name: jiraIssue.fields.assignee?.displayName || null,
                updated: jiraIssue.fields.updated,
              }));

              allFreshIssues.push(...projectIssues);
            } catch (err) {
              // Continue with other projects even if one fails
              console.error(`Failed to fetch issues for ${projectKey}:`, err);
            }
          }

          if (allFreshIssues.length > 0) {
            setFreshIssues(allFreshIssues);

            // Update cache with fresh data
            for (const issue of allFreshIssues) {
              try {
                // Get full issue details to save to cache
                const fullIssue = await jiraClient.getIssue(issue.key);
                await cacheManager.saveIssue(fullIssue);
              } catch (_err) {
                // Continue even if cache update fails
              }
            }
          }
        } catch (_err) {
          // Silently fail - we already have cached data
        } finally {
          setIsFetching(false);
          // Exit after a short delay to show the updated status
          setTimeout(() => exit(), 1000);
        }
      };

      fetchFreshData();
    }
  }, [isLoading, cachedIssues, email, jiraClient, cacheManager, exit, projectFilter]);

  // Helper to get priority order
  const getPriorityOrder = (priority: string): number => {
    const priorityMap: Record<string, number> = {
      Highest: 1,
      High: 2,
      P1: 1, // Jira shorthand
      P2: 2,
      Medium: 3,
      P3: 3,
      Low: 4,
      P4: 4,
      Lowest: 5,
      P5: 5,
      None: 6,
      'Unassigned!': 7, // Your specific case
    };
    return priorityMap[priority] || 8; // Unknown priorities go to the end
  };

  // Sort issues by priority and then by updated date
  const sortIssues = (issues: Issue[]): Issue[] => {
    const sorted = [...issues].sort((a, b) => {
      // First sort by priority
      const priorityDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
      if (priorityDiff !== 0) return priorityDiff;

      // Then sort by updated date (most recent first)
      // Handle both timestamp numbers and ISO date strings
      const aTime = typeof a.updated === 'number' ? a.updated : new Date(a.updated).getTime();
      const bTime = typeof b.updated === 'number' ? b.updated : new Date(b.updated).getTime();
      return bTime - aTime;
    });

    return sorted;
  };

  // Group issues by project
  const groupIssuesByProject = (issues: Issue[]): GroupedIssues => {
    const grouped = issues.reduce((acc, issue) => {
      if (!acc[issue.project_key]) {
        acc[issue.project_key] = [];
      }
      acc[issue.project_key].push(issue);
      return acc;
    }, {} as GroupedIssues);

    // Sort issues within each project
    Object.keys(grouped).forEach((key) => {
      grouped[key] = sortIssues(grouped[key]);
    });

    return grouped;
  };

  let displayIssues = freshIssues.length > 0 ? freshIssues : cachedIssues;

  // Apply project filter if specified
  if (projectFilter) {
    displayIssues = displayIssues.filter((issue) => issue.project_key === projectFilter.toUpperCase());
  }

  // Exit when there are no issues and we're not loading
  useEffect(() => {
    if (!isLoading && displayIssues.length === 0) {
      setTimeout(() => exit(), 100);
    }
  }, [isLoading, displayIssues.length, exit]);

  // Exit on error
  useEffect(() => {
    if (error) {
      setTimeout(() => exit(), 100);
    }
  }, [error, exit]);

  if (isLoading) {
    return (
      <Box>
        <Text color="green">
          <Spinner type="dots" />
        </Text>
        <Text> Loading issues...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  if (displayIssues.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No open issues assigned to you{projectFilter ? ` in project ${projectFilter.toUpperCase()}` : ''}.</Text>
        <Text dimColor>💡 Run "ji sync" to update your workspaces.</Text>
      </Box>
    );
  }

  const groupedIssues = groupIssuesByProject(displayIssues);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          projects:
        </Text>
        {isFetching && (
          <Box marginLeft={2}>
            <Text dimColor>
              <Spinner type="dots" />
            </Text>
            <Text dimColor> updating...</Text>
          </Box>
        )}
      </Box>

      {Object.entries(groupedIssues)
        .sort(([a], [b]) => a.localeCompare(b)) // Sort projects alphabetically
        .map(([projectKey, issues], index, array) => (
          <ProjectDisplay
            key={projectKey}
            projectKey={projectKey}
            issues={issues}
            isLast={index === array.length - 1}
          />
        ))}
    </Box>
  );
};

// Effect wrapper for getting configuration
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        return { config, configManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Main effect for showing my issues
const showMyIssuesEffect = (projectFilter?: string) =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) =>
      Effect.sync(() => {
        const cacheManager = new CacheManager();
        const jiraClient = new JiraClient(config);

        // Render the Ink app
        render(
          <MyIssuesApp
            email={config.email}
            jiraClient={jiraClient}
            cacheManager={cacheManager}
            configManager={configManager}
            projectFilter={projectFilter}
          />,
        );
      }),
    ),
    Effect.catchAll((error) =>
      pipe(
        Effect.sync(() => {
          console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
        }),
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );

export async function showMyIssues(projectFilter?: string) {
  try {
    await Effect.runPromise(showMyIssuesEffect(projectFilter));
  } catch (_error) {
    process.exit(1);
  }
}

// Export the takeIssue function
export { takeIssue } from './mine-take.js';
