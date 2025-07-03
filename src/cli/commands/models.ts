import chalk from 'chalk';
import { ConfigManager } from '../../lib/config.js';

export async function configureModels() {
  console.log(chalk.bold('\n🤖 Configure AI Models\n'));

  const configManager = new ConfigManager();

  try {
    // Get current settings
    const currentSettings = await configManager.getSettings();

    console.log(chalk.cyan('Current Settings:'));
    console.log(`  Ask Model: ${chalk.white(currentSettings.askModel || 'gemma2:latest (default)')}`);
    console.log(`  Embedding Model: ${chalk.white(currentSettings.embeddingModel || 'mxbai-embed-large (default)')}`);
    console.log(`  Analysis Model: ${chalk.white(currentSettings.analysisModel || 'gemma2:latest (default)')}`);

    console.log(chalk.dim('\nNote: You can modify these settings by editing ~/.ji/data.db directly or using sqlite3.'));

    console.log(chalk.yellow('\n💡 Available Models (install with ollama pull <model>):'));
    console.log(chalk.white('  Chat Models: gemma2:latest, llama3.1, qwen2.5, phi3.5'));
    console.log(chalk.white('  Embedding Models: mxbai-embed-large, nomic-embed-text, all-minilm'));

    console.log(chalk.yellow('\n📝 To Change Settings:'));
    console.log(
      chalk.white(
        "  sqlite3 ~/.ji/data.db \"INSERT OR REPLACE INTO config (key, value) VALUES ('askModel', 'llama3.1')\"",
      ),
    );
    console.log(
      chalk.white(
        "  sqlite3 ~/.ji/data.db \"INSERT OR REPLACE INTO config (key, value) VALUES ('embeddingModel', 'nomic-embed-text')\"",
      ),
    );
    console.log(
      chalk.white(
        "  sqlite3 ~/.ji/data.db \"INSERT OR REPLACE INTO config (key, value) VALUES ('analysisModel', 'phi3.5')\"",
      ),
    );

    console.log(chalk.yellow('\n⚠️  Requirements:'));
    console.log(chalk.red('  • Ensure Ollama is running: ollama serve'));
    console.log(chalk.red('  • Install models first: ollama pull <model-name>'));
  } finally {
    configManager.close();
  }
}
