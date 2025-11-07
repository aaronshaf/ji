import { Schema } from '@effect/schema';
import type { IterationResult } from '../../lib/agent-sdk-wrapper.js';
import type { SafetyConfig } from '../../lib/safety-controls.js';

/**
 * Error class for do command operations
 */
export class DoCommandError extends Error {
  readonly _tag = 'DoCommandError';
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
  }
}

/**
 * Options for the do command
 */
export interface DoCommandOptions {
  readonly iterations?: number;
  readonly remoteIterations?: number; // Number of CI fix iterations after PR creation
  readonly model?: string;
  readonly dryRun?: boolean;
  readonly skipTests?: boolean;
  readonly safetyConfig?: Partial<SafetyConfig>;
  readonly singleCommit?: boolean; // Control commit strategy
}

/**
 * Safety validation report
 */
export interface SafetyReport {
  overall: boolean;
  fileValidation: {
    valid: boolean;
    errors: string[];
    filesValidated: number;
  };
  testRequirements: {
    satisfied: boolean;
    reason: string;
  };
  additionalChecks: Record<string, boolean>;
  summary: string;
}

/**
 * Final result of the do command execution
 */
export interface FinalResult {
  workingDirectory: string;
  allResults: IterationResult[];
  safetyReport?: SafetyReport;
  prResult?: string;
}

/**
 * Context for development iterations
 */
export interface IterationContext {
  issueKey: string;
  issueDescription: string; // Full XML representation
  workingDirectory: string;
  iteration: number;
  totalIterations: number;
  previousResults: IterationResult[];
  singleCommit: boolean; // Commit strategy
}

/**
 * Remote type detection result
 */
export type RemoteType = 'github' | 'gerrit' | 'unknown';

/**
 * Issue information from Jira
 */
export interface IssueInfo {
  key: string;
  summary: string;
  description: string;
}

/**
 * Context for remote iterations (CI build fixes)
 */
export interface RemoteIterationContext {
  issueKey: string;
  workingDirectory: string;
  iteration: number;
  totalIterations: number;
  buildFailureOutput: string;
  remoteType: RemoteType;
  previousAttempts: RemoteIterationResult[];
}

/**
 * Result of a remote iteration attempt
 */
export interface RemoteIterationResult {
  iteration: number;
  fixes: string[]; // Description of fixes attempted
  commitHash?: string;
  pushed: boolean;
  buildCheckPassed: boolean;
  buildOutput: string;
}
