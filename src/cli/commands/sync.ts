import chalk from 'chalk';

export async function syncWorkspaces(_options: { clean?: boolean } = {}) {
  console.log(chalk.yellow('syncWorkspaces - Not yet implemented'));
}

export async function syncJiraProject(projectKey: string, _options: { fresh?: boolean; clean?: boolean } = {}) {
  console.log(chalk.yellow(`syncJiraProject ${projectKey} - Not yet implemented`));
}

export async function syncConfluence(spaceKey: string, _options: { clean?: boolean } = {}) {
  console.log(chalk.yellow(`syncConfluence ${spaceKey} - Not yet implemented`));
}
