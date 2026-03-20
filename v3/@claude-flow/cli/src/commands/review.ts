/**
 * V3 Review Command
 *
 * Multi-agent PR review orchestration with dual-model dispatch,
 * full codebase access via worktree, pair agreement, and queen reconciliation.
 *
 * Commands:
 * - review init      Start a new review (full pipeline)
 * - review iterate   Re-review a PR (diff against previous review)
 * - review status    Check review progress
 * - review list      List all reviews
 * - review report    Display review report
 * - review chat      Post-review Q&A (launches interactive claude)
 * - review comment   List, post, and reply to PR comments
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { createReviewService } from '../services/review-service.js';
import { createReviewDispatcher } from '../services/review-dispatcher.js';
import { createPRCommentService } from '../services/review-comments.js';
import { parsePRUrl } from '../services/review-types.js';
import type {
  ReviewStatus,
  PRIdentifier,
  AgentRole,
  DispatchConfig,
  ModelProvider,
  Finding,
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
function buildChatSystemPrompt(contextFile: string, reviewDir: string, reviewId?: string): string {
  const commentSection = reviewId ? [
    ``,
    `You can interact with PR comments using these commands via Bash:`,
    `  ruflo review comment list ${reviewId}`,
    `  ruflo review comment post ${reviewId} --file <path> --line <num> --body "text"`,
    `  ruflo review comment reply ${reviewId} --comment-id <num> --body "text"`,
    `Only use these when the user explicitly asks to post or reply to comments.`,
  ].join('\n') : '';

  return [
    `You are the Queen Reviewer in post-review chat mode.`,
    `The full review context (PR metadata, all agent findings, and the compiled report) is at:`,
    `  ${contextFile}`,
    ``,
    `IMMEDIATELY read that file with the Read tool before answering any question.`,
    `Answer based on the review data. If asked to re-check something, reason from the findings and diff.`,
    commentSection,
  ].join('\n');
}

/**
 * Prompt the user with a y/N question. Returns true if user answers 'y' or 'yes'.
 */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/**
 * Launch interactive claude with review context.
 * Uses a short system prompt pointing to the context file on disk.
 */
