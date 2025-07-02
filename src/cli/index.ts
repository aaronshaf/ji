#!/usr/bin/env bun
import chalk from 'chalk';
import { auth } from './commands/auth.js';
import { showMyBoards } from './commands/board.js';
import { showRecentConfluencePages, viewConfluencePage } from './commands/confluence.js';
import { syncToMeilisearch } from './commands/index.js';
import { viewIssue } from './commands/issue.js';
import { addMemory, clearMemories, deleteMemory, listMemories, showMemoryStats } from './commands/memory.js';
import { showMyIssues, takeIssue } from './commands/mine.js';
import { configureModels } from './commands/models.js';
import { ask, search } from './commands/search.js';
import { initializeSetup } from './commands/setup.js';
import { showSprint } from './commands/sprint.js';
import { syncConfluence, syncJiraProject, syncWorkspaces } from './commands/sync.js';
import { refreshInBackground, refreshSprintInBackground } from './utils/background.js';

// Helper function to show usage
function showHelp() {
  console.log(`
${chalk.bold('ji - Jira & Confluence CLI')}

${chalk.yellow('Authentication:')}
  ji auth                              Set up Jira/Confluence authentication

${chalk.yellow('Issues:')}
  ji mine                              Show your open issues
  ji take <issue-key>                  Assign an issue to yourself
  ji <issue-key>                       View issue details
  ji issue view <issue-key>            View issue details (alias)
  ji issue sync <project-key>          Sync all issues from a project

${chalk.yellow('Boards & Sprints:')}
  ji board [project-key]               Show boards for a project
  ji sprint [project-key]              Show active sprint for a project

${chalk.yellow('Confluence:')}
  ji confluence sync <space-key>       Sync Confluence space
  ji confluence recent <space-key>     Show recent pages in a space
  ji confluence view <page-id>         View a Confluence page

${chalk.yellow('Search & AI:')}
  ji search <query>                    Search across Jira and Confluence
  ji ask "<question>"                  Ask a question about your content

${chalk.yellow('Memory:')}
  ji remember "<fact>"                 Add a fact to memory
  ji memories list                     List all memories
  ji memories delete <id>              Delete a memory
  ji memories stats                    Show memory statistics
  ji memories clear [--all]            Clear memories

${chalk.yellow('Sync & Index:')}
  ji sync                              Sync all active workspaces
  ji index                             Rebuild search index

${chalk.yellow('Setup:')}
  ji init                              Interactive setup wizard
  ji models                            Configure AI models

${chalk.gray('Examples:')}
  ji ABC-123                           View issue ABC-123
  ji mine                              Show your assigned issues
  ji search "login bug"                Search for login bugs
  ji ask "What are the deployment steps?"
  ji confluence sync WIKI              Sync the WIKI space
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const command = args[0];
  const subArgs = args.slice(1);

  try {
    // Internal commands (hidden from users)
    if (command === 'internal-refresh' && subArgs.length >= 2) {
      await refreshInBackground(subArgs[0], subArgs[1]);
      return;
    }

    if (command === 'internal-sprint-refresh' && subArgs.length >= 2) {
      await refreshSprintInBackground(subArgs[0], subArgs[1]);
      return;
    }

    // Main commands
    switch (command) {
      case 'auth':
        await auth();
        break;

      case 'init':
        await initializeSetup();
        break;

      case 'mine':
        await showMyIssues();
        break;

      case 'take':
        if (!subArgs[0]) {
          console.error('Please specify an issue key');
          process.exit(1);
        }
        await takeIssue(subArgs[0]);
        break;

      case 'issue':
        if (subArgs[0] === 'view' && subArgs[1]) {
          await viewIssue(subArgs[1], { json: args.includes('--json') });
        } else if (subArgs[0] === 'sync' && subArgs[1]) {
          await syncJiraProject(subArgs[1], { clean: args.includes('--clean') });
        } else {
          console.error('Invalid issue command. Use "ji issue view <key>" or "ji issue sync <project>"');
          process.exit(1);
        }
        break;

      case 'board':
        await showMyBoards(subArgs[0]);
        break;

      case 'sprint':
        await showSprint(subArgs[0]);
        break;

      case 'confluence':
        if (subArgs[0] === 'sync' && subArgs[1]) {
          await syncConfluence(subArgs[1], { clean: args.includes('--clean') });
        } else if (subArgs[0] === 'recent' && subArgs[1]) {
          const limit = subArgs[2] ? parseInt(subArgs[2]) : 10;
          await showRecentConfluencePages(subArgs[1], limit);
        } else if (subArgs[0] === 'view' && subArgs[1]) {
          await viewConfluencePage(subArgs[1]);
        } else {
          console.error('Invalid confluence command');
          process.exit(1);
        }
        break;

      case 'sync':
        await syncWorkspaces();
        break;

      case 'search': {
        if (!subArgs[0]) {
          console.error('Please provide a search query');
          process.exit(1);
        }
        const query = subArgs.join(' ');
        await search(query, {
          source: args.includes('--jira') ? 'jira' : args.includes('--confluence') ? 'confluence' : undefined,
          limit: 10,
          includeAll: args.includes('--all'),
        });
        break;
      }

      case 'ask': {
        if (!subArgs[0]) {
          console.error('Please provide a question');
          process.exit(1);
        }
        const question = subArgs.join(' ');
        await ask(question);
        break;
      }

      case 'remember': {
        if (!subArgs[0]) {
          console.error('Please provide a fact to remember');
          process.exit(1);
        }
        const fact = subArgs.join(' ');
        await addMemory(fact);
        break;
      }

      case 'memories':
        if (subArgs[0] === 'list') {
          await listMemories();
        } else if (subArgs[0] === 'delete' && subArgs[1]) {
          await deleteMemory(subArgs[1]);
        } else if (subArgs[0] === 'stats') {
          await showMemoryStats();
        } else if (subArgs[0] === 'clear') {
          await clearMemories(args.includes('--all'));
        } else {
          console.error('Invalid memories command');
          process.exit(1);
        }
        break;

      case 'models':
        await configureModels();
        break;

      case 'index':
        await syncToMeilisearch();
        break;

      default:
        // Check if it's an issue key (e.g., ABC-123)
        if (/^[A-Z]+-\d+$/.test(command)) {
          await viewIssue(command, { json: args.includes('--json') });
        } else {
          console.error(`Unknown command: ${command}`);
          console.log('Run "ji help" for usage information');
          process.exit(1);
        }
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

// Run the CLI
main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
