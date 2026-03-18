/**
 * V3 Review Command
 *
 * Multi-agent PR review orchestration with dual-model dispatch,
 * full codebase access via worktree, pair agreement, and queen reconciliation.
 *
 * Commands:
 * - review init      Start a new review (full pipeline)
 * - review status    Check review progress
 * - review list      List all reviews
 * - review report    Display review report
 * - review chat      Post-review Q&A (launches interactive claude)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { createReviewService } from '../services/review-service.js';
import { createReviewDispatcher } from '../services/review-dispatcher.js';
import { parsePRUrl } from '../services/review-types.js';
import type {
  ReviewStatus,
  PRIdentifier,
  AgentRole,
  DispatchConfig,
  ModelProvider,
} from '../services/review-types.js';
import { DEFAULT_DISPATCH_CONFIG } from '../services/review-types.js';

// ============================================================================
// Helpers
// ============================================================================

function resolvePR(ctx: CommandContext): PRIdentifier {
  const url = ctx.flags.url as string | undefined;
  if (url) return parsePRUrl(url);

  const owner = ctx.flags.owner as string | undefined;
  const repo = ctx.flags.repo as string | undefined;
  const pr = ctx.flags.pr as string | undefined;

  if (owner && repo && pr) {
    const num = parseInt(pr, 10);
    if (isNaN(num)) throw new Error(`Invalid PR number: ${pr}`);
    return {
      owner,
      repo,
      number: num,
      url: `https://github.com/${owner}/${repo}/pull/${num}`,
    };
  }

  // Try positional arg
  const positional = ctx.args[0];
  if (positional) return parsePRUrl(positional);

  throw new Error(
    'PR identifier required. Use --url <URL>, --owner/--repo/--pr flags, or pass as argument.'
  );
}

function formatStatus(status: ReviewStatus): string {
  const icons: Record<ReviewStatus, string> = {
    initializing: '...',
    reviewing: '>>',
    'pair-agreeing': '==',
    debating: '<>',
    compiling: '[]',
    completed: 'OK',
    error: '!!',
  };
  return `${icons[status] || '??'} ${status}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function buildDispatchConfig(ctx: CommandContext): Partial<DispatchConfig> {
  const config: Partial<DispatchConfig> = {};
  if (ctx.flags['claude-model']) config.claudeModel = ctx.flags['claude-model'] as string;
  if (ctx.flags['codex-model']) config.codexModel = ctx.flags['codex-model'] as string;
  if (ctx.flags['agent-budget']) config.agentBudget = Number(ctx.flags['agent-budget']);
  if (ctx.flags['reconcile-budget']) config.reconcileBudget = Number(ctx.flags['reconcile-budget']);
  if (ctx.flags.verbose) config.verbose = true;
  if (ctx.flags['log-file']) config.logFile = ctx.flags['log-file'] as string;
  if (ctx.flags['claude-only']) config.dualMode = false;
  return config;
}

/**
 * Build a short system prompt that tells claude to read the full context from a file.
 * Passing the entire context as a CLI argument breaks when it contains backticks,
 * braces, or other shell-special characters, and can exceed OS argument size limits.
 */
function buildChatSystemPrompt(contextFile: string, reviewDir: string): string {
  return [
    `You are the Queen Reviewer in post-review chat mode.`,
    `The full review context (PR metadata, all agent findings, and the compiled report) is at:`,
    `  ${contextFile}`,
    ``,
    `IMMEDIATELY read that file with the Read tool before answering any question.`,
    `Answer based on the review data. If asked to re-check something, reason from the findings and diff.`,
  ].join('\n');
}

/**
 * Launch interactive claude with review context.
 * Uses a short system prompt pointing to the context file on disk.
 */
function launchChat(contextFile: string, reviewDir: string, model: string): void {
  const systemPrompt = buildChatSystemPrompt(contextFile, reviewDir);
  try {
    execFileSync('claude', [
      '--model', model,
      '--append-system-prompt', systemPrompt,
    ], { stdio: 'inherit' });
  } catch {
    // claude exits with non-zero on user quit — not an error
  }
}