function launchChat(contextFile: string, reviewDir: string, model: string, reviewId?: string): void {
  const systemPrompt = buildChatSystemPrompt(contextFile, reviewDir, reviewId);
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
// Shared Review Pipeline
// ============================================================================

interface PipelineOptions {
  pr: PRIdentifier;
  cwd: string;
  dispatchConfig: Partial<DispatchConfig>;
  verbose: boolean;
  skipWorktree: boolean;
  skipDebate: boolean;
  claudeOnly: boolean;
  noChat: boolean;
  autoComment: boolean;
  claudeModel?: string;
  /** If set, this is an iterative re-review against previousReview */
  previousReview?: import('../services/review-types.js').ReviewContext | null;
}

/**
 * Shared pipeline used by both `init` and `iterate` commands.
 * Handles: repo validation, metadata fetch, worktree, agent dispatch,
 * pair agreement, debate, queen reconciliation, persist, auto-comment, chat.
 */
async function runReviewPipeline(opts: PipelineOptions): Promise<CommandResult> {
  const {
    pr, cwd, dispatchConfig, verbose, skipWorktree, skipDebate,
    claudeOnly, noChat, autoComment, claudeModel, previousReview,
  } = opts;
  const startTime = Date.now();

  const service = createReviewService(cwd);
  await service.initialize();

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

  // Step 3: Create worktree
  let worktreePath: string | undefined;
  let hasCodebaseAccess = false;
  if (!skipWorktree) {
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

  // Step 4b: Build iteration context (if iterating)
  let iterationContext = '';
  if (previousReview) {
    output.writeln('  Computing delta against previous review...');
    const commentService = createPRCommentService(pr);
    const delta = service.fetchPRDelta(pr, previousReview.metadata, repoPath);
    const commentThreads = commentService.getCommentThreads();
    iterationContext = service.buildIterationContext(previousReview, delta, commentThreads);
    review.iterationOf = previousReview.id;
    service.saveReview(review);

    output.writeln(`  Files changed since last review: ${delta.changedSinceReview.length}`);
    output.writeln(`  Files unchanged: ${delta.unchangedFiles.length}`);
    output.writeln(`  Comment threads: ${commentThreads.length}`);
  }

  output.writeln();

  // Step 5: Check codex availability, set dualMode
  const dispatcher = createReviewDispatcher(dispatchConfig);
  const codexAvailable = !claudeOnly && dispatcher.isCodexAvailable();
  const dualMode = codexAvailable;

  if (dualMode) {
    output.writeln(output.bold('Agent Dispatch (Dual-Model: Opus + Codex GPT 5.4)'));
    output.writeln('  Each role runs independently on both models:');
  } else {
    if (claudeOnly) {
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
    let claudePrompt = service.buildAgentPromptForProvider(role, review, 'claude', hasCodebaseAccess);
    if (iterationContext) claudePrompt += '\n\n' + iterationContext;
    const claudeFile = path.join(tmpDir, `prompt-${role}-claude.txt`);
    fs.writeFileSync(claudeFile, claudePrompt);
    promptFiles.set(`${role}-claude`, claudeFile);

    if (dualMode) {
      let codexPrompt = service.buildAgentPromptForProvider(role, review, 'codex', hasCodebaseAccess);
      if (iterationContext) codexPrompt += '\n\n' + iterationContext;
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

  // Step 10b: Debate loop
  if (!skipDebate) {
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
  const queenPhase = dualMode ? (skipDebate ? 3 : 4) : (skipDebate ? 2 : 3);
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
    output.writeln(output.dim(`  Queen reconciliation failed, using algorithmic report: ${error instanceof Error ? error.message : String(error)}`));
    const report = service.compileReport(review);
    review.report = report;
    reportMarkdown = report.markdown;
  }

  // Step 12: Persist artifacts
  review.status = 'completed';
  service.saveReview(review);

  const reviewDir = service.persistArtifacts(review, agentOutputs, reportMarkdown);

  // For iterative reviews, also save as updated-report-<timestamp>.md
  if (previousReview) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(reviewDir, `updated-report-${timestamp}.md`), reportMarkdown);
  }

  const totalElapsed = formatDuration(Date.now() - startTime);
  output.writeln();
  output.writeln('--- Review complete ---');
  output.writeln(`  Agents: ${succeeded.length}/${agents.length} succeeded`);
  output.writeln(`  Total time: ${totalElapsed}`);
  output.writeln(`  Artifacts: ${reviewDir}`);
  if (previousReview) {
    output.writeln(`  Iterating on: ${previousReview.id.slice(0, 8)}`);
  }
  output.writeln();

  // Step 13: Display report
  output.writeln(reportMarkdown);
  output.writeln();

  // Step 13b: Auto-comment
  if (autoComment) {
    const allFindings: Finding[] = review.agentFindings.flatMap(af => af.findings);
    const commentable = allFindings.filter(f => f.file && f.line);
    if (commentable.length > 0) {
      output.writeln(`  ${commentable.length} findings have file+line references:`);
      for (const f of commentable) {
        output.writeln(`    [${f.severity}] ${f.file}:${f.line} — ${f.title.slice(0, 80)}`);
      }
      output.writeln();
      const approved = await promptYesNo(`Post ${commentable.length} comments to the PR?`);
      if (approved) {
        const commentService = createPRCommentService(pr);
        const result = await dispatcher.postFindingsAsComments(commentService, commentable, review.id);
        output.writeln(`  Posted ${result.posted} comments, ${result.skipped} skipped, ${result.errors.length} errors`);
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            output.writeln(output.dim(`    Error: ${err}`));
          }
        }
      } else {
        output.writeln(output.dim('  Skipped posting comments.'));
      }
      output.writeln();
    }
  }

  // Step 14: Cleanup worktree
  if (worktreePath) {
    service.cleanupWorktree(worktreePath, repoPath);
    if (verbose) output.writeln(output.dim('  Worktree cleaned up'));
  }

  // Cleanup temp dir
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }

  // Step 15: Launch interactive chat (default) or print instructions
  if (noChat) {
    output.writeln('To chat about this review:');
    output.writeln(output.dim(`  ruflo review chat ${review.id}`));
    output.writeln(output.dim('  ./scripts/review-pr.sh --chat'));
    output.writeln();
  } else {
    const contextFile = path.join(reviewDir, 'context.md');
    if (fs.existsSync(contextFile)) {
      const chatModelResolved = claudeModel || DEFAULT_DISPATCH_CONFIG.claudeModel;
      output.writeln('Entering chat mode — ask follow-up questions about the review.');
      output.writeln(output.dim('(Use --no-chat to skip this, or Ctrl+C to exit)'));
      output.writeln();
      launchChat(contextFile, reviewDir, chatModelResolved, review.id);
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
      iterationOf: previousReview?.id,
    },
  };
}

