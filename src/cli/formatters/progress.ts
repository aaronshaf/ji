import chalk from 'chalk';

/**
 * Create ASCII progress bar
 */
export function createProgressBar(current: number, total: number, width: number = 20): string {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;

  const bar = chalk.green('█').repeat(filled) + chalk.gray('░').repeat(empty);
  return `${bar} ${percentage}%`;
}

/**
 * Get color function based on search score
 */
export function getScoreColor(score: number): (text: string) => string {
  if (score >= 90) return chalk.green;
  if (score >= 75) return chalk.yellow;
  if (score >= 60) return chalk.dim.yellow;
  return chalk.dim;
}