/**
 * Find the most recent review directory under ~/.claude/reviews/
 */
function findLatestReviewDir(): string | null {
  const base = path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.claude', 'reviews',
  );
  if (!fs.existsSync(base)) return null;

  const entries = fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, path: path.join(base, d.name) }))
    .filter(d => fs.existsSync(path.join(d.path, 'context.md')))
    .sort((a, b) => {
      const aStat = fs.statSync(a.path);
      const bStat = fs.statSync(b.path);
      return bStat.mtimeMs - aStat.mtimeMs;
    });

  return entries.length > 0 ? entries[0].path : null;
}

// ============================================================================
// Subcommands
// ============================================================================

const initCommand: Command = {
  name: 'init',
  description: 'Start a new multi-agent PR review (full pipeline)',
  options: [
    { name: 'url', short: 'u', type: 'string', description: 'Full PR URL (https://github.com/owner/repo/pull/123)' },
    { name: 'owner', short: 'o', type: 'string', description: 'Repository owner' },
    { name: 'repo', short: 'r', type: 'string', description: 'Repository name' },
    { name: 'pr', short: 'p', type: 'string', description: 'PR number' },
    { name: 'skip-worktree', type: 'boolean', default: false, description: 'Skip worktree creation (diff-only mode)' },
    { name: 'skip-debate', type: 'boolean', default: false, description: 'Skip debate loop' },
    { name: 'verbose', short: 'v', type: 'boolean', default: false, description: 'Debug logging to terminal' },
    { name: 'log-file', type: 'string', description: 'Custom log file path' },
    { name: 'claude-model', type: 'string', description: 'Claude model (default: opus, env: CLAUDE_MODEL)' },
    { name: 'codex-model', type: 'string', description: 'Codex model (default: gpt-5.4, env: CODEX_MODEL)' },
    { name: 'agent-budget', type: 'string', description: 'Max USD per agent (default: 25, env: AGENT_BUDGET)' },
    { name: 'reconcile-budget', type: 'string', description: 'Max USD for queen reconciliation (default: 50, env: RECONCILE_BUDGET)' },
    { name: 'claude-only', type: 'boolean', default: false, description: 'Skip Codex agents (Claude-only mode)' },
    { name: 'no-chat', type: 'boolean', default: false, description: 'Skip interactive chat after review completes' },
    { name: 'force', type: 'boolean', default: false, description: 'Force a new review even if one already exists for this PR' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const startTime = Date.now();
    let pr: PRIdentifier;
    try {
      pr = resolvePR(ctx);
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }

    const dispatchConfig = buildDispatchConfig(ctx);
    const verbose = !!ctx.flags.verbose;

    output.writeln();
    output.writeln(output.bold('AI Consortium PR Review'));
    output.writeln(output.dim(`PR #${pr.number} — ${pr.owner}/${pr.repo}`));
    output.writeln();

    const service = createReviewService(ctx.cwd);
    await service.initialize();

    // Check for existing completed review of this PR
    if (!ctx.flags.force) {
      const existing = service.findReviewForPR(pr);
      if (existing) {
        // Find the artifact directory for the existing review
        const prefix = `${pr.owner}-${pr.repo}-${pr.number}`;
        const base = path.join(
          process.env.HOME || process.env.USERPROFILE || '.',
          '.claude', 'reviews',
        );
        let artifactDir: string | null = null;
        if (fs.existsSync(base)) {
          const entries = fs.readdirSync(base, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith(prefix))
            .map(d => path.join(base, d.name))
            .filter(d => fs.existsSync(path.join(d, 'context.md')))
            .sort()
            .reverse();
          if (entries.length > 0) artifactDir = entries[0];
        }

        output.writeln(`  Previous review found: ${existing.id.slice(0, 8)}`);
        output.writeln(`  Status: ${formatStatus(existing.status)}`);
        output.writeln(`  Created: ${new Date(existing.createdAt).toLocaleString()}`);
        output.writeln(`  Last updated: ${new Date(existing.updatedAt).toLocaleString()}`);
        output.writeln(`  Findings: ${existing.agentFindings.reduce((n, af) => n + af.findings.length, 0)}`);
        if (artifactDir) {
          output.writeln(`  Artifacts: ${artifactDir}`);
        }
        output.writeln();
        output.writeln(output.dim('  Use --force to run a fresh review.'));
        output.writeln();

        // Jump to chat if artifacts exist
        if (artifactDir && !ctx.flags['no-chat']) {
          const contextFile = path.join(artifactDir, 'context.md');
          const reportFile = path.join(artifactDir, 'report.md');

          // Display the report first
          if (fs.existsSync(reportFile)) {
            output.writeln(fs.readFileSync(reportFile, 'utf-8'));
            output.writeln();
          }

          const chatModel = (ctx.flags['claude-model'] as string) || DEFAULT_DISPATCH_CONFIG.claudeModel;
          output.writeln('Entering chat mode — ask follow-up questions about the review.');
          output.writeln(output.dim('(Use --no-chat to skip this, or Ctrl+C to exit)'));
          output.writeln();
          launchChat(contextFile, artifactDir, chatModel);
        }

        return {
          success: true,
          data: {
            reviewId: existing.id,
            reviewDir: artifactDir,
            pr,
            reused: true,
          },
        };
      }
    }

    // Step 1: Validate local repo
    let repoPath: string;
    try {
      repoPath = service.validateLocalRepo(pr);
      output.writeln(`  Local repo: ${repoPath}`);
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }

    // Step 2: Fetch PR metadata
    output.writeln('  Fetching PR metadata...');
    let metadata;
    try {
      metadata = service.fetchPRMetadata(pr, repoPath);
      output.writeln(`  Title: ${metadata.title}`);
      output.writeln(`  Author: ${metadata.author}`);
      output.writeln(`  Changes: +${metadata.additions}/-${metadata.deletions} across ${metadata.changedFiles.length} files`);
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }

    // Step 3: Create worktree (kept alive during entire review)
    let worktreePath: string | undefined;
    let hasCodebaseAccess = false;
    if (!ctx.flags['skip-worktree']) {
      try {
        output.writeln('  Creating isolated worktree...');
        worktreePath = service.createWorktree(pr, repoPath);
        hasCodebaseAccess = true;
        output.writeln(`  Worktree: ${worktreePath}`);
      } catch (error) {
        output.writeln(output.dim(`  Worktree creation failed (diff-only mode): ${error instanceof Error ? error.message : String(error)}`));
      }
    } else {
      output.writeln(output.dim('  Worktree skipped (diff-only mode)'));
    }

    // Step 4: Create review context
    const review = service.createReview(pr, metadata, worktreePath);
    output.writeln(`  Review ID: ${review.id}`);
    output.writeln();

    // Step 5: Check codex availability, set dualMode
    const dispatcher = createReviewDispatcher(dispatchConfig);
    const codexAvailable = !ctx.flags['claude-only'] && dispatcher.isCodexAvailable();
    const dualMode = codexAvailable;

    if (dualMode) {
      output.writeln(output.bold('Agent Dispatch (Dual-Model: Opus + Codex GPT 5.4)'));
      output.writeln('  Each role runs independently on both models:');
    } else {
      if (ctx.flags['claude-only']) {
        output.writeln(output.bold('Agent Dispatch (Claude-Only Mode)'));
      } else {
        output.writeln(output.bold('Agent Dispatch (Claude-Only — Codex CLI not found)'));
      }
      output.writeln('  3 specialist agents:');
    }
    output.writeln();

    // Step 6: Build prompt files
    const roles: AgentRole[] = ['security-auditor', 'logic-checker', 'integration-specialist'];
    const tmpDir = fs.mkdtempSync(path.join(
      process.env.TMPDIR || '/tmp',
      'review-',
    ));
    const promptFiles = new Map<string, string>();

    for (const role of roles) {
      // Claude prompt
      const claudePrompt = service.buildAgentPromptForProvider(role, review, 'claude', hasCodebaseAccess);
      const claudeFile = path.join(tmpDir, `prompt-${role}-claude.txt`);
      fs.writeFileSync(claudeFile, claudePrompt);
      promptFiles.set(`${role}-claude`, claudeFile);

      if (dualMode) {
        const codexPrompt = service.buildAgentPromptForProvider(role, review, 'codex', hasCodebaseAccess);
        const codexFile = path.join(tmpDir, `prompt-${role}-codex.txt`);
        fs.writeFileSync(codexFile, codexPrompt);
        promptFiles.set(`${role}-codex`, codexFile);
      }
    }

    const totalAgents = dualMode ? 6 : 3;
    output.writeln(`  ${totalAgents} prompts prepared (${roles.length} roles x ${dualMode ? 2 : 1} provider${dualMode ? 's' : ''})`);
    output.writeln();

    // Step 7: Dispatch agents
    review.status = 'reviewing';
    service.saveReview(review);

    output.writeln(output.bold('[Phase 1] Independent review'));
    const agents = dispatcher.dispatchAgents(review, promptFiles, worktreePath);
    output.writeln(`  ${agents.length} agents dispatched`);
    for (const agent of agents) {
      output.writeln(`  [..] ${agent.label}  pid=${agent.pid}`);
    }
    output.writeln();

    // Step 8: Monitor agents
    dispatcher.on('agent:complete', (agent) => {
      const elapsed = formatDuration(Date.now() - agent.startTime);
      if (agent.status === 'succeeded') {
        output.writeln(`  [OK] ${agent.label}  (${elapsed}, ${agent.outputSize}B)`);
      } else {
        output.writeln(`  [!!] ${agent.label}  FAILED (exit=${agent.exitCode}, ${elapsed})`);
      }
    });

    await dispatcher.monitorAgents(agents);

    const succeeded = agents.filter(a => a.status === 'succeeded');
    const failed = agents.filter(a => a.status === 'failed');
    output.writeln();
    output.writeln(`  Phase 1 complete: ${succeeded.length} succeeded, ${failed.length} failed out of ${agents.length}`);

    if (succeeded.length === 0) {
      review.status = 'error';
      review.error = 'All agents failed';
      service.saveReview(review);

      // Cleanup worktree
      if (worktreePath) service.cleanupWorktree(worktreePath, repoPath);

      output.printError('All agents failed. Check log files for details.');
      if (verbose) {
        for (const agent of agents) {
          output.writeln(output.dim(`  Log: ${agent.logPath}`));
        }
      }
      return { success: false, exitCode: 1 };
    }

    // Step 9: Parse agent outputs
    const agentOutputs = new Map<string, string>();
    for (const agent of succeeded) {
      const content = fs.readFileSync(agent.outputPath, 'utf-8');
      agentOutputs.set(agent.label, content);

      const durationMs = Date.now() - agent.startTime;
      const model = agent.provider === 'claude'
        ? (dispatchConfig.claudeModel || DEFAULT_DISPATCH_CONFIG.claudeModel)
        : (dispatchConfig.codexModel || DEFAULT_DISPATCH_CONFIG.codexModel);

      const agentName = `${agent.role}-${agent.provider}`;
      const findings = service.parseAgentOutput(agentName, model, content, durationMs);
      review.agentFindings.push(findings);
    }

    // Step 10: Pair agreement (if dual mode)
    if (dualMode) {
      output.writeln();
      output.writeln(output.bold('[Phase 2] Pair agreement'));
      review.status = 'pair-agreeing';
      service.saveReview(review);

      const agreements = service.runPairAgreement(review);
      review.pairAgreements = agreements;

      for (const pa of agreements) {
        output.writeln(`  ${pa.role}: ${pa.agreedFindings.length} agreed, ${pa.disagreements.length} single-source (${pa.resolution})`);
      }
    }

    // Step 10b: Debate loop for disputed findings
    if (!ctx.flags['skip-debate']) {
      const disputed = service.findDisagreements(review.agentFindings);
      if (disputed.length > 0) {
        const debatePhase = dualMode ? 3 : 2;
        output.writeln();
        output.writeln(output.bold(`[Phase ${debatePhase}] Debate loop (${disputed.length} disputed, 2/3 quorum, max 3 rounds)`));
        review.status = 'debating';
        service.saveReview(review);

        const debates = service.runDebateLoop(review, (finding, round) => {
          output.writeln(output.dim(`  Round ${round}: ${finding.title} (${finding.file || 'general'})`));
          return dispatcher.resolveDebatePositions(finding, round, review);
        });

        review.debates = debates;
        service.saveReview(review);

        const consensus = debates.filter(d => d.resolution === 'consensus').length;
        const majority = debates.filter(d => d.resolution === 'majority').length;
        const queenOverride = debates.filter(d => d.resolution === 'queen-override').length;
        output.writeln(`  Resolved: ${consensus} consensus, ${majority} majority, ${queenOverride} queen-override`);
      } else {
        output.writeln();
        output.writeln(output.dim('  No disputed findings — skipping debate loop'));
      }
    }

    // Step 11: Queen reconciliation
    const queenPhase = dualMode ? (ctx.flags['skip-debate'] ? 3 : 4) : (ctx.flags['skip-debate'] ? 2 : 3);
    output.writeln();
    output.writeln(output.bold(`[Phase ${queenPhase}] Queen reconciliation`));
    review.status = 'compiling';
    service.saveReview(review);

    let reportMarkdown: string;
    try {
      reportMarkdown = await dispatcher.runReconciliation(
        review,
        agentOutputs,
        review.pairAgreements,
        dualMode,
      );
    } catch (error) {
      // Fall back to algorithmic report compilation
      output.writeln(output.dim(`  Queen reconciliation failed, using algorithmic report: ${error instanceof Error ? error.message : String(error)}`));
      const report = service.compileReport(review);
      review.report = report;
      reportMarkdown = report.markdown;
    }

    // Step 12: Persist artifacts
    review.status = 'completed';
    service.saveReview(review);

    const reviewDir = service.persistArtifacts(review, agentOutputs, reportMarkdown);

    const totalElapsed = formatDuration(Date.now() - startTime);
    output.writeln();
    output.writeln('--- Review complete ---');
    output.writeln(`  Agents: ${succeeded.length}/${agents.length} succeeded`);
    output.writeln(`  Total time: ${totalElapsed}`);
    output.writeln(`  Artifacts: ${reviewDir}`);
    output.writeln();

    // Step 13: Display report
    output.writeln(reportMarkdown);
    output.writeln();

    // Step 14: Cleanup worktree
    if (worktreePath) {
      service.cleanupWorktree(worktreePath, repoPath);
      if (verbose) output.writeln(output.dim('  Worktree cleaned up'));
    }

    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }

    // Step 15: Launch interactive chat (default) or print instructions
    if (ctx.flags['no-chat']) {
      output.writeln('To chat about this review:');
      output.writeln(output.dim(`  ruflo review chat ${review.id}`));
      output.writeln(output.dim('  ./scripts/review-pr.sh --chat'));
      output.writeln();
    } else {
      const contextFile = path.join(reviewDir, 'context.md');
      if (fs.existsSync(contextFile)) {
        const chatModel = (ctx.flags['claude-model'] as string) || DEFAULT_DISPATCH_CONFIG.claudeModel;
        output.writeln('Entering chat mode — ask follow-up questions about the review.');
        output.writeln(output.dim('(Use --no-chat to skip this, or Ctrl+C to exit)'));
        output.writeln();
        launchChat(contextFile, reviewDir, chatModel);
      }
    }

    return {
      success: true,
      data: {
        reviewId: review.id,
        reviewDir,
        pr,
        succeeded: succeeded.length,
        failed: failed.length,
        dualMode,
      },
    };
  },
};

