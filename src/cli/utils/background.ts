import { Effect } from 'effect';
import chalk from 'chalk';

export async function refreshInBackground(projectKey: string, issueKey: string) {
  console.log(chalk.yellow(`refreshInBackground ${projectKey} ${issueKey} - Not yet implemented`));
}

export async function refreshSprintInBackground(sprintId: string, config: string) {
  console.log(chalk.yellow(`refreshSprintInBackground ${sprintId} - Not yet implemented`));
}