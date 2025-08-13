#!/usr/bin/env bun
import chalk from 'chalk';
import { auth } from './commands/auth.js';
import { showMyBoards } from './commands/board.js';
import { addComment } from './commands/comment.js';
import { configureCustomFields } from './commands/config.js';
import { showRecentConfluencePages, viewConfluencePage } from './commands/confluence.js';
import { markIssueDone } from './commands/done.js';
import { viewIssue } from './commands/issue.js';
import { showIssueLog } from './commands/log.js';
import { addMemory, clearMemories, deleteMemory, listMemories, showMemoryStats } from './commands/memory.js';
import { showMyIssues, takeIssue } from './commands/mine.js';
import { configureModels } from './commands/models.js';
import { openCommand } from './commands/open.js';
import { ask, search } from './commands/search.js';
import { initializeSetup } from './commands/setup.js';
import { showSprint } from './commands/sprint.js';
import { syncConfluence, syncJiraProject, syncWorkspaces } from './commands/sync.js';
import { testCommand } from './commands/test.js';
import { refreshInBackground, refreshSprintInBackground, syncMyIssuesInBackground } from './utils/background.js';

// Command-specific help functions
function showSearchHelp() {
  console.log(`
${chalk.bold('ji search - Search across Jira and Confluence')}

${chalk.yellow('Usage:')}
  ji search <query> [options]

${chalk.yellow('Options:')}
  --limit=N, --limit N      Limit number of results (default: 10)
  --jira                    Search only Jira content
  --confluence              Search only Confluence content
  --all                     Include all results
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji search "login bug"
  ji search "deployment" --limit=5
  ji search "API documentation" --confluence
  ji search "EVAL-123"
`);
}

function showIssueHelp() {
  console.log(`
${chalk.bold('ji issue - Jira issue commands')}

${chalk.yellow('Usage:')}
  ji issue <subcommand> [options]

${chalk.yellow('Subcommands:')}
  view <issue-key>          View issue details
  sync <project-key>        Sync all issues from a project

${chalk.yellow('Options:')}
  --json                    Output in JSON format (for view)
  --local                   Use cached data instead of fetching from API
  --clean                   Clean sync - remove existing issues first
  --help                    Show this help message

${chalk.yellow('Note:')}
  By default, 'ji issue view' fetches fresh data from Jira.
  Use --local to view cached data for offline/faster access.

${chalk.yellow('Examples:')}
  ji issue view EVAL-123          # Fetches fresh data from Jira
  ji issue view EVAL-123 --local  # Uses cached data
  ji issue view EVAL-123 --json   # Fresh data in JSON format
  ji issue sync EVAL --clean      # Sync all issues from project
`);
}

function showSyncHelp() {
  console.log(`
${chalk.bold('ji sync - Synchronize Jira and Confluence data')}

${chalk.yellow('Usage:')}
  ji sync [options]

${chalk.yellow('Options:')}
  --clean                   Clean sync - remove existing data first
  --help                    Show this help message

${chalk.yellow('Description:')}
  Syncs all active workspaces (both Jira projects and Confluence spaces).
  Use --clean to perform a fresh sync, removing all existing data first.

${chalk.yellow('Examples:')}
  ji sync
  ji sync --clean
`);
}

function showConfluenceHelp() {
  console.log(`
${chalk.bold('ji confluence - Confluence commands')}

${chalk.yellow('Usage:')}
  ji confluence <subcommand> [options]

${chalk.yellow('Subcommands:')}
  sync <space-key>          Sync Confluence space
  recent <space-key> [N]    Show N recent pages (default: 10)
  view <page-id>            View a Confluence page

${chalk.yellow('Options:')}
  --clean                   Clean sync - remove existing pages first
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji confluence sync ENG
  ji confluence sync ENG --clean
  ji confluence recent ENG 20
  ji confluence view 12345
`);
}

function showMemoriesHelp() {
  console.log(`
${chalk.bold('ji memories - Memory management commands')}

${chalk.yellow('Usage:')}
  ji memories <subcommand> [options]

${chalk.yellow('Subcommands:')}
  list                      List all memories
  delete <id>               Delete a specific memory
  stats                     Show memory statistics
  clear [--all]             Clear memories (--all for complete reset)

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji memories list
  ji memories delete mem_12345
  ji memories stats
  ji memories clear --all
`);
}

