import { Effect } from 'effect';
import chalk from 'chalk';

export async function syncWorkspaces(options: { clean?: boolean } = {}) {
  console.log(chalk.yellow('syncWorkspaces - Not yet implemented'));
}

export async function syncJiraProject(projectKey: string, options: { fresh?: boolean; clean?: boolean } = {}) {
  console.log(chalk.yellow(`syncJiraProject ${projectKey} - Not yet implemented`));
}

export async function syncConfluence(spaceKey: string, options: { clean?: boolean } = {}) {
  console.log(chalk.yellow(`syncConfluence ${spaceKey} - Not yet implemented`));
}