import type { IterationContext, IssueInfo, RemoteIterationContext } from './do-types.js';
import type { IterationResult } from '../../lib/agent-sdk-wrapper.js';

/**
 * Generates the prompt for a specific iteration.
 * First iteration focuses on implementation, subsequent iterations on review and refinement.
 */
export const generateIterationPrompt = (context: IterationContext): string => {
  const previousContext =
    context.previousResults.length > 0
      ? `\n## Previous Iterations:\n${context.previousResults
          .map((r, i) => `Iteration ${i + 1}: ${r.summary} (Success: ${r.success})`)
          .join('\n')}\n`
      : '';

  const isFirstIteration = context.iteration === 1;
  const hasChanges = context.previousResults.some((r) => r.filesModified.length > 0);

  // Commit instructions based on strategy
  const commitInstructions = context.singleCommit
    ? `
**IMPORTANT COMMIT STRATEGY**:
This is a SINGLE COMMIT workflow. Do NOT create any commits during development.
Make all your changes first, then at the very end create ONE comprehensive commit with all changes included.
Use conventional commit format: "feat: description" or "fix: description"`
    : `
**Commit Strategy**:
Create logical commits as you work. Commit after each meaningful change using conventional commit format.

Example:
  \`git add -A\`
  \`git commit -m "feat: implement user authentication

  Add JWT-based authentication with refresh tokens.

  Part of resolving ${context.issueKey}"\``;

  if (isFirstIteration) {
    return `You are helping resolve a Jira issue through iterative development.

## Issue Details
${context.issueDescription}

## Current Context
**Iteration:** ${context.iteration}/${context.totalIterations} (Initial Implementation)
**Working Directory:** ${context.workingDirectory}

## Instructions for Initial Implementation
**IMPORTANT**: You are working in the current directory. Stay on the current branch throughout this entire development session.

1. Analyze the issue requirements thoroughly
2. Examine the current codebase in ${context.workingDirectory}
3. Plan your approach and identify the files that need changes
4. Implement the core functionality to address the issue
5. Add basic tests if applicable
6. Ensure quality checks pass (tests, lint, typecheck)

${commitInstructions}

Focus on getting the core functionality working. Subsequent iterations will review and refine your work.`;
  }

  return `You are helping resolve a Jira issue through iterative development.

## Issue Details
${context.issueDescription}

## Current Context
**Iteration:** ${context.iteration}/${context.totalIterations} (Code Review & Refinement)
**Working Directory:** ${context.workingDirectory}${previousContext}

## Instructions for Code Review Iteration
**IMPORTANT**: You are working in the current directory. Stay on the current branch throughout this entire development session.

${
  hasChanges
    ? `
### Review Previous Work First
1. **Examine the changes from iteration ${context.iteration - 1}**:
   - Recent commits: \`git log --oneline -n 3\`
   - Latest changes: \`git diff HEAD~1 HEAD\` (or \`git show HEAD\`)
   - Staged/unstaged: \`git diff --staged\` and \`git diff\`

2. **Conduct a thorough code review**:
   - Check for bugs, edge cases, code quality issues
   - Verify implementation addresses all issue requirements
   - Look for missing error handling, validation, or tests
   - Check adherence to project standards
   - Identify performance or security concerns

### Decision Point: Is Further Work Needed?
3. **Assess if the issue is sufficiently resolved**:
   - Does implementation fully address all requirements?
   - Are there any critical bugs or missing functionality?
   - Do all quality checks pass?
   - Is code production-ready?

### If Sufficiently Resolved:
**STOP HERE** - Do not make further changes. Simply verify quality checks pass.

### If Critical Issues Exist:
4. **Fix critical issues only**:
   - Bugs or logical errors
   - Missing error handling
   - Security vulnerabilities
   - Poor performance patterns
   - Incomplete functionality

5. **Enhance if needed**:
   - Add comprehensive tests if missing
   - Improve documentation
   - Add edge case handling

${commitInstructions}

6. **Validate complete solution**:
   - Ensure all requirements are met
   - Run quality checks
   - Test edge cases and error scenarios`
    : 'No changes detected in previous iterations. Review the implementation status and determine next steps.'
}

**Remember**: Only fix critical issues. Do not over-engineer or add unnecessary features.`;
};

/**
 * Generates a PR description based on the issue and iteration results
 */
export const generatePRDescription = (issueInfo: IssueInfo, allResults: IterationResult[]): string => {
  const successfulIterations = allResults.filter((r) => r.success).length;
  const allFilesModified = Array.from(new Set(allResults.flatMap((r) => r.filesModified)));

  let description = `## Summary\n\nResolves ${issueInfo.key}: ${issueInfo.summary}\n\n`;

  if (allResults.length > 0) {
    description += `## Development Summary\n\n`;
    description += `- Iterations: ${successfulIterations}/${allResults.length} successful\n`;
    description += `- Files modified: ${allFilesModified.length}\n\n`;

    if (allFilesModified.length > 0) {
      description += `### Modified Files\n${allFilesModified.map((f) => `- ${f}`).join('\n')}\n\n`;
    }
  }

  description += `## Testing\n\n- [ ] Code review completed\n- [ ] Tests passing\n- [ ] Manual testing performed\n\n`;

  description += `---\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

  return description;
};

/**
 * Generates prompt for remote iteration (CI build fix).
 * Focuses on analyzing build failures and making targeted fixes.
 */
export const generateRemoteIterationPrompt = (context: RemoteIterationContext): string => {
  const previousAttemptsContext =
    context.previousAttempts.length > 0
      ? `\n## Previous Fix Attempts:\n${context.previousAttempts
          .map((r, i) => `Attempt ${i + 1}: ${r.fixes.join(', ')} - Build ${r.buildCheckPassed ? 'PASSED' : 'FAILED'}`)
          .join('\n')}\n`
      : '';

  return `You are fixing CI build failures for Jira issue ${context.issueKey}.

## Current Context
**Remote Iteration:** ${context.iteration}/${context.totalIterations}
**Working Directory:** ${context.workingDirectory}
**Remote Type:** ${context.remoteType}
${previousAttemptsContext}

## Build Failure Output
\`\`\`
${context.buildFailureOutput}
\`\`\`

## Instructions

1. **Analyze the build failure**:
   - Examine the error messages and stack traces
   - Identify the root cause of the failure
   - Determine which files/tests are affected

2. **Run relevant tests locally FIRST**:
   - Before making changes, try to reproduce the failure locally
   - Run the specific failing tests if they're unit tests
   - Example: \`npm test FailingTestName\` or \`bun test path/to/test.ts\`
   - This helps validate your fix before pushing

3. **Make targeted fixes**:
   - Fix ONLY the issues causing the build failure
   - Do not refactor or make unrelated changes
   - Keep changes minimal and focused

4. **Validate your fix locally**:
   - Run the failing tests again to confirm they pass
   - Run any relevant lint/typecheck commands
   - Only proceed if local validation passes

5. **Commit your changes**:
${
  context.remoteType === 'gerrit'
    ? `   - GERRIT WORKFLOW: Your commit will be automatically amended
   - Do NOT create a new commit, just stage your changes with \`git add\`
   - The system will handle the amend and push`
    : `   - Create a clear commit with conventional format
   - Example: \`git commit -m "fix: resolve test failure in UserAuth"\``
}

**IMPORTANT**:
- Focus on fixing the build failure, not improving the code
- Test locally before committing
- Be concise - you have limited iterations to fix this`;
};