function showBoardHelp() {
  console.log(`
${chalk.bold('ji board - Show Jira boards')}

${chalk.yellow('Usage:')}
  ji board [project-key] [options]

${chalk.yellow('Description:')}
  Shows boards for a specific project or all boards if no project is specified.
  By default, fetches fresh data from Jira API.
  Output is in XML format for better LLM parsing.

${chalk.yellow('Options:')}
  --local                   Use cached board data instead of fetching from API
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji board                  Show all boards (fresh data)
  ji board EVAL             Show boards for EVAL project (fresh data)
  ji board --local          Show all boards from cache
  ji board EVAL --local     Show EVAL boards from cache
`);
}

function showSprintHelp() {
  console.log(`
${chalk.bold('ji sprint - Show active sprint')}

${chalk.yellow('Usage:')}
  ji sprint [project-key] [options]

${chalk.yellow('Description:')}
  Shows the active sprint for a project. If no project is specified,
  shows sprints for all projects.
  By default, fetches fresh data from Jira API.
  Output is in XML format for better LLM parsing.

${chalk.yellow('Options:')}
  --unassigned              Show only unassigned issues
  --local                   Use cached data instead of fetching from API
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji sprint                 Show all active sprints
  ji sprint EVAL            Show active sprint for EVAL project
`);
}

function showMineHelp() {
  console.log(`
${chalk.bold('ji mine - Show your open issues')}

${chalk.yellow('Usage:')}
  ji mine [options]

${chalk.yellow('Description:')}
  Shows all issues assigned to you that are not closed.
  By default, fetches fresh data from Jira API.
  Output is in XML format for better LLM parsing (use --pretty for colored text).

${chalk.yellow('Options:')}
  --project <key>           Filter by project key (e.g., CFA, EVAL)
  --pretty                  Show colored text output instead of XML
  --local                   Use cached data instead of fetching from API
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji mine                   Show all your open issues
  ji mine --project CFA     Show only issues from project CFA
  ji mine --pretty          Show issues with colored formatting
`);
}

function showTakeHelp() {
  console.log(`
${chalk.bold('ji take - Assign an issue to yourself')}

${chalk.yellow('Usage:')}
  ji take <issue-key>

${chalk.yellow('Description:')}
  Assigns the specified issue to yourself.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji take EVAL-123
`);
}

function showCommentHelp() {
  console.log(`
${chalk.bold('ji comment - Add a comment to an issue')}

${chalk.yellow('Usage:')}
  ji comment <issue-key> [comment]

${chalk.yellow('Description:')}
  Add a comment to a Jira issue. Supports three modes:
  1. Inline: ji comment EVAL-123 "Fixed the issue"
  2. Editor: ji comment EVAL-123 (opens $EDITOR)
  3. Pipe: echo "Fixed" | ji comment EVAL-123

${chalk.yellow('Wiki Markup Formatting:')}
  ${chalk.dim('Text:')}     *bold* _italic_ +underline+ -strikethrough- {{monospace}}
  ${chalk.dim('Heading:')} h1. Title  h2. Subtitle  h3. Section
  ${chalk.dim('Lists:')}    * Bullet  # Numbered  ** Nested
  ${chalk.dim('Code:')}     {code:js}console.log('hi');{code}
  ${chalk.dim('Panels:')}  {note}Note{note}  {warning}Warning{warning}  {tip}Tip{tip}
  ${chalk.dim('Links:')}    [text|url]  [JIRA-123]  [~username]
  ${chalk.dim('Tables:')}   ||Header||  |Cell|

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ${chalk.dim('# Simple comment')}
  ji comment EVAL-123 "Deployed the fix to staging"
  
  ${chalk.dim('# Formatted comment')}
  ji comment EVAL-123 "*Fixed* the login bug in _auth.js_"
  
  ${chalk.dim('# From editor (opens $EDITOR)')}
  ji comment EVAL-123
  
  ${chalk.dim('# From pipe')}
  cat release-notes.md | ji comment EVAL-123
`);
}

function showDoneHelp() {
  console.log(`
${chalk.bold('ji done - Mark an issue as Done')}

${chalk.yellow('Usage:')}
  ji done <issue-key>

${chalk.yellow('Description:')}
  Moves a Jira issue to "Done" status by finding and applying the appropriate
  transition (Done, Closed, Resolved, Complete, etc.).

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji done EVAL-123          Mark issue EVAL-123 as Done
`);
}

function showOpenHelp() {
  console.log(`
${chalk.bold('ji open - Open a Jira issue in browser')}

${chalk.yellow('Usage:')}
  ji open <issue-key>

${chalk.yellow('Description:')}
  Opens the specified Jira issue in your default browser.
  Works on macOS, Linux, and Windows.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji open EVAL-123          Open issue EVAL-123 in browser
  ji open proj-456          Open issue PROJ-456 in browser
`);
}

