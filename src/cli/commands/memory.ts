import { Effect } from 'effect';
import chalk from 'chalk';

export async function addMemory(fact: string) {
  console.log(chalk.yellow(`addMemory "${fact}" - Not yet implemented`));
}

export async function listMemories() {
  console.log(chalk.yellow('listMemories - Not yet implemented'));
}

export async function deleteMemory(id: string) {
  console.log(chalk.yellow(`deleteMemory ${id} - Not yet implemented`));
}

export async function showMemoryStats() {
  console.log(chalk.yellow('showMemoryStats - Not yet implemented'));
}

export async function clearMemories(all?: boolean) {
  console.log(chalk.yellow(`clearMemories ${all ? 'all' : ''} - Not yet implemented`));
}