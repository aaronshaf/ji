#!/usr/bin/env bun
import chalk from 'chalk';
import { analyzeIssue } from './commands/analyze.js';
import { showMyBoards } from './commands/board.js';
import { addComment } from './commands/comment.js';
import { configureCustomFields } from './commands/config.js';
import { markIssueDone } from './commands/done.js';
import { viewIssue } from './commands/issue.js';
import { showIssueLog } from './commands/log.js';
import { showMyIssues, takeIssue } from './commands/mine.js';
import { openCommand } from './commands/open.js';
import { setup } from './commands/setup.js';
// import { initializeSetup } from './commands/setup.js'; // Disabled due to TypeScript errors
import { showSprint } from './commands/sprint.js';
import { statusCommand } from './commands/status.js';

// Command-specific help functions

function showIssueHelp() {
  console.log(`
${chalk.bold('ji issue - Jira issue commands')}

${chalk.yellow('Usage:')}
  ji issue <subcommand> [options]

${chalk.yellow('Subcommands:')}
  view <issue-key>          View issue details


${chalk.yellow('Options:')}
  --xml                     Output in XML format for LLM parsing
  --json                    Alias for --xml (deprecated)
  --help                    Show this help message

${chalk.yellow('Note:')}
  By default, 'ji issue view' shows pretty colored output.
  Use --xml for LLM-friendly XML output.
${chalk.yellow('Examples:')}
  ji issue view EVAL-123    # View issue with pretty output
  ji issue view EVAL-123 --xml # View issue in XML format
  ji sprint ABC             # Show current sprint for project ABC
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

  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji board                  Show all boards (fresh data)
  ji board EVAL             Show boards for EVAL project (fresh data)
  ji board                  Show all boards with colored output (default)
  ji board --xml            Show all boards in XML format for LLMs
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
  By default, fetches fresh data from Jira API and displays colored output.

${chalk.yellow('Options:')}
  --unassigned              Show only unassigned issues
  --xml                     Show XML output for LLM parsing
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji sprint                 Show all active sprints
  ji sprint EVAL            Show active sprint for EVAL project
`);
}

