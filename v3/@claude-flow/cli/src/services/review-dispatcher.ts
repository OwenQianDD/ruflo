/**
 * Review Dispatcher — Agent Process Spawn, PID Monitoring, Queen Reconciliation
 *
 * Spawns Claude and Codex agents as child processes, monitors their progress,
 * and runs queen reconciliation to produce the final report.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type {
  AgentProcess,
  AgentRole,
  DispatchConfig,
  ReviewContext,
  PairAgreement,
  ModelProvider,
  Finding,
  FindingSeverity,
  DebatePosition,
} from './review-types.js';
import { DEFAULT_DISPATCH_CONFIG } from './review-types.js';

// ============================================================================
// ReviewDispatcher
// ============================================================================

export class ReviewDispatcher extends EventEmitter {
  private config: DispatchConfig;
  private activeProcesses: Map<number, ChildProcess> = new Map();
  private cleanupRegistered = false;

  constructor(config?: Partial<DispatchConfig>) {
    super();
    this.config = { ...DEFAULT_DISPATCH_CONFIG, ...config };
  }

  // ==========================================================================
  // Codex Availability Check
  // ==========================================================================

  isCodexAvailable(): boolean {
    try {
      execFileSync('which', [this.config.codexCmd], { stdio: 'ignore' });
      return true;
    } catch {
      this.config.dualMode = false;
      return false;
    }
  }

  // ==========================================================================
  // Agent Dispatch
  // ==========================================================================

  /**
   * Dispatch all review agents as child processes.
   * Returns an array of AgentProcess descriptors with PIDs.
   */
  dispatchAgents(
    review: ReviewContext,
    promptFiles: Map<string, string>,
    worktreePath?: string,
  ): AgentProcess[] {
    this.registerCleanup();

    const agents: AgentProcess[] = [];
    const roles: AgentRole[] = ['security-auditor', 'logic-checker', 'integration-specialist'];
    const startTime = Date.now();

    for (const role of roles) {
      // Claude agent
      const claudePromptFile = promptFiles.get(`${role}-claude`);
      if (claudePromptFile) {
        const agent = this.spawnClaudeAgent(role, claudePromptFile, worktreePath, startTime);
        agents.push(agent);
      }

      // Codex agent (only in dual mode)
      if (this.config.dualMode) {
        const codexPromptFile = promptFiles.get(`${role}-codex`);
        if (codexPromptFile) {
          const agent = this.spawnCodexAgent(role, codexPromptFile, worktreePath, startTime);
          agents.push(agent);
        }
      }
    }

    return agents;
  }

  private spawnClaudeAgent(
    role: AgentRole, promptFile: string, worktreePath: string | undefined, startTime: number,
  ): AgentProcess {
    const args = [
      '-p', '--model', this.config.claudeModel,
      '--max-budget-usd', String(this.config.agentBudget),
      '--output-format', 'text',
    ];
    if (worktreePath) args.push('--allowedTools', 'Read,Grep,Glob');

    return this.spawnAgent(role, 'claude', `${role} (Claude ${this.config.claudeModel})`,
      'claude', args, promptFile, worktreePath || process.cwd(), startTime);
  }

  private spawnCodexAgent(
    role: AgentRole, promptFile: string, worktreePath: string | undefined, startTime: number,
  ): AgentProcess {
    const args = ['exec', '-m', this.config.codexModel];
    if (this.config.codexArgs) args.push(...this.config.codexArgs.split(/\s+/).filter(Boolean));
    if (worktreePath) args.push('--cd', worktreePath);
    args.push('-');

    return this.spawnAgent(role, 'codex', `${role} (Codex ${this.config.codexModel})`,
      this.config.codexCmd, args, promptFile, undefined, startTime);
  }

  private spawnAgent(
    role: string, provider: ModelProvider, label: string,
    cmd: string, args: string[], promptFile: string,
    cwd: string | undefined, startTime: number,
  ): AgentProcess {
    const outputPath = promptFile.replace(/prompt-/, 'out-').replace(/\.txt$/, '.txt');
    const logPath = promptFile.replace(/prompt-/, 'log-').replace(/\.txt$/, '.log');
    const promptContent = fs.readFileSync(promptFile, 'utf-8');
    const outFd = fs.openSync(outputPath, 'w');
    const logFd = fs.openSync(logPath, 'w');

    const opts: { cwd?: string; stdio: ['pipe', number, number] } = { stdio: ['pipe', outFd, logFd] };
    if (cwd) opts.cwd = cwd;

    const child = spawn(cmd, args, opts);
    child.stdin?.write(promptContent);
    child.stdin?.end();
    this.activeProcesses.set(child.pid!, child);

    const agent: AgentProcess = {
      role, provider, label, pid: child.pid!, startTime, outputPath, logPath, status: 'running',
    };

    child.on('close', (code) => {
      this.activeProcesses.delete(child.pid!);
      fs.closeSync(outFd);
      fs.closeSync(logFd);
      agent.exitCode = code ?? 1;
      const hasOutput = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
      agent.outputSize = hasOutput ? fs.statSync(outputPath).size : 0;
      agent.status = code === 0 && hasOutput ? 'succeeded' : 'failed';
      this.emit('agent:complete', agent);
    });

    child.on('error', () => {
      this.activeProcesses.delete(child.pid!);
      agent.status = 'failed';
      this.emit('agent:failed', agent);
    });

    return agent;
  }

  // ==========================================================================
  // Agent Monitoring
  // ==========================================================================

  /**
   * Wait for all agents to complete. Returns when all processes have exited.
   * Emits 'agent:complete' and 'agent:failed' events as agents finish.
   */
  monitorAgents(agents: AgentProcess[], pollIntervalMs = 2000): Promise<AgentProcess[]> {
    return new Promise((resolve) => {
      const pending = new Set(agents.filter(a => a.status === 'running').map(a => a.pid));

      if (pending.size === 0) {
        resolve(agents);
        return;
      }

      const check = () => {
        for (const pid of pending) {
          try {
            process.kill(pid, 0); // Check if process is alive
          } catch {
            pending.delete(pid);
          }
        }

        if (pending.size === 0) {
          resolve(agents);
        } else {
          setTimeout(check, pollIntervalMs);
        }
      };

      // Also resolve via events
      let completed = agents.filter(a => a.status !== 'running').length;
      const onDone = () => {
        completed++;
        if (completed >= agents.length) {
          resolve(agents);
        }
      };
      this.on('agent:complete', onDone);
      this.on('agent:failed', onDone);

      setTimeout(check, pollIntervalMs);
    });
  }

  // ==========================================================================
  // Debate Resolution
  // ==========================================================================

  /**
   * Ask each original agent (by role) to take a position on a disputed finding.
   * Calls claude -p synchronously per agent — used as the callback for
   * ReviewService.runDebateLoop().
   */
  resolveDebatePositions(
    finding: Finding,
    round: number,
    review: ReviewContext,
  ): DebatePosition[] {
    const roles = ['security-auditor', 'logic-checker', 'integration-specialist'];
    const positions: DebatePosition[] = [];

    for (const role of roles) {
      const prompt = [
        `You are the ${role} in round ${round} of a debate about a disputed finding.`,
        '',
        `Finding under debate:`,
        `  ID: ${finding.id}`,
        `  Agent: ${finding.agent}`,
        `  Severity: ${finding.severity}`,
        `  Title: ${finding.title}`,
        `  File: ${finding.file || '(general)'}${finding.line ? `:${finding.line}` : ''}`,
        `  Description: ${finding.description}`,
        `  Suggestion: ${finding.suggestion || '(none)'}`,
        '',
        `PR context: #${review.pr.number} "${review.metadata.title}" in ${review.pr.owner}/${review.pr.repo}`,
        '',
        'As the ' + role + ', evaluate this finding from your specialty.',
        'Respond with JSON:',
        '{',
        '  "stance": "agree" | "disagree" | "modify",',
        '  "reasoning": "1-2 sentence explanation",',
        '  "suggestedSeverity": "critical" | "high" | "medium" | "low" | "info"  // only if stance is "modify"',
        '}',
        '',
        'Respond ONLY with valid JSON.',
      ].join('\n');

      try {
        const result = execFileSync('claude', [
          '-p', '--model', this.config.claudeModel,
          '--max-budget-usd', '2',
          '--output-format', 'text',
        ], {
          input: prompt,
          encoding: 'utf-8',
          timeout: 60_000,
        });

        const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, result];
        const parsed = JSON.parse((jsonMatch[1] || result).trim());

        positions.push({
          agent: role,
          stance: parsed.stance || 'agree',
          reasoning: parsed.reasoning || '',
          suggestedSeverity: parsed.suggestedSeverity as FindingSeverity | undefined,
        });
      } catch {
        // If an agent fails to respond, default to agreeing with original severity
        positions.push({
          agent: role,
          stance: 'agree',
          reasoning: `(${role} did not respond in debate round ${round})`,
        });
      }
    }

    return positions;
  }

  // ==========================================================================
  // Queen Reconciliation
  // ==========================================================================

  /**
   * Build and run the queen reconciliation pass.
   * Returns the reconciled report as markdown.
   */
  async runReconciliation(
    review: ReviewContext,
    agentOutputs: Map<string, string>,
    pairAgreements: PairAgreement[],
    dualMode: boolean,
  ): Promise<string> {
    const promptParts: string[] = [];

    // Header
    if (dualMode) {
      promptParts.push(this.buildDualModeQueenHeader());
    } else {
      promptParts.push(this.buildSingleModeQueenHeader());
    }

    // PR context
    promptParts.push(this.buildPRContext(review));

    // Pair agreement summary (if dual mode)
    if (dualMode && pairAgreements.length > 0) {
      promptParts.push('## Algorithmic Pair Agreement Results\n');
      for (const pa of pairAgreements) {
        promptParts.push(
          `- ${pa.role}: ${pa.agreedFindings.length} agreed, ` +
          `${pa.disagreements.length} single-source (${pa.resolution})`
        );
      }
      promptParts.push('');
    }

    // Debate results (if any rounds were run)
    if (review.debates.length > 0) {
      promptParts.push('## Debate Results (2/3 Quorum)\n');
      for (const d of review.debates) {
        const positionSummary = d.positions
          .map(p => `${p.agent}: ${p.stance}${p.suggestedSeverity ? ` (suggests ${p.suggestedSeverity})` : ''} — ${p.reasoning}`)
          .join('\n    ');
        promptParts.push(
          `- **${d.topic}** (round ${d.round}): resolved via ${d.resolution} → ${d.resolvedSeverity}\n` +
          `    ${positionSummary}`
        );
      }
      promptParts.push('');
      promptParts.push('Findings that reached consensus or majority have their severity already resolved above.');
      promptParts.push('Findings marked "queen-override" need YOUR final judgment on severity.');
      promptParts.push('');
    }

    // Raw agent outputs
    promptParts.push('## Raw Agent Outputs\n');
    for (const [name, content] of agentOutputs) {
      if (content.trim()) {
        promptParts.push(`### ${name}`);
        promptParts.push('```json');
        promptParts.push(content);
        promptParts.push('```');
        promptParts.push('');
      }
    }

    const fullPrompt = promptParts.join('\n');

    // Spawn queen reconciliation via claude -p
    return new Promise<string>((resolve, reject) => {
      const args = [
        '-p',
        '--model', this.config.reconcileModel,
        '--max-budget-usd', String(this.config.reconcileBudget),
        '--output-format', 'text',
      ];

      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcesses.set(child.pid!, child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.stdin?.write(fullPrompt);
      child.stdin?.end();

      // 10 minute timeout
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Queen reconciliation timed out after 10 minutes'));
      }, 10 * 60 * 1000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child.pid!);
        if (code === 0 && stdout.trim()) {
          resolve(stdout);
        } else {
          reject(new Error(
            `Queen reconciliation failed (exit=${code}): ${stderr.slice(0, 500)}`
          ));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child.pid!);
        reject(err);
      });
    });
  }

  // ==========================================================================
  // Cancellation
  // ==========================================================================

  cancelAll(): void {
    for (const [pid, child] of this.activeProcesses) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
      this.activeProcesses.delete(pid);
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => { this.cancelAll(); };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  private buildDualModeQueenHeader(): string {
    return `You are the Queen Reviewer running a dual-model AI Consortium PR Review.
Agents from two model families (Claude Opus and Codex GPT 5.4) independently reviewed the same PR.
Each role was assigned to both models. Your job:

1. PAIR AGREEMENT: For each role (Security, Logic, Integration), compare Claude vs Codex findings.
   - Findings both models agree on: confirmed (boost confidence)
   - Findings only one model found: flag as single-source (lower confidence)
   - Findings where models disagree on severity: resolve with reasoning

2. CROSS-ROLE DEBATE: Check for disagreements across the 3 roles.
   - If Security says critical but Logic says low: reconcile
   - If Integration flags a breaking change not mentioned by others: investigate

3. COMPILE REPORT in this exact format:

   # AI Consortium PR Review (Dual-Model)

   ## Overview
   2-3 sentence summary

   ## Pair Agreement (Opus vs Codex GPT 5.4)
   For each role: how many findings agreed, how many disagreed, resolution

   ## Triaged Findings

   ### Critical / High
   Table: #, Role, Models, Finding, File, Confidence

   ### Suggestions for Improvement
   Table: #, Role, Models, Finding, Confidence

   ## Suggested Fixes
   For EVERY finding above, include a concrete, actionable fix.
   Group by file for easy application.

   ## Cross-Model Debate Notes
   Where Opus and Codex disagreed and how it was resolved

   ## Final Recommendation
   Approve / Request Changes / Comment — with rationale

4. Print ONLY the report. Nothing else.

---
`;
  }

  private buildSingleModeQueenHeader(): string {
    return `You are the Queen Reviewer running an AI Consortium PR Review.
Specialist agents have independently reviewed a PR. Your job:

1. Compare findings across agents and resolve disagreements
2. Compile a triaged report with concrete suggested fixes for every finding

Format:

   # AI Consortium PR Review

   ## Overview
   2-3 sentence summary

   ## Triaged Findings
   ### Critical / High
   Table: #, Agent, Finding, File, Confidence

   ### Suggestions for Improvement
   Table: #, Agent, Finding, Confidence

   ## Suggested Fixes
   For EVERY finding above, include a concrete, actionable fix.
   Group by file for easy application.

   ## Debate Notes
   Where agents agreed/disagreed

   ## Final Recommendation
   Approve / Request Changes / Comment — with rationale

Print ONLY the report.

---
`;
  }

  private buildPRContext(review: ReviewContext): string {
    const { metadata, pr } = review;
    return `
## PR Context
- PR: #${pr.number} in ${pr.owner}/${pr.repo}
- Title: ${metadata.title}
- Author: ${metadata.author}
- Branch: ${metadata.headBranch} -> ${metadata.baseBranch}
- Changes: +${metadata.additions}/-${metadata.deletions} across ${metadata.changedFiles.length} files
`;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createReviewDispatcher(
  config?: Partial<DispatchConfig>,
): ReviewDispatcher {
  return new ReviewDispatcher(config);
}

export default ReviewDispatcher;
