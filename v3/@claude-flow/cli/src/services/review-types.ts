/**
 * PR Review Orchestration Types
 *
 * All TypeScript interfaces for dual-model multi-agent PR review
 * with pair agreement and debate/consensus loop.
 */

import * as os from 'os';
import * as path from 'path';

// ============================================================================
// Core Identifiers
// ============================================================================

export interface PRIdentifier {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

// ============================================================================
// Enums / Union Types
// ============================================================================

export type ReviewStatus =
  | 'initializing'
  | 'reviewing'
  | 'pair-agreeing'
  | 'debating'
  | 'compiling'
  | 'completed'
  | 'error';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  | 'security'
  | 'logic'
  | 'performance'
  | 'integration'
  | 'style'
  | 'other';

export type ReviewRecommendation = 'approve' | 'request-changes' | 'comment';

export type ModelProvider = 'claude' | 'codex';

// ============================================================================
// PR Metadata
// ============================================================================

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface PRMetadata {
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  diff: string;
  changedFiles: ChangedFile[];
  additions: number;
  deletions: number;
}

// ============================================================================
// Findings
// ============================================================================

export interface Finding {
  id: string;
  agent: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  confidence: number; // 0-1
}

export interface AgentFindings {
  agent: string;
  model: string;
  findings: Finding[];
  summary: string;
  completedAt: string;
  durationMs: number;
}

// ============================================================================
// Pair Agreement (Dual-Model)
// ============================================================================

export interface PairAgreement {
  role: string;
  claudeFindings: AgentFindings;
  codexFindings: AgentFindings;
  agreedFindings: Finding[];
  disagreements: Finding[];
  resolution: 'full-agreement' | 'partial-agreement' | 'escalated';
  notes: string;
}

// ============================================================================
// Debate
// ============================================================================

export interface DebatePosition {
  agent: string;
  stance: 'agree' | 'disagree' | 'modify';
  reasoning: string;
  suggestedSeverity?: FindingSeverity;
}

export interface DebateRound {
  round: number;
  topic: string;
  findingId: string;
  positions: DebatePosition[];
  resolution: 'consensus' | 'majority' | 'queen-override';
  resolvedSeverity: FindingSeverity;
  notes: string;
}

// ============================================================================
// Report
// ============================================================================

export interface ReviewReport {
  overview: string;
  findings: Finding[];
  criticalFindings: Finding[];
  suggestions: Finding[];
  pairAgreementNotes: string[];
  debateNotes: string[];
  recommendation: ReviewRecommendation;
  markdown: string;
  generatedAt: string;
}

// ============================================================================
// Review Context (Full State)
// ============================================================================

export interface ReviewContext {
  id: string;
  pr: PRIdentifier;
  metadata: PRMetadata;
  status: ReviewStatus;
  worktreePath?: string;
  agentFindings: AgentFindings[];
  pairAgreements: PairAgreement[];
  debates: DebateRound[];
  report?: ReviewReport;
  config: ReviewConfig;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

// ============================================================================
// Configuration
// ============================================================================

export interface ProviderSpec {
  model: string;
  provider: string;
}

export interface DualProviderSpec {
  claude: ProviderSpec;
  codex: ProviderSpec;
}

export interface ReviewConfig {
  projectsDir: string;
  maxDebateRounds: number;
  consensusThreshold: number; // fraction, e.g. 2/3
  providers: {
    securityAuditor: DualProviderSpec;
    logicChecker: DualProviderSpec;
    integrationSpecialist: DualProviderSpec;
    queen: ProviderSpec;
  };
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  projectsDir: process.env.RUFLO_PROJECTS_DIR || path.join(os.homedir(), 'Projects'),
  maxDebateRounds: 3,
  consensusThreshold: 2 / 3,
  providers: {
    securityAuditor: {
      claude: { model: 'opus', provider: 'anthropic' },
      codex: { model: 'gpt-5.4', provider: 'openai' },
    },
    logicChecker: {
      claude: { model: 'opus', provider: 'anthropic' },
      codex: { model: 'gpt-5.4', provider: 'openai' },
    },
    integrationSpecialist: {
      claude: { model: 'opus', provider: 'anthropic' },
      codex: { model: 'gpt-5.4', provider: 'openai' },
    },
    queen: { model: 'opus', provider: 'anthropic' },
  },
};

// ============================================================================
// Parsing
// ============================================================================

// ============================================================================
// Agent Dispatch Types
// ============================================================================

export type AgentRole = 'security-auditor' | 'logic-checker' | 'integration-specialist';

export interface AgentProcess {
  role: string;
  provider: ModelProvider;
  label: string;
  pid: number;
  startTime: number;
  outputPath: string;
  logPath: string;
  status: 'running' | 'succeeded' | 'failed';
  exitCode?: number;
  outputSize?: number;
}

export interface DispatchConfig {
  claudeModel: string;
  codexCmd: string;
  codexModel: string;
  codexArgs: string;
  agentBudget: number;
  reconcileBudget: number;
  reconcileModel: string;
  verbose: boolean;
  logFile: string;
  dualMode: boolean;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  claudeModel: process.env.CLAUDE_MODEL || 'opus',
  codexCmd: process.env.CODEX_CMD || 'codex',
  codexModel: process.env.CODEX_MODEL || 'gpt-5.4',
  codexArgs: process.env.CODEX_ARGS || '',
  agentBudget: parseFloat(process.env.AGENT_BUDGET || '25'),
  reconcileBudget: parseFloat(process.env.RECONCILE_BUDGET || '50'),
  reconcileModel: process.env.RECONCILE_MODEL || 'opus',
  verbose: false,
  logFile: '',
  dualMode: true,
};

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a PR URL or shorthand into a PRIdentifier.
 *
 * Supported formats:
 *   https://github.com/owner/repo/pull/123
 *   owner/repo#123
 *   owner/repo/123
 */
export function parsePRUrl(input: string): PRIdentifier {
  const trimmed = input.trim();

  // Full URL
  const urlMatch = trimmed.match(
    /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: parseInt(urlMatch[3], 10),
      url: trimmed,
    };
  }

  // owner/repo#123
  const hashMatch = trimmed.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (hashMatch) {
    return {
      owner: hashMatch[1],
      repo: hashMatch[2],
      number: parseInt(hashMatch[3], 10),
      url: `https://github.com/${hashMatch[1]}/${hashMatch[2]}/pull/${hashMatch[3]}`,
    };
  }

  // owner/repo/123
  const slashMatch = trimmed.match(/^([\w.-]+)\/([\w.-]+)\/(\d+)$/);
  if (slashMatch) {
    return {
      owner: slashMatch[1],
      repo: slashMatch[2],
      number: parseInt(slashMatch[3], 10),
      url: `https://github.com/${slashMatch[1]}/${slashMatch[2]}/pull/${slashMatch[3]}`,
    };
  }

  throw new Error(
    `Invalid PR identifier: "${trimmed}". ` +
      'Expected: https://github.com/owner/repo/pull/123, owner/repo#123, or owner/repo/123'
  );
}
