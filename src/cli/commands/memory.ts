import chalk from 'chalk';
import { MemoryManager } from '../../lib/memory.js';
import { formatSmartDate } from '../../lib/utils/date-formatter.js';

export async function addMemory(fact: string) {
  try {
    const memoryManager = new MemoryManager();
    try {
      const success = memoryManager.addManualMemory(fact);
      if (success) {
        console.log(chalk.green('✓ Memory added successfully'));
      } else {
        console.log(chalk.yellow('Memory already exists or failed to add'));
      }
    } finally {
      memoryManager.close();
    }
  } catch (error) {
    console.error(chalk.red('Failed to add memory:'), error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function listMemories() {
  try {
    const memoryManager = new MemoryManager();
    try {
      const memories = memoryManager.listAllMemories(50);

      if (memories.length === 0) {
        console.log(chalk.dim('No memories found'));
        return;
      }

      // YAML output for LLM compatibility
      memories.forEach((memory, index) => {
        const isManual = memory.id.startsWith('manual_');
        const type = isManual ? 'manual' : 'extracted';
        console.log(chalk.cyan('- id:') + ` ${memory.id}`);
        console.log(chalk.cyan('  type:') + ` ${type}`);
        console.log(chalk.cyan('  fact:') + ` ${memory.keyFacts}`);
        console.log(chalk.cyan('  confidence:') + ` ${memory.confidence}`);
        console.log(chalk.cyan('  created:') + ` ${chalk.dim(formatSmartDate(memory.createdAt))}`);
        console.log(
          chalk.cyan('  accessed:') +
            ` ${chalk.dim(formatSmartDate(memory.lastAccessed))} (${memory.accessCount} times)`,
        );

        if (index < memories.length - 1) {
          console.log();
        }
      });
    } finally {
      memoryManager.close();
    }
  } catch (error) {
    console.error(chalk.red('Failed to list memories:'), error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function deleteMemory(id: string) {
  try {
    const memoryManager = new MemoryManager();
    try {
      const success = memoryManager.deleteMemory(id);
      if (success) {
        console.log(chalk.green('✓ Memory deleted successfully'));
      } else {
        console.log(chalk.yellow('Memory not found or failed to delete'));
      }
    } finally {
      memoryManager.close();
    }
  } catch (error) {
    console.error(chalk.red('Failed to delete memory:'), error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function showMemoryStats() {
  try {
    const memoryManager = new MemoryManager();
    try {
      const stats = memoryManager.getMemoryStats();

      // YAML output
      console.log(chalk.cyan('total_memories:') + ` ${stats.total}`);
      console.log(chalk.cyan('recent_memories:') + ` ${stats.recent} (accessed in last week)`);

      if (stats.total > 0) {
        const recentPercentage = Math.round((stats.recent / stats.total) * 100);
        console.log(chalk.cyan('recent_percentage:') + ` ${recentPercentage}%`);
      }
    } finally {
      memoryManager.close();
    }
  } catch (error) {
    console.error(chalk.red('Failed to get memory stats:'), error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function clearMemories(all?: boolean) {
  try {
    const memoryManager = new MemoryManager();
    try {
      let cleared = 0;

      if (all) {
        cleared = memoryManager.clearAllMemories();
        if (cleared >= 0) {
          console.log(chalk.green(`✓ Cleared ${cleared} total memories`));
        } else {
          console.log(chalk.red('Failed to clear memories'));
        }
      } else {
        cleared = memoryManager.clearManualMemories();
        if (cleared >= 0) {
          console.log(chalk.green(`✓ Cleared ${cleared} manual memories`));
        } else {
          console.log(chalk.red('Failed to clear manual memories'));
        }
      }
    } finally {
      memoryManager.close();
    }
  } catch (error) {
    console.error(chalk.red('Failed to clear memories:'), error instanceof Error ? error.message : 'Unknown error');
  }
}