function showLogHelp() {
  console.log(`
${chalk.bold('ji log - Interactive comment viewer and editor')}

${chalk.yellow('Usage:')}
  ji log <issue-key>

${chalk.yellow('Description:')}
  Shows all comments for an issue and enters interactive mode for adding new comments.
  Auto-refreshes every 2 minutes to show new comments from other users.
  Supports multi-line comments - paste or type content, then press Enter to submit.

${chalk.yellow('Interactive Commands:')}
  Type or paste comment and press Enter to post
  Type 'exit' to quit
  Type 'r' or 'refresh' to refresh comments
  Press Ctrl+C to quit

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji log EVAL-123           View and add comments to EVAL-123
`);
}

function showAskHelp() {
  console.log(`
${chalk.bold('ji ask - Ask questions about your content')}

${chalk.yellow('Usage:')}
  ji ask "<question>"

${chalk.yellow('Description:')}
  Uses AI to answer questions based on your synced Jira and Confluence content.
  Requires Ollama to be installed and running.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji ask "What are the deployment steps?"
  ji ask "How do I configure authentication?"
  ji ask "What issues are blocking the release?"
`);
}

function showRememberHelp() {
  console.log(`
${chalk.bold('ji remember - Add a fact to memory')}

${chalk.yellow('Usage:')}
  ji remember "<fact>"

${chalk.yellow('Description:')}
  Stores a fact or piece of information that will be used as context
  when answering questions with 'ji ask'.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji remember "Our staging environment is at staging.example.com"
  ji remember "The API key is stored in AWS Secrets Manager"
  ji remember "Deployments happen every Tuesday and Thursday"
`);
}

function showAuthHelp() {
  console.log(`
${chalk.bold('ji auth - Set up authentication')}

${chalk.yellow('Usage:')}
  ji auth

${chalk.yellow('Description:')}
  Interactive setup for Jira and Confluence authentication.
  Stores credentials securely in ~/.ji/auth.json

${chalk.yellow('Required Information:')}
  - Jira URL (e.g., https://company.atlassian.net)
  - Email address
  - API token (create at https://id.atlassian.com/manage/api-tokens)

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji auth
`);
}

function showInitHelp() {
  console.log(`
${chalk.bold('ji init - Interactive setup wizard')}

${chalk.yellow('Usage:')}
  ji init

${chalk.yellow('Description:')}
  Comprehensive setup wizard that guides you through:
  - Authentication setup
  - AI model configuration
  - Initial project/space sync

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji init
`);
}

function showModelsHelp() {
  console.log(`
${chalk.bold('ji models - Configure AI models')}

${chalk.yellow('Usage:')}
  ji models

${chalk.yellow('Description:')}
  View and configure AI model settings:
  - Ask Model: Model used for 'ji ask' questions
  - Embedding Model: Model for semantic search
  - Analysis Model: Model for query analysis
  
  Shows current configuration and provides guidance for making changes.

${chalk.yellow('Requirements:')}
  - Ollama must be installed and running
  - Models must be pulled with 'ollama pull <model>'

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji models                 View current AI model settings
`);
}

function showTestHelp() {
  console.log(`
${chalk.bold('ji test - Testing framework')}

${chalk.yellow('Usage:')}
  ji test [options]

${chalk.yellow('Options:')}
  --setup                   Configure environment-specific tests
  --help                    Show this help message

${chalk.yellow('Description:')}
  Comprehensive testing framework that validates all CLI commands.
  Use --setup to configure tests with real data from your environment.

${chalk.yellow('Examples:')}
  ji test --setup           Configure tests
  ji test                   Run all tests
`);
}

function showConfigHelp() {
  console.log(`
${chalk.bold('ji config - Discover available custom fields')}

${chalk.yellow('Usage:')}
  ji config

${chalk.yellow('Description:')}
  Discover custom fields available in your Jira instance.
  Shows acceptance criteria, story points, and other useful fields.
  All fields are automatically included in issue views - no configuration needed.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji config                 Discover available custom fields
`);
}