function showMineHelp() {
  console.log(`
${chalk.bold('ji mine - Show your issues with flexible filtering')}

${chalk.yellow('Usage:')}
  ji mine [options]

${chalk.yellow('Description:')}
  Shows issues assigned to you with flexible status and time filtering.
  By default, shows open issues and fetches fresh data from Jira API.
  Displays colored output by default (use --xml for LLM-friendly format).

${chalk.yellow('Options:')}
  --status <filter>         Filter by status (see Status Filters below)
  --since <time>            Show issues updated since (see Time Formats below)
  --project <key>           Filter by project key (e.g., CFA, EVAL)
  --xml                     Show XML output for LLM parsing
  --help                    Show this help message

${chalk.yellow('Status Filters:')}
  open                      Not closed/done/resolved (default)
  closed                    Closed, done, or resolved issues
  all                       All statuses
  done,closed               Comma-separated list of specific statuses
  "in progress"             Specific status (use quotes if contains spaces)

${chalk.yellow('Time Formats:')}
  24h                       Last 24 hours
  7d                        Last 7 days
  1w                        Last week
  yesterday                 Since yesterday
  2024-01-15                Since specific date
  "2024-01-15 10:00"        Since specific date and time

${chalk.yellow('Examples:')}
  ji mine                               Show all your open issues
  ji mine --status closed --since 24h   Show issues closed in last 24 hours
  ji mine --status all --since 7d       Show all issues updated in last 7 days
  ji mine --status "in progress"        Show your in-progress issues
  ji mine --project CFA --status done   Show done issues in project CFA
  ji mine                               Show issues with colored output (default)
  ji mine --xml                         Show issues in XML format for LLMs
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

function showSetupHelp() {
  console.log(`
${chalk.bold('ji setup - Configure Jira CLI')}

${chalk.yellow('Usage:')}
  ji setup

${chalk.yellow('Description:')}
  Interactive setup wizard that configures:
  - Jira authentication (URL, email, API token)
  - AI analysis tool preferences (optional)
  Stores configuration securely in ~/.ji/config.json

${chalk.yellow('Required Information:')}
  - Jira URL (e.g., https://company.atlassian.net)
  - Email address
  - API token (create at https://id.atlassian.com/manage/api-tokens)

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji setup                  # Start interactive setup
`);
}

function showAnalyzeHelp() {
  console.log(`
${chalk.bold('ji analyze - Analyze Jira issue with AI')}

${chalk.yellow('Usage:')}
  ji analyze <issue-key-or-url> [options]

${chalk.yellow('Description:')}
  Uses AI to analyze a Jira issue and output insights.
  Automatically detects available tools (claude, gemini, codex).
  Accepts both issue keys (EVAL-123) and Jira URLs.
  Uses Claude SDK for better performance when available.

${chalk.yellow('Options:')}
  --prompt <file>           Use custom prompt file (overrides config)
  --tool <name>             Use specific tool (claude, gemini, codex)
  -c, --comment             Post analysis as a comment to the issue
  -y, --yes                 Skip confirmation when posting comment
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji analyze EVAL-123                           # Using issue key
  ji analyze https://company.atlassian.net/browse/EVAL-123  # Using URL
  ji analyze EVAL-123 --comment                 # Analyze and prompt to post
  ji analyze EVAL-123 --comment --yes           # Post without confirmation
  ji analyze EVAL-123 --prompt ./custom.md      # Use custom prompt
  ji analyze EVAL-123 --tool claude             # Use Claude specifically
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
function showStatusHelp() {
  console.log(`
${chalk.bold('ji status - Check Jira connection')}

${chalk.yellow('Usage:')}
  ji status

${chalk.yellow('Description:')}
  Verifies your Jira connection and displays current configuration.
  Shows the authenticated user and basic statistics.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  ji status                 Check connection and show user info
`);
}

function showHelp() {
  console.log(`
${chalk.bold('ji - Jira CLI')}

${chalk.yellow('Setup:')}
  ji setup                             Configure Jira authentication and AI tools
  ji status                            Check Jira connection and configuration

${chalk.yellow('Issues:')}
  ji mine [options]                    Show your issues with flexible filters
  ji take <issue-key>                  Assign an issue to yourself
  ji done <issue-key>                  Mark an issue as Done
  ji open <issue-key>                  Open issue in browser
  ji comment <issue-key> [comment]     Add a comment to an issue
  ji analyze <issue-key-or-url>        Analyze issue with AI
  ji log <issue-key>                   Interactive comment viewer/editor
  ji <issue-key>                       View issue (pretty output by default)
  ji <issue-key> --xml                 View issue in XML format

  ji issue view <issue-key>            View issue details (alias)
  ji issue sync <project-key>          Sync all issues from a project

${chalk.yellow('Boards & Sprints:')}
  ji board [project-key]               Show boards for a project
  ji sprint [project-key]              Show active sprint for a project

${chalk.yellow('Configuration:')}
  ji config                            Discover available custom fields  

${chalk.yellow('Help:')}
  ji help                              Show this help message
  ji [command] --help                  Show help for a specific command

${chalk.gray('Examples:')}
  ji ABC-123                           View issue with pretty colors
  ji ABC-123 --xml                    View issue in XML format
  ji mine                              Show your assigned issues
  ji mine --status "In Progress"      Filter by status
  ji analyze ABC-123                   Analyze issue with AI
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
    // No background operations needed in API-only mode

    // Main commands
    switch (command) {
      case 'setup':
        if (args.includes('--help')) {
          showSetupHelp();
          process.exit(0);
        }
        await setup();
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

        // Parse status filter
        let statusFilter: string | undefined;
        const statusIndex = args.findIndex((arg) => arg.startsWith('--status'));
        if (statusIndex !== -1) {
          const statusArg = args[statusIndex];
          if (statusArg.includes('=')) {
            // Format: --status=closed
            statusFilter = statusArg.split('=')[1];
          } else if (statusIndex + 1 < args.length) {
            // Format: --status closed
            statusFilter = args[statusIndex + 1];
          }
        }

        // Parse since filter
        let sinceFilter: string | undefined;
        const sinceIndex = args.findIndex((arg) => arg.startsWith('--since'));
        if (sinceIndex !== -1) {
          const sinceArg = args[sinceIndex];
          if (sinceArg.includes('=')) {
            // Format: --since=24h
            sinceFilter = sinceArg.split('=')[1];
          } else if (sinceIndex + 1 < args.length) {
            // Format: --since 24h
            sinceFilter = args[sinceIndex + 1];
          }
        }

        // Check for --xml flag
        const xml = args.includes('--xml');

        await showMyIssues(projectFilter, xml, statusFilter, sinceFilter);
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

      case 'analyze': {
        if (args.includes('--help')) {
          showAnalyzeHelp();
          process.exit(0);
        }
        if (!subArgs[0]) {
          console.error('Please specify an issue key or URL');
          showAnalyzeHelp();
          process.exit(1);
        }

        // Parse options
        let promptFile: string | undefined;
        const promptIndex = args.findIndex((arg) => arg === '--prompt');
        if (promptIndex !== -1 && promptIndex + 1 < args.length) {
          promptFile = args[promptIndex + 1];
        }

        let tool: string | undefined;
        const toolIndex = args.findIndex((arg) => arg === '--tool');
        if (toolIndex !== -1 && toolIndex + 1 < args.length) {
          tool = args[toolIndex + 1];
        }

        const yes = args.includes('-y') || args.includes('--yes');
        const comment = args.includes('-c') || args.includes('--comment');

        await analyzeIssue(subArgs[0], { prompt: promptFile, tool, comment, yes });
        break;
      }

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
          await viewIssue(subArgs[1], { xml: args.includes('--xml'), json: args.includes('--json') });
        } else {
          console.error('Invalid issue command. Use "ji issue view <key>"');
          showIssueHelp();
          process.exit(1);
        }
        break;

      case 'board':
        if (args.includes('--help')) {
          showBoardHelp();
          process.exit(0);
        }
        await showMyBoards(subArgs[0], args.includes('--xml'));
        break;

      case 'sprint': {
        if (args.includes('--help')) {
          showSprintHelp();
          process.exit(0);
        }
        // Find the first non-flag argument for project filter
        const sprintProjectFilter = subArgs.find((arg) => !arg.startsWith('--'));
        await showSprint(sprintProjectFilter, {
          unassigned: args.includes('--unassigned'),
          xml: args.includes('--xml'),
        });
        break;
      }

      case 'sync':
        console.error('Sync command is no longer supported.');
        return;

      case 'config':
        if (args.includes('--help')) {
          showConfigHelp();
          process.exit(0);
        }
        await configureCustomFields();
        break;

      case 'status':
        if (args.includes('--help')) {
          showStatusHelp();
          process.exit(0);
        }
        await statusCommand();
        break;

      default:
        // Check if it's an issue key (e.g., ABC-123)
        if (/^[A-Z]+-\d+$/.test(command)) {
          await viewIssue(command, { xml: args.includes('--xml'), json: args.includes('--json') });
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
