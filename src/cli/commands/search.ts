import { Effect } from 'effect';
import chalk from 'chalk';

export async function search(query: string, options: { 
  source?: 'jira' | 'confluence',
  limit?: number,
  includeAll?: boolean
}) {
  console.log(chalk.yellow(`search "${query}" - Not yet implemented`));
}

export async function ask(question: string) {
  console.log(chalk.yellow(`ask "${question}" - Not yet implemented`));
}