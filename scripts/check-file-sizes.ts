#!/usr/bin/env bun
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';

interface FileSize {
  path: string;
  lines: number;
  size: number;
}

const LIMITS = {
  warning: { ts: 500, tsx: 300, any: 1000 },
  blocking: { ts: 1300, tsx: 500, any: 1500 },
};

async function checkFileSize(filePath: string): Promise<FileSize> {
  const content = await Bun.file(filePath).text();
  const lines = content.split('\n').length;
  const size = content.length;

  return { path: filePath, lines, size };
}

async function scanDirectory(dir: string): Promise<FileSize[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: FileSize[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...(await scanDirectory(fullPath)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(await checkFileSize(fullPath));
    }
  }

  return results;
}

async function main() {
  console.log('📏 Checking file sizes...');

  const files = await scanDirectory('src');
  let hasWarnings = false;
  let hasBlocking = false;

  for (const file of files) {
    const ext = file.path.endsWith('.tsx') ? 'tsx' : 'ts';
    const warningLimit = LIMITS.warning[ext];
    const blockingLimit = LIMITS.blocking[ext];

    if (file.lines > blockingLimit) {
      console.log(chalk.red(`❌ BLOCKING: ${file.path} (${file.lines} lines, limit: ${blockingLimit})`));
      hasBlocking = true;
    } else if (file.lines > warningLimit) {
      console.log(chalk.yellow(`⚠️  WARNING: ${file.path} (${file.lines} lines, limit: ${warningLimit})`));
      hasWarnings = true;
    }
  }

  if (hasBlocking) {
    console.log(chalk.red('\n❌ Some files exceed blocking size limits!'));
    console.log(chalk.yellow('Consider splitting large files into smaller modules.'));
    process.exit(1);
  }

  if (hasWarnings) {
    console.log(chalk.yellow('\n⚠️  Some files are approaching size limits.'));
    console.log(chalk.gray('Consider refactoring if they grow further.'));
  } else {
    console.log(chalk.green('\n✅ All files are within size limits.'));
  }
}

main().catch(console.error);