// ============================================================================
// Shared option definitions
// ============================================================================

const sharedPipelineOptions = [
  { name: 'url', short: 'u', type: 'string' as const, description: 'Full PR URL (https://github.com/owner/repo/pull/123)' },
  { name: 'owner', short: 'o', type: 'string' as const, description: 'Repository owner' },
  { name: 'repo', short: 'r', type: 'string' as const, description: 'Repository name' },
  { name: 'pr', short: 'p', type: 'string' as const, description: 'PR number' },
  { name: 'skip-worktree', type: 'boolean' as const, default: false, description: 'Skip worktree creation (diff-only mode)' },
  { name: 'skip-debate', type: 'boolean' as const, default: false, description: 'Skip debate loop' },
  { name: 'verbose', short: 'v', type: 'boolean' as const, default: false, description: 'Debug logging to terminal' },
  { name: 'log-file', type: 'string' as const, description: 'Custom log file path' },
  { name: 'claude-model', type: 'string' as const, description: 'Claude model (default: opus, env: CLAUDE_MODEL)' },
  { name: 'codex-model', type: 'string' as const, description: 'Codex model (default: gpt-5.4, env: CODEX_MODEL)' },
  { name: 'agent-budget', type: 'string' as const, description: 'Max USD per agent (default: 25, env: AGENT_BUDGET)' },
  { name: 'reconcile-budget', type: 'string' as const, description: 'Max USD for queen reconciliation (default: 50, env: RECONCILE_BUDGET)' },
  { name: 'claude-only', type: 'boolean' as const, default: false, description: 'Skip Codex agents (Claude-only mode)' },
  { name: 'no-chat', type: 'boolean' as const, default: false, description: 'Skip interactive chat after review completes' },
  { name: 'auto-comment', type: 'boolean' as const, default: false, description: 'Post findings as inline PR comments (asks approval once)' },
];

/** Build PipelineOptions from CommandContext flags. */
function buildPipelineOptions(ctx: CommandContext, pr: PRIdentifier): Omit<PipelineOptions, 'previousReview'> {
  return {
    pr,
    cwd: ctx.cwd,
    dispatchConfig: buildDispatchConfig(ctx),
    verbose: !!ctx.flags.verbose,
    skipWorktree: !!ctx.flags['skip-worktree'],
    skipDebate: !!ctx.flags['skip-debate'],
    claudeOnly: !!ctx.flags['claude-only'],
    noChat: !!ctx.flags['no-chat'],
    autoComment: !!ctx.flags['auto-comment'],
    claudeModel: ctx.flags['claude-model'] as string | undefined,
  };
}

// ============================================================================
// Subcommands
// ============================================================================