// Helper function to show usage
function showHelp() {
  console.log(`
${chalk.bold('ji - Jira & Confluence CLI')}

${chalk.yellow('Authentication:')}
  ji auth                              Set up Jira/Confluence authentication

${chalk.yellow('Issues:')}
  ji mine                              Show your open issues
  ji take <issue-key>                  Assign an issue to yourself
  ji done <issue-key>                  Mark an issue as Done
  ji open <issue-key>                  Open issue in browser
  ji comment <issue-key> [comment]     Add a comment to an issue
  ji log <issue-key>                   Interactive comment viewer/editor
  ji <issue-key>                       View issue (fetches fresh data)
  ji <issue-key> --local               View issue (cached data)
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
  ji search <query> [--limit=N]        Search across Jira and Confluence
  ji ask "<question>"                  Ask a question about your content

${chalk.yellow('Memory:')}
  ji remember "<fact>"                 Add a fact to memory
  ji memories list                     List all memories
  ji memories delete <id>              Delete a memory
  ji memories stats                    Show memory statistics
  ji memories clear [--all]            Clear memories

${chalk.yellow('Sync:')}
  ji sync                              Sync all active workspaces

${chalk.yellow('Setup:')}
  ji init                              Interactive setup wizard
  ji config                            Discover available custom fields  
  ji models                            Configure AI models

${chalk.yellow('Testing:')}
  ji test                              Run all configured tests
  ji test --setup                      Configure environment-specific tests

${chalk.yellow('Help:')}
  ji help                              Show this help message
  ji [command] --help                  Show help for a specific command

${chalk.gray('Examples:')}
  ji ABC-123                           View issue ABC-123
  ji mine                              Show your assigned issues
  ji search "login bug"                Search for login bugs
  ji search "Gradebook" --limit=3      Search with custom result limit
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

    if (command === 'internal-sync-mine' && subArgs.length >= 1) {
      await syncMyIssuesInBackground(subArgs[0], subArgs[1]);
      return;
    }

    // Main commands
    switch (command) {
      case 'auth':
        if (args.includes('--help')) {
          showAuthHelp();
          process.exit(0);
        }
        await auth();
        break;

      case 'init':
        if (args.includes('--help')) {
          showInitHelp();
          process.exit(0);
        }
        await initializeSetup();
        break;

      case 'mine': {
        if (args.includes('--help')) {
          showMineHelp();
          process.exit(0);
        }

        // Parse project filter
        let projectFilter: string | undefined;
        const projectIndex = args.findIndex((arg) => arg.startsWith('--project'));
        if (projectIndex !== -1) {
          const projectArg = args[projectIndex];
          if (projectArg.includes('=')) {
            // Format: --project=CFA
            projectFilter = projectArg.split('=')[1];
          } else if (projectIndex + 1 < args.length) {
            // Format: --project CFA
            projectFilter = args[projectIndex + 1];
          }
        }

        // Check for --pretty flag
        const pretty = args.includes('--pretty');
        const useLocal = args.includes('--local');

        await showMyIssues(projectFilter, pretty, useLocal);
        break;
      }

      case 'take':
        if (args.includes('--help')) {
          showTakeHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please specify an issue key');
          showTakeHelp();
          process.exit(1);
        }
        await takeIssue(subArgs[0]);
        break;

      case 'comment':
        if (args.includes('--help')) {
          showCommentHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please specify an issue key');
          showCommentHelp();
          process.exit(1);
        }
        // Pass the issue key and optional inline comment (all remaining args)
        await addComment(subArgs[0], subArgs.slice(1).join(' ') || undefined);
        break;

      case 'done':
        if (args.includes('--help')) {
          showDoneHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please specify an issue key');
          showDoneHelp();
          process.exit(1);
        }
        await markIssueDone(subArgs[0]);
        break;

      case 'open':
        if (args.includes('--help')) {
          showOpenHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please specify an issue key');
          showOpenHelp();
          process.exit(1);
        }
        await openCommand(subArgs[0]);
        break;

      case 'log':
        if (args.includes('--help')) {
          showLogHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please specify an issue key');
          showLogHelp();
          process.exit(1);
        }
        await showIssueLog(subArgs[0]);
        break;

      case 'issue':
        if (args.includes('--help') || !subArgs[0]) {
          showIssueHelp();
          process.exit(0);
        }

        if (subArgs[0] === 'view' && subArgs[1]) {
          await viewIssue(subArgs[1], { json: args.includes('--json'), local: args.includes('--local') });
        } else if (subArgs[0] === 'sync' && subArgs[1]) {
          await syncJiraProject(subArgs[1], { clean: args.includes('--clean') });
        } else {
          console.error('Invalid issue command. Use "ji issue view <key>" or "ji issue sync <project>"');
          showIssueHelp();
          process.exit(1);
        }
        break;

      case 'board':
        if (args.includes('--help')) {
          showBoardHelp();
          process.exit(0);
        }
        await showMyBoards(subArgs[0], args.includes('--local'));
        break;

      case 'sprint':
        if (args.includes('--help')) {
          showSprintHelp();
          process.exit(0);
        }
        await showSprint(subArgs[0], {
          unassigned: args.includes('--unassigned'),
          local: args.includes('--local'),
        });
        break;

      case 'confluence':
        if (args.includes('--help') || !subArgs[0]) {
          showConfluenceHelp();
          process.exit(0);
        }

        if (subArgs[0] === 'sync' && subArgs[1]) {
          await syncConfluence(subArgs[1], { clean: args.includes('--clean') });
        } else if (subArgs[0] === 'recent' && subArgs[1]) {
          const limit = subArgs[2] ? parseInt(subArgs[2]) : 10;
          await showRecentConfluencePages(subArgs[1], limit);
        } else if (subArgs[0] === 'view' && subArgs[1]) {
          await viewConfluencePage(subArgs[1]);
        } else {
          console.error('Invalid confluence command');
          showConfluenceHelp();
          process.exit(1);
        }
        break;

      case 'sync':
        if (args.includes('--help')) {
          showSyncHelp();
          process.exit(0);
        }
        await syncWorkspaces({ clean: args.includes('--clean') });
        break;

      case 'search': {
        if (args.includes('--help')) {
          showSearchHelp();
          process.exit(0);
        }

        if (!subArgs[0]) {
          console.error('Please provide a search query');
          process.exit(1);
        }

        // Parse limit option (supports both --limit=3 and --limit 3 formats)
        let limit = 10; // default
        const limitIndex = args.findIndex((arg) => arg.startsWith('--limit'));
        if (limitIndex !== -1) {
          const limitArg = args[limitIndex];
          if (limitArg.includes('=')) {
            // Format: --limit=3
            const limitValue = limitArg.split('=')[1];
            const parsed = parseInt(limitValue);
            if (!Number.isNaN(parsed) && parsed > 0) {
              limit = parsed;
            }
          } else if (limitIndex + 1 < args.length) {
            // Format: --limit 3
            const parsed = parseInt(args[limitIndex + 1]);
            if (!Number.isNaN(parsed) && parsed > 0) {
              limit = parsed;
            }
          }
        }

        // Filter out --limit and its value from the query
        const queryArgs = subArgs.filter((arg, _index) => {
          const argIndex = subArgs.indexOf(arg);
          const prevArg = argIndex > 0 ? subArgs[argIndex - 1] : '';

          // Skip --limit=3 format
          if (arg.startsWith('--limit')) return false;

          // Skip value after --limit in --limit 3 format
          if (prevArg === '--limit') return false;

          return true;
        });

        const query = queryArgs.join(' ');
        await search(query, {
          source: args.includes('--jira') ? 'jira' : args.includes('--confluence') ? 'confluence' : undefined,
          limit,
          includeAll: args.includes('--all'),
        });
        break;
      }

      case 'ask': {
        if (args.includes('--help')) {
          showAskHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please provide a question');
          showAskHelp();
          process.exit(1);
        }
        const question = subArgs.join(' ');
        await ask(question);
        break;
      }

      case 'remember': {
        if (args.includes('--help')) {
          showRememberHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please provide a fact to remember');
          showRememberHelp();
          process.exit(1);
        }
        const fact = subArgs.join(' ');
        await addMemory(fact);
        break;
      }

      case 'memories':
        if (args.includes('--help') || !subArgs[0]) {
          showMemoriesHelp();
          process.exit(0);
        }

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
          showMemoriesHelp();
          process.exit(1);
        }
        break;

      case 'config':
        if (args.includes('--help')) {
          showConfigHelp();
          process.exit(0);
        }
        await configureCustomFields();
        break;

      case 'models':
        if (args.includes('--help')) {
          showModelsHelp();
          process.exit(0);
        }
        await configureModels();
        break;

      case 'test':
        if (args.includes('--help')) {
          showTestHelp();
          process.exit(0);
        }
        await testCommand({ setup: args.includes('--setup') });
        break;

      default:
        // Check if it's an issue key (e.g., ABC-123)
        if (/^[A-Z]+-\d+$/.test(command)) {
          await viewIssue(command, { json: args.includes('--json'), local: args.includes('--local') });
        } else {
          console.error(`Unknown command: ${command}`);
          console.log('Run "ji help" for usage information');
          process.exit(1);
        }
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

// Run the CLI
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