const statusCommand: Command = {
  name: 'status',
  description: 'Check review progress',
  options: [
    { name: 'json', type: 'boolean', default: false, description: 'Output as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const id = ctx.args[0] as string;
    if (!id) {
      output.printError('Review ID is required. Usage: ruflo review status <id>');
      return { success: false, exitCode: 1 };
    }

    const service = createReviewService(ctx.cwd);
    await service.initialize();

    const review = service.getReview(id);
    if (!review) {
      output.printError(`Review not found: ${id}`);
      return { success: false, exitCode: 1 };
    }

    if (ctx.flags.json) {
      output.printJson(review);
      return { success: true, data: review };
    }

    output.writeln();
    output.writeln(output.bold('Review Status'));
    output.writeln();
    output.printBox([
      `ID: ${review.id}`,
      `PR: ${review.pr.owner}/${review.pr.repo}#${review.pr.number}`,
      `Title: ${review.metadata.title}`,
      `Status: ${formatStatus(review.status)}`,
      `Agents reported: ${review.agentFindings.length}/3`,
      `Debates: ${review.debates.length}`,
      `Findings: ${review.agentFindings.reduce((n, af) => n + af.findings.length, 0)}`,
      review.report ? `Recommendation: ${review.report.recommendation}` : '',
    ].filter(Boolean).join('\n'), 'Review');

    return { success: true, data: review };
  },
};

const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all reviews',
  options: [
    { name: 'status', short: 's', type: 'string', description: 'Filter by status', choices: ['initializing', 'reviewing', 'debating', 'compiling', 'completed', 'error'] },
    { name: 'limit', short: 'l', type: 'number', description: 'Max results', default: 20 },
    { name: 'json', type: 'boolean', default: false, description: 'Output as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const service = createReviewService(ctx.cwd);
    await service.initialize();

    const statusFilter = ctx.flags.status as ReviewStatus | undefined;
    const limit = (ctx.flags.limit as number) || 20;
    const reviews = service.listReviews(statusFilter).slice(0, limit);

    if (reviews.length === 0) {
      output.printInfo('No reviews found.');
      return { success: true, data: { reviews: [] } };
    }

    if (ctx.flags.json) {
      output.printJson(reviews);
      return { success: true, data: { reviews } };
    }

    output.writeln();
    output.writeln(output.bold('PR Reviews'));
    output.writeln();

    const rows = reviews.map(r => ({
      id: r.id.slice(0, 8),
      pr: `${r.pr.owner}/${r.pr.repo}#${r.pr.number}`,
      title: r.metadata.title.slice(0, 40),
      status: formatStatus(r.status),
      findings: String(r.agentFindings.reduce((n, af) => n + af.findings.length, 0)),
      updated: new Date(r.updatedAt).toLocaleDateString(),
    }));

    output.printTable({
      columns: [
        { key: 'id', header: 'ID', width: 10 },
        { key: 'pr', header: 'PR', width: 24 },
        { key: 'title', header: 'Title', width: 42 },
        { key: 'status', header: 'Status', width: 16 },
        { key: 'findings', header: 'Findings', width: 10 },
        { key: 'updated', header: 'Updated', width: 12 },
      ],
      data: rows,
    });

    return { success: true, data: { reviews } };
  },
};

const reportCommand: Command = {
  name: 'report',
  description: 'Display review report',
  options: [
    { name: 'format', short: 'f', type: 'string', description: 'Output format', choices: ['markdown', 'json'], default: 'markdown' },
    { name: 'output', short: 'o', type: 'string', description: 'Write to file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const id = ctx.args[0] as string;
    if (!id) {
      output.printError('Review ID is required. Usage: ruflo review report <id>');
      return { success: false, exitCode: 1 };
    }

    const service = createReviewService(ctx.cwd);
    await service.initialize();

    const review = service.getReview(id);
    if (!review) {
      output.printError(`Review not found: ${id}`);
      return { success: false, exitCode: 1 };
    }

    if (!review.report) {
      output.printError('Report not yet compiled. Review may still be in progress.');
      output.printInfo(`Status: ${formatStatus(review.status)}`);
      return { success: false, exitCode: 1 };
    }

    const format = ctx.flags.format as string;
    const outputPath = ctx.flags.output as string | undefined;

    if (format === 'json') {
      const json = JSON.stringify(review.report, null, 2);
      if (outputPath) {
        fs.writeFileSync(outputPath, json);
        output.printSuccess(`Report written to ${outputPath}`);
      } else {
        output.printJson(review.report);
      }
    } else {
      if (outputPath) {
        fs.writeFileSync(outputPath, review.report.markdown);
        output.printSuccess(`Report written to ${outputPath}`);
      } else {
        output.writeln(review.report.markdown);
      }
    }

    return { success: true, data: review.report };
  },
};

const chatCommand: Command = {
  name: 'chat',
  description: 'Post-review interactive Q&A (launches claude with review context)',
  options: [
    { name: 'dir', short: 'd', type: 'string', description: 'Explicit review directory path' },
    { name: 'model', short: 'm', type: 'string', description: 'Claude model for chat (default: opus)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const id = ctx.args[0] as string | undefined;
    const explicitDir = ctx.flags.dir as string | undefined;
    const model = (ctx.flags.model as string) || 'opus';

    let reviewDir: string | null = null;

    if (explicitDir) {
      // Explicit directory path
      if (!fs.existsSync(path.join(explicitDir, 'context.md'))) {
        output.printError(`No review context at ${explicitDir}/context.md`);
        return { success: false, exitCode: 1 };
      }
      reviewDir = explicitDir;
    } else if (id) {
      // Try to find review by ID in the service
      const service = createReviewService(ctx.cwd);
      await service.initialize();
      const review = service.getReview(id);

      if (review) {
        // Find the artifact directory by looking for the most recent matching one
        const base = path.join(
          process.env.HOME || process.env.USERPROFILE || '.',
          '.claude', 'reviews',
        );
        if (fs.existsSync(base)) {
          const prefix = `${review.pr.owner}-${review.pr.repo}-${review.pr.number}`;
          const entries = fs.readdirSync(base)
            .filter(d => d.startsWith(prefix))
            .sort()
            .reverse();
          if (entries.length > 0) {
            reviewDir = path.join(base, entries[0]);
          }
        }
      }

      if (!reviewDir) {
        output.printError(`Review artifacts not found for: ${id}`);
        return { success: false, exitCode: 1 };
      }
    } else {
      // Find most recent review
      reviewDir = findLatestReviewDir();
      if (!reviewDir) {
        output.printError('No reviews found. Run a review first: ruflo review init --url <PR_URL>');
        return { success: false, exitCode: 1 };
      }
    }

    const contextFile = path.join(reviewDir, 'context.md');
    if (!fs.existsSync(contextFile)) {
      output.printError(`No context.md in review directory: ${reviewDir}`);
      return { success: false, exitCode: 1 };
    }

    output.writeln(`Entering chat mode for review: ${path.basename(reviewDir)}`);
    output.writeln(`Context: ${contextFile}`);
    output.writeln();

    launchChat(contextFile, reviewDir, model);

    return { success: true };
  },
};

const cleanupCommand: Command = {
  name: 'cleanup',
  description: 'Remove stale reviews and their artifacts',
  options: [
    { name: 'max-age', type: 'string', description: 'Max age in days before cleanup (default: 21)', default: '21' },
    { name: 'dry-run', type: 'boolean', default: false, description: 'Show what would be removed without deleting' },
    { name: 'json', type: 'boolean', default: false, description: 'Output as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const maxAgeDays = parseInt(ctx.flags['max-age'] as string, 10) || 21;
    const dryRun = !!ctx.flags['dry-run'];

    const service = createReviewService(ctx.cwd);
    await service.initialize();

    // Find stale reviews first (for dry-run or display)
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const all = service.listReviews();
    const stale = all.filter(r => new Date(r.updatedAt).getTime() < cutoff);

    if (stale.length === 0) {
      output.printInfo(`No reviews older than ${maxAgeDays} days.`);
      return { success: true, data: { removed: [] } };
    }

    output.writeln();
    output.writeln(output.bold(`${dryRun ? '[Dry Run] ' : ''}Review Cleanup (older than ${maxAgeDays} days)`));
    output.writeln();

    if (dryRun) {
      for (const r of stale) {
        output.writeln(`  ${r.id.slice(0, 8)}  ${r.pr.owner}/${r.pr.repo}#${r.pr.number}  updated ${new Date(r.updatedAt).toLocaleDateString()}`);
      }
      output.writeln();
      output.writeln(`  ${stale.length} review(s) would be removed. Run without --dry-run to delete.`);

      if (ctx.flags.json) {
        output.printJson(stale.map(r => ({
          id: r.id,
          pr: `${r.pr.owner}/${r.pr.repo}#${r.pr.number}`,
          updatedAt: r.updatedAt,
        })));
      }

      return { success: true, data: { wouldRemove: stale.length } };
    }

    const removed = service.cleanupStaleReviews(maxAgeDays);

    for (const r of removed) {
      output.writeln(`  Removed: ${r.id.slice(0, 8)}  ${r.pr}  (last updated ${new Date(r.updatedAt).toLocaleDateString()})`);
    }
    output.writeln();
    output.writeln(`  ${removed.length} review(s) cleaned up.`);

    if (ctx.flags.json) {
      output.printJson(removed);
    }

    return { success: true, data: { removed } };
  },
};

// ============================================================================
// Main Command
// ============================================================================

export const reviewCommand: Command = {
  name: 'review',
  description: 'Multi-agent PR review with dual-model dispatch and codebase access',
  subcommands: [
    initCommand,
    statusCommand,
    listCommand,
    reportCommand,
    chatCommand,
    cleanupCommand,
  ],
  examples: [
    { command: 'ruflo review init --url https://github.com/org/repo/pull/123', description: 'Full pipeline review' },
    { command: 'ruflo review init --url <URL> --claude-only', description: 'Claude-only review (no Codex)' },
    { command: 'ruflo review init --url <URL> --skip-worktree', description: 'Diff-only mode (no codebase access)' },
    { command: 'ruflo review init --url <URL> --force', description: 'Force new review even if one exists' },
    { command: 'ruflo review status <id>', description: 'Check review progress' },
    { command: 'ruflo review list', description: 'List all reviews' },
    { command: 'ruflo review report <id>', description: 'Display review report' },
    { command: 'ruflo review chat <id>', description: 'Interactive Q&A about findings' },
    { command: 'ruflo review chat --dir <path>', description: 'Chat with explicit review directory' },
    { command: 'ruflo review cleanup', description: 'Remove reviews older than 3 weeks' },
    { command: 'ruflo review cleanup --max-age 7 --dry-run', description: 'Preview cleanup of reviews older than 7 days' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('AI Consortium PR Review'));
    output.writeln(output.dim('Dual-model review with full codebase access'));
    output.writeln();
    output.writeln('Commands:');
    output.printList([
      'init     - Start a new review (full pipeline: dispatch, monitor, reconcile)',
      'status   - Check review progress',
      'list     - List all reviews',
      'report   - Display review report',
      'chat     - Interactive Q&A about findings (launches claude)',
      'cleanup  - Remove stale reviews (default: older than 3 weeks)',
    ]);
    output.writeln();
    output.writeln('Example:');
    output.writeln(output.dim('  ruflo review init --url https://github.com/org/repo/pull/123'));
    return { success: true };
  },
};

export default reviewCommand;