const initCommand: Command = {
  name: 'init',
  description: 'Start a new multi-agent PR review (full pipeline)',
  options: [
    ...sharedPipelineOptions,
    { name: 'force', type: 'boolean', default: false, description: 'Force a new review even if one already exists for this PR' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let pr: PRIdentifier;
    try {
      pr = resolvePR(ctx);
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.bold('AI Consortium PR Review'));
    output.writeln(output.dim(`PR #${pr.number} — ${pr.owner}/${pr.repo}`));
    output.writeln();

    // Check for existing completed review (skip if --force)
    if (!ctx.flags.force) {
      const service = createReviewService(ctx.cwd);
      await service.initialize();
      const existing = service.findReviewForPR(pr);

      if (existing) {
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
        if (artifactDir) output.writeln(`  Artifacts: ${artifactDir}`);
        output.writeln();
        output.writeln(output.dim('  Use --force to run a fresh review, or `ruflo review iterate` to re-review.'));
        output.writeln();

        // Jump to chat if artifacts exist
        if (artifactDir && !ctx.flags['no-chat']) {
          const contextFile = path.join(artifactDir, 'context.md');
          const reportFile = path.join(artifactDir, 'report.md');
          if (fs.existsSync(reportFile)) {
            output.writeln(fs.readFileSync(reportFile, 'utf-8'));
            output.writeln();
          }
          const chatModel = (ctx.flags['claude-model'] as string) || DEFAULT_DISPATCH_CONFIG.claudeModel;
          output.writeln('Entering chat mode — ask follow-up questions about the review.');
          output.writeln(output.dim('(Use --no-chat to skip this, or Ctrl+C to exit)'));
          output.writeln();
          launchChat(contextFile, artifactDir, chatModel, existing.id);
        }

        return {
          success: true,
          data: { reviewId: existing.id, reviewDir: artifactDir, pr, reused: true },
        };
      }
    }

    return runReviewPipeline({ ...buildPipelineOptions(ctx, pr), previousReview: null });
  },
};

const iterateCommand: Command = {
  name: 'iterate',
  description: 'Re-review a PR: diff against the previous review, focus on what changed',
  options: sharedPipelineOptions,
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let pr: PRIdentifier;
    try {
      pr = resolvePR(ctx);
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.bold('AI Consortium PR Review (Iterative)'));
    output.writeln(output.dim(`PR #${pr.number} — ${pr.owner}/${pr.repo}`));
    output.writeln();

    const service = createReviewService(ctx.cwd);
    await service.initialize();
    const previousReview = service.findReviewForPR(pr);

    if (!previousReview) {
      output.printError(
        'No previous review found for this PR. Run `ruflo review init` first.'
      );
      return { success: false, exitCode: 1 };
    }

    output.writeln(`  Iterating on previous review: ${previousReview.id.slice(0, 8)}`);

    return runReviewPipeline({ ...buildPipelineOptions(ctx, pr), previousReview });
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

// ============================================================================
// Comment Subcommand
// ============================================================================

const commentListCommand: Command = {
  name: 'list',
  description: 'List all comments on the PR bound to this review',
  options: [
    { name: 'json', type: 'boolean', default: false, description: 'Output as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const reviewId = ctx.args[0] as string | undefined;
    if (!reviewId) {
      output.printError('Review ID is required. Usage: ruflo review comment list <review-id>');
      return { success: false, exitCode: 1 };
    }

    const service = createReviewService(ctx.cwd);
    await service.initialize();
    const review = service.getReview(reviewId);
    if (!review) {
      output.printError(`Review not found: ${reviewId}`);
      return { success: false, exitCode: 1 };
    }

    const commentService = createPRCommentService(review.pr);
    const comments = commentService.listComments();

    if (ctx.flags.json) {
      output.printJson(comments);
      return { success: true, data: { comments } };
    }

    if (comments.length === 0) {
      output.printInfo('No comments on this PR.');
      return { success: true, data: { comments: [] } };
    }

    output.writeln();
    output.writeln(output.bold(`PR #${review.pr.number} Comments (${comments.length})`));
    output.writeln();
    for (const c of comments) {
      const loc = c.file ? `  ${c.file}${c.line ? `:${c.line}` : ''}` : '';
      const reply = c.inReplyToId ? ` (reply to #${c.inReplyToId})` : '';
      output.writeln(`  #${c.id} by ${c.author}${loc}${reply}`);
      output.writeln(`    ${c.body.slice(0, 120)}${c.body.length > 120 ? '...' : ''}`);
      output.writeln(output.dim(`    ${c.createdAt}`));
      output.writeln();
    }

    return { success: true, data: { comments } };
  },
};

const commentPostCommand: Command = {
  name: 'post',
  description: 'Post an inline comment on the PR',
  options: [
    { name: 'file', short: 'f', type: 'string', description: 'File path within the PR' },
    { name: 'line', short: 'l', type: 'string', description: 'Line number' },
    { name: 'body', short: 'b', type: 'string', description: 'Comment body text' },
    { name: 'side', type: 'string', description: 'Diff side: LEFT or RIGHT', default: 'RIGHT' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const reviewId = ctx.args[0] as string | undefined;
    const file = ctx.flags.file as string | undefined;
    const lineStr = ctx.flags.line as string | undefined;
    const body = ctx.flags.body as string | undefined;
    const side = (ctx.flags.side as string || 'RIGHT').toUpperCase() as 'LEFT' | 'RIGHT';

    if (!reviewId || !file || !lineStr || !body) {
      output.printError('Usage: ruflo review comment post <review-id> --file <path> --line <num> --body "text"');
      return { success: false, exitCode: 1 };
    }

    const line = parseInt(lineStr, 10);
    if (isNaN(line)) {
      output.printError(`Invalid line number: ${lineStr}`);
      return { success: false, exitCode: 1 };
    }

    const service = createReviewService(ctx.cwd);
    await service.initialize();
    const review = service.getReview(reviewId);
    if (!review) {
      output.printError(`Review not found: ${reviewId}`);
      return { success: false, exitCode: 1 };
    }

    const commentService = createPRCommentService(review.pr);
    try {
      const comment = commentService.postComment(file, line, body, side);
      output.printSuccess(`Comment posted: #${comment.id}`);
      output.writeln(output.dim(`  ${comment.url}`));
      return { success: true, data: { comment } };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

const commentReplyCommand: Command = {
  name: 'reply',
  description: 'Reply to an existing PR comment',
  options: [
    { name: 'comment-id', short: 'c', type: 'string', description: 'Comment ID to reply to' },
    { name: 'body', short: 'b', type: 'string', description: 'Reply body text' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const reviewId = ctx.args[0] as string | undefined;
    const commentIdStr = ctx.flags['comment-id'] as string | undefined;
    const body = ctx.flags.body as string | undefined;

    if (!reviewId || !commentIdStr || !body) {
      output.printError('Usage: ruflo review comment reply <review-id> --comment-id <num> --body "text"');
      return { success: false, exitCode: 1 };
    }

    const commentId = parseInt(commentIdStr, 10);
    if (isNaN(commentId)) {
      output.printError(`Invalid comment ID: ${commentIdStr}`);
      return { success: false, exitCode: 1 };
    }

    const service = createReviewService(ctx.cwd);
    await service.initialize();
    const review = service.getReview(reviewId);
    if (!review) {
      output.printError(`Review not found: ${reviewId}`);
      return { success: false, exitCode: 1 };
    }

    const commentService = createPRCommentService(review.pr);
    try {
      const reply = commentService.replyToComment(commentId, body);
      output.printSuccess(`Reply posted: #${reply.id}`);
      output.writeln(output.dim(`  ${reply.url}`));
      return { success: true, data: { reply } };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

const commentCommand: Command = {
  name: 'comment',
  description: 'Interact with PR comments (list, post, reply)',
  subcommands: [commentListCommand, commentPostCommand, commentReplyCommand],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('PR Comment Commands'));
    output.writeln();
    output.printList([
      'list  <review-id>             List all comments on the PR',
      'post  <review-id> --file --line --body  Post an inline comment',
      'reply <review-id> --comment-id --body   Reply to a comment',
    ]);
    output.writeln();
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
    iterateCommand,
    statusCommand,
    listCommand,
    reportCommand,
    chatCommand,
    commentCommand,
    cleanupCommand,
  ],
  examples: [
    { command: 'ruflo review init --url https://github.com/org/repo/pull/123', description: 'Full pipeline review' },
    { command: 'ruflo review init --url <URL> --claude-only', description: 'Claude-only review (no Codex)' },
    { command: 'ruflo review init --url <URL> --skip-worktree', description: 'Diff-only mode (no codebase access)' },
    { command: 'ruflo review init --url <URL> --force', description: 'Force new review even if one exists' },
    { command: 'ruflo review init --url <URL> --auto-comment', description: 'Post findings as inline PR comments' },
    { command: 'ruflo review iterate --url <URL>', description: 'Re-review: diff against previous review' },
    { command: 'ruflo review iterate --url <URL> --auto-comment', description: 'Re-review and post findings as comments' },
    { command: 'ruflo review status <id>', description: 'Check review progress' },
    { command: 'ruflo review list', description: 'List all reviews' },
    { command: 'ruflo review report <id>', description: 'Display review report' },
    { command: 'ruflo review chat <id>', description: 'Interactive Q&A about findings' },
    { command: 'ruflo review chat --dir <path>', description: 'Chat with explicit review directory' },
    { command: 'ruflo review comment list <id>', description: 'List PR comments' },
    { command: 'ruflo review comment post <id> --file <path> --line <n> --body "text"', description: 'Post inline comment' },
    { command: 'ruflo review comment reply <id> --comment-id <n> --body "text"', description: 'Reply to a comment' },
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
      'iterate  - Re-review a PR (diff against previous review)',
      'status   - Check review progress',
      'list     - List all reviews',
      'report   - Display review report',
      'chat     - Interactive Q&A about findings (launches claude)',
      'comment  - List, post, and reply to PR comments',
      'cleanup  - Remove stale reviews (default: older than 3 weeks)',
    ]);
    output.writeln();
    output.writeln('Example:');
    output.writeln(output.dim('  ruflo review init --url https://github.com/org/repo/pull/123'));
    output.writeln(output.dim('  ruflo review iterate --url https://github.com/org/repo/pull/123'));
    return { success: true };
  },
};

export default reviewCommand;
