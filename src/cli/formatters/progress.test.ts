import { describe, expect, it } from 'bun:test';
import chalk from 'chalk';
import { createProgressBar, getScoreColor } from './progress';

// Helper function to strip ANSI escape codes
function stripAnsiCodes(text: string): string {
  // Use String.fromCharCode to avoid control character in regex
  const esc = String.fromCharCode(27);
  const ansiRegex = new RegExp(`${esc}\\[[0-9;]*m`, 'g');
  return text.replace(ansiRegex, '');
}

describe('createProgressBar', () => {
  it('should create a progress bar with 0% progress', () => {
    const result = createProgressBar(0, 100, 10);
    // Strip ANSI codes for easier testing
    const stripped = stripAnsiCodes(result);
    expect(stripped).toBe('░░░░░░░░░░ 0%');
  });

  it('should create a progress bar with 50% progress', () => {
    const result = createProgressBar(50, 100, 10);
    const stripped = stripAnsiCodes(result);
    expect(stripped).toBe('█████░░░░░ 50%');
  });

  it('should create a progress bar with 100% progress', () => {
    const result = createProgressBar(100, 100, 10);
    const stripped = stripAnsiCodes(result);
    expect(stripped).toBe('██████████ 100%');
  });

  it('should handle custom width', () => {
    const result = createProgressBar(25, 100, 20);
    const stripped = stripAnsiCodes(result);
    expect(stripped).toBe('█████░░░░░░░░░░░░░░░ 25%');
  });

  it('should handle edge case of 0 total', () => {
    const result = createProgressBar(0, 0, 10);
    const stripped = stripAnsiCodes(result);
    // When total is 0, we get NaN% and no progress bar
    expect(stripped).toBe(' NaN%');
  });
});

describe('getScoreColor', () => {
  it('should return green color for high scores (>= 90)', () => {
    const colorFn = getScoreColor(95);
    expect(colorFn('test')).toBe(chalk.green('test'));
  });

  it('should return green color for score of exactly 90', () => {
    const colorFn = getScoreColor(90);
    expect(colorFn('test')).toBe(chalk.green('test'));
  });

  it('should return yellow color for good scores (75-89)', () => {
    const colorFn = getScoreColor(80);
    expect(colorFn('test')).toBe(chalk.yellow('test'));
  });

  it('should return yellow color for score of exactly 75', () => {
    const colorFn = getScoreColor(75);
    expect(colorFn('test')).toBe(chalk.yellow('test'));
  });

  it('should return dim yellow color for medium scores (60-74)', () => {
    const colorFn = getScoreColor(65);
    expect(colorFn('test')).toBe(chalk.dim.yellow('test'));
  });

  it('should return dim yellow color for score of exactly 60', () => {
    const colorFn = getScoreColor(60);
    expect(colorFn('test')).toBe(chalk.dim.yellow('test'));
  });

  it('should return dim color for low scores (< 60)', () => {
    const colorFn = getScoreColor(50);
    expect(colorFn('test')).toBe(chalk.dim('test'));
  });
});
