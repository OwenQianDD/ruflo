/**
 * PR Review Orchestration Service
 *
 * Core orchestration: PR fetch, worktree management, agent dispatch,
 * debate loop, report compilation, and state persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  FetchReviewContentRequest,
  FetchReviewContentResult,
  PRIdentifier,
  PRMetadata,
  ReviewContent,
  ReviewContext,
  ReviewConfig,
  ReviewStatus,
  AgentFindings,
  Finding,
  FindingSeverity,
  DebateRound,
  DebatePosition,
  ReviewReport,
  ReviewRecommendation,
  PairAgreement,
  ModelProvider,
  PRDelta,
  PRCommentThread,
  ReviewTarget,
  AgentRole,
} from './review-types.js';
import {
  DEFAULT_REVIEW_CONFIG,
  getAgentRolesForProfile,
  getReviewProfile,
} from './review-types.js';
import { fetchReviewContent as fetchReviewContentFromSource } from './review-content.js';

// ============================================================================
// ReviewService
// ============================================================================

export class ReviewService {
  /** Primary (global) directory — new reviews are always written here. */
  private reviewsDir: string;
  /** All directories to read from (global first, then project-local for back-compat). */
  private readDirs: string[];
  private config: ReviewConfig;

  constructor(projectRoot: string, config?: Partial<ReviewConfig>) {
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    this.reviewsDir = path.join(home, '.claude', 'reviews');
    const localDir = path.join(projectRoot, '.claude', 'reviews');
    this.readDirs = localDir === this.reviewsDir
      ? [this.reviewsDir]
      : [this.reviewsDir, localDir];
    this.config = { ...DEFAULT_REVIEW_CONFIG, ...config };
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.reviewsDir)) {
      fs.mkdirSync(this.reviewsDir, { recursive: true });
    }

    // Load config overrides if present
    const configPath = path.join(this.reviewsDir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const overrides = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.config = { ...this.config, ...overrides };
      } catch {
        // Use defaults if config is corrupted
      }
    }
  }

  // ==========================================================================
  // Local Repo Validation
  // ==========================================================================

  validateLocalRepo(pr: PRIdentifier): string {
    const repoPath = path.join(this.config.projectsDir, pr.repo);
    const gitDir = path.join(repoPath, '.git');

    if (!fs.existsSync(gitDir)) {
      throw new Error(
        `Local repo not found at ${repoPath}. ` +
          `Clone it first: git clone https://github.com/${pr.owner}/${pr.repo}.git ${repoPath}`
      );
    }

    return repoPath;
  }

  // ==========================================================================
  // PR Metadata
  // ==========================================================================

  fetchPRMetadata(pr: PRIdentifier, repoPath: string): PRMetadata {
    return this.fetchReviewContent({
      source: 'pr',
      pr,
      repoPath,
    }).content;
  }

  fetchReviewContent(
    request: FetchReviewContentRequest,
  ): FetchReviewContentResult {
    return fetchReviewContentFromSource(request);
  }

  // ==========================================================================
  // Worktree Management
  // ==========================================================================

  createWorktree(pr: PRIdentifier, repoPath: string): string {
    const worktreeDir = path.join(repoPath, '.claude', 'worktrees');
    if (!fs.existsSync(worktreeDir)) {
      fs.mkdirSync(worktreeDir, { recursive: true });
    }

    const worktreeName = `review-${pr.number}-${Date.now()}`;
    const worktreePath = path.join(worktreeDir, worktreeName);
    const ref = `refs/review/${pr.number}`;

    try {
      // Fetch PR head into a local ref (does NOT modify the working tree)
      execFileSync('git', [
        'fetch', 'origin', `pull/${pr.number}/head:${ref}`,
      ], { cwd: repoPath, stdio: 'ignore' });

      // Create a detached worktree at that ref
      execFileSync('git', [
        'worktree', 'add', '--detach', worktreePath, ref,
      ], { cwd: repoPath, stdio: 'ignore' });
    } catch (error) {
      throw new Error(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return worktreePath;
  }

  cleanupWorktree(worktreePath: string, repoPath: string): void {
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoPath,
        stdio: 'ignore',
      });
    } catch {
      // Best-effort cleanup
    }
  }

  // ==========================================================================
  // Review CRUD
  // ==========================================================================

  createReview(
    targetOrPR: ReviewTarget | PRIdentifier,
    content: ReviewContent,
    worktreePath?: string,
    pr?: PRIdentifier,
    customPrompt?: string,
  ): ReviewContext {
    const now = new Date().toISOString();
    const target = isPRIdentifier(targetOrPR)
      ? this.buildPRTarget(targetOrPR)
      : targetOrPR;
    const resolvedPR = isPRIdentifier(targetOrPR) ? targetOrPR : pr;
    const profile = getReviewProfile(target);

    const review: ReviewContext = {
      id: randomUUID(),
      target,
      content,
      profile,
      pr: resolvedPR,
      status: 'initializing',
      worktreePath,
      agentFindings: [],
      pairAgreements: [],
      debates: [],
      customPrompt,
      config: this.config,
      createdAt: now,
      updatedAt: now,
    };

    this.saveReview(review);
    return review;
  }

  getReview(id: string): ReviewContext | null {
    for (const dir of this.readDirs) {
      // Exact match first
      const filePath = path.join(dir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          return this.normalizeReview(
            JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReviewContext,
          );
        } catch {
          continue;
        }
      }

      // Short prefix match
      if (!fs.existsSync(dir)) continue;
      const matches = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && f !== 'config.json' && f.startsWith(id));

      if (matches.length > 1) {
        const matchIds = matches.map(f => f.replace('.json', ''));
        throw new Error(
          `Ambiguous review ID "${id}" matches ${matches.length} reviews. ` +
          `Use a longer prefix or the full ID:\n` +
          matchIds.map(m => `  ${m}`).join('\n')
        );
      }

      if (matches.length === 1) {
        try {
          return this.normalizeReview(
            JSON.parse(
              fs.readFileSync(path.join(dir, matches[0]), 'utf-8'),
            ) as ReviewContext,
          );
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  listReviews(statusFilter?: ReviewStatus): ReviewContext[] {
    const seen = new Set<string>();
    const reviews: ReviewContext[] = [];

    for (const dir of this.readDirs) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(
        f => f.endsWith('.json') && f !== 'config.json'
      );

      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        try {
          const review = this.normalizeReview(
            JSON.parse(
              fs.readFileSync(path.join(dir, file), 'utf-8'),
            ) as ReviewContext,
          );

          if (!statusFilter || review.status === statusFilter) {
            reviews.push(review);
          }
        } catch {
          // Skip corrupted files
        }
      }
    }

    return reviews.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Find the most recent completed review for a given PR.
   * Returns null if no completed review exists.
   */
  findReviewForPR(pr: PRIdentifier): ReviewContext | null {
    const completed = this.listReviews('completed');
    return completed.find(
      (r) =>
        r.target.kind === 'pull-request' &&
        r.pr &&
        r.pr.owner === pr.owner &&
        r.pr.repo === pr.repo &&
        r.pr.number === pr.number
    ) || null;
  }

  getAgentRoles(review: ReviewContext): AgentRole[] {
    return getAgentRolesForProfile(review.profile || getReviewProfile(review.target));
  }

  saveReview(review: ReviewContext): void {
    review.updatedAt = new Date().toISOString();
    const filePath = path.join(this.reviewsDir, `${review.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Remove reviews (and their artifact directories) that haven't been
   * updated in longer than `maxAgeDays`. Returns the list of removed IDs.
   */
  cleanupStaleReviews(maxAgeDays: number): { id: string; pr: string; updatedAt: string }[] {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const all = this.listReviews();
    const removed: { id: string; pr: string; updatedAt: string }[] = [];

    for (const review of all) {
      const updated = new Date(review.updatedAt).getTime();
      if (updated >= cutoff) continue;

      // Remove the review state JSON and artifact directories from all read dirs
      const prefix = this.getArtifactPrefix(review);
      for (const dir of this.readDirs) {
        if (!fs.existsSync(dir)) continue;
        // State file
        const stateFile = path.join(dir, `${review.id}.json`);
        try { fs.unlinkSync(stateFile); } catch { /* already gone */ }
        // Artifact directories
        const artifactDirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.startsWith(prefix));
        for (const d of artifactDirs) {
          try { fs.rmSync(path.join(dir, d.name), { recursive: true }); } catch { /* best effort */ }
        }
      }

      removed.push({
        id: review.id,
        pr: this.getReviewLocator(review),
        updatedAt: review.updatedAt,
      });
    }

    return removed;
  }

  // ==========================================================================
  // Agent Dispatch
  // ==========================================================================

  /**
   * Build the review prompt for a specialist agent.
   * The actual agent spawning is done by the CLI command via Task tool.
   */
  buildAgentPrompt(
    agentRole: AgentRole,
    review: ReviewContext,
    providerLabel?: string
  ): string {
    const { content } = review;
    const fileSummary = content.changedFiles
      .map(f => `  ${f.status} ${f.path} (+${f.additions}/-${f.deletions})`)
      .join('\n');

    const fixInstructions = [
      'IMPORTANT: For every finding, you MUST include a concrete suggested fix in the "suggestion" field.',
      'The suggestion must be actionable — include the specific code change, pattern, or approach.',
      'Example: "Add null check: if (user == null) return early;" or "Replace md5 with bcrypt for password hashing".',
      'Do NOT leave suggestion empty or vague.',
    ].join('\n');

    const roleInstructions: Record<string, string> = {
      'security-auditor': [
        review.target.kind === 'pull-request'
          ? 'Focus on: OWASP Top 10, race conditions, credential exposure, input validation, auth flaws, crypto weaknesses.'
          : 'Focus on: security assumptions, authz/authn gaps, data privacy, abuse resistance, trust boundaries, and risky rollout decisions in the design.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
      'logic-checker': [
        review.target.kind === 'pull-request'
          ? 'Focus on: Algorithmic correctness, off-by-one errors, boundary conditions, error handling, dead code, test gaps.'
          : 'Focus on: requirement gaps, correctness, edge cases, failure modes, unclear assumptions, and missing validation in the design.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
      'integration-specialist': [
        review.target.kind === 'pull-request'
          ? 'Focus on: Breaking API changes, architectural drift, cross-module impact, dependency changes, migration safety.'
          : 'Focus on: system boundaries, dependency impact, rollout, migration safety, operability, observability, and compatibility with existing systems.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
      'system-architect': [
        'Use skill: $agent-arch-system-design.',
        'You are acting as a high-signal big-tech system design interviewer reviewing this proposal for architecture quality.',
        'Focus on: API design, concurrency control, scaling strategy, bottlenecks, queues, rate limiting, backpressure, storage design, reliability, fault tolerance, observability, cost, and operational simplicity.',
        'Assess whether the design demonstrates E4, E5, E6, or E7 level systems thinking. Be explicit about the highest level the design credibly supports and why.',
        'The summary MUST include four items: overall read, strongest aspects, biggest gaps, and a final level assessment.',
        'Findings should prioritize the most interview-relevant gaps, not stylistic nits.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
    };

    const providerNote = providerLabel ? `\nYou are running as: ${providerLabel}.\n` : '';
    return [
      this.buildReviewPromptContext(review),
      providerNote.trim(),
      roleInstructions[agentRole],
      review.customPrompt
        ? [
            'Custom Review Prompt:',
            review.customPrompt,
            'Treat the custom review prompt as mandatory additional review criteria.',
          ].join('\n')
        : '',
      'Respond ONLY with valid JSON.',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Parse agent output into AgentFindings.
   * Handles both clean JSON and JSON embedded in markdown code blocks.
   */
  parseAgentOutput(agentName: string, model: string, output: string, durationMs: number): AgentFindings {
    const defaults: AgentFindings = {
      agent: agentName,
      model,
      findings: [],
      summary: '',
      completedAt: new Date().toISOString(),
      durationMs,
    };

    try {
      // Extract JSON: find the outermost { ... } object in the output.
      // We can't use a simple ```json...``` regex because agent suggestions
      // contain nested code blocks that close the match early.
      const jsonStr = extractOutermostJson(output);
      const parsed = JSON.parse(jsonStr);

      return {
        ...defaults,
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        summary: parsed.summary || '',
      };
    } catch {
      // If JSON parsing fails, create a single finding from the text
      return {
        ...defaults,
        findings: [{
          id: `${agentName}-text-1`,
          agent: agentName,
          severity: 'info' as FindingSeverity,
          category: 'other',
          title: 'Agent returned unstructured output',
          description: output.slice(0, 2000),
          confidence: 0.5,
        }],
        summary: 'Agent output was not valid JSON; captured as unstructured finding.',
      };
    }
  }

  // ==========================================================================
  // Debate Loop
  // ==========================================================================

  /**
   * Identify findings where agents disagree (severity differs significantly,
   * or one agent flags critical but another doesn't mention the same issue).
   */
  findDisagreements(allFindings: AgentFindings[]): Finding[] {
    const severityRank: Record<FindingSeverity, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      info: 0,
    };

    // Collect all critical and high findings
    const significantFindings: Finding[] = [];
    for (const af of allFindings) {
      for (const f of af.findings) {
        if (f.severity === 'critical' || f.severity === 'high') {
          significantFindings.push(f);
        }
      }
    }

    // For each significant finding, check if other agents have a conflicting view
    // on the same file/area. We use file+title similarity as a heuristic.
    const disputed: Finding[] = [];
    for (const finding of significantFindings) {
      const otherAgentFindings = allFindings
        .filter(af => af.agent !== finding.agent)
        .flatMap(af => af.findings);

      // Check if another agent has a finding on the same file with lower severity
      const relatedOther = otherAgentFindings.find(
        other =>
          other.file === finding.file &&
          other.file !== undefined &&
          severityRank[other.severity] < severityRank[finding.severity] - 1
      );

      if (relatedOther) {
        disputed.push(finding);
      }
    }

    // Also include any critical findings that no other agent mentioned at all
    for (const finding of significantFindings) {
      if (finding.severity !== 'critical') continue;
      if (disputed.includes(finding)) continue;

      const otherAgentMentions = allFindings
        .filter(af => af.agent !== finding.agent)
        .flatMap(af => af.findings)
        .filter(f => f.file === finding.file && f.file !== undefined);

      if (otherAgentMentions.length === 0) {
        disputed.push(finding);
      }
    }

    return disputed;
  }

  /**
   * Run the debate loop for disputed findings.
   * Returns debate rounds for each disputed finding.
   */
  runDebateLoop(
    review: ReviewContext,
    resolvePosition: (finding: Finding, round: number) => DebatePosition[]
  ): DebateRound[] {
    const disputed = this.findDisagreements(review.agentFindings);
    const rounds: DebateRound[] = [];

    for (const finding of disputed) {
      let resolved = false;
      for (let round = 1; round <= this.config.maxDebateRounds && !resolved; round++) {
        const positions = resolvePosition(finding, round);
        const resolution = this.evaluateConsensus(positions, finding.severity);

        const debateRound: DebateRound = {
          round,
          topic: `${finding.title} (${finding.file || 'general'})`,
          findingId: finding.id,
          positions,
          resolution: resolution.type,
          resolvedSeverity: resolution.severity,
          notes: resolution.notes,
        };

        rounds.push(debateRound);

        if (resolution.type !== 'queen-override' || round === this.config.maxDebateRounds) {
          resolved = true;
        }
      }
    }

    return rounds;
  }

  private evaluateConsensus(
    positions: DebatePosition[],
    originalSeverity: FindingSeverity
  ): { type: 'consensus' | 'majority' | 'queen-override'; severity: FindingSeverity; notes: string } {
    const agreeCount = positions.filter(p => p.stance === 'agree').length;
    const total = positions.length;

    if (total === 0) {
      return { type: 'queen-override', severity: originalSeverity, notes: 'No positions provided.' };
    }

    const agreeRatio = agreeCount / total;

    if (agreeRatio >= this.config.consensusThreshold) {
      return {
        type: 'consensus',
        severity: originalSeverity,
        notes: `${agreeCount}/${total} agents agreed on severity.`,
      };
    }

    // Check for majority on a modified severity
    const suggestedSeverities = positions
      .filter(p => p.suggestedSeverity)
      .map(p => p.suggestedSeverity!);

    if (suggestedSeverities.length > 0) {
      const counts = new Map<FindingSeverity, number>();
      for (const s of suggestedSeverities) {
        counts.set(s, (counts.get(s) || 0) + 1);
      }
      const [topSeverity, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topCount / total >= this.config.consensusThreshold) {
        return {
          type: 'majority',
          severity: topSeverity,
          notes: `Majority (${topCount}/${total}) suggested severity: ${topSeverity}.`,
        };
      }
    }

    return {
      type: 'queen-override',
      severity: originalSeverity,
      notes: `No consensus reached. Queen maintains original severity: ${originalSeverity}.`,
    };
  }

  // ==========================================================================
  // Pair Agreement (Dual-Model)
  // ==========================================================================

  /**
   * Compare Claude vs Codex findings for each role and produce pair agreements.
   * Agent names are expected as "{role}-claude" and "{role}-codex".
   */
  runPairAgreement(review: ReviewContext): PairAgreement[] {
    const roles = this.getAgentRoles(review);
    const systemDesign = (review.profile || getReviewProfile(review.target)) === 'system-design';
    const severityRank: Record<FindingSeverity, number> = {
      critical: 4, high: 3, medium: 2, low: 1, info: 0,
    };
    const agreements: PairAgreement[] = [];

    for (const role of roles) {
      const claudeAF = review.agentFindings.find(af => af.agent === `${role}-claude`);
      const codexAF = review.agentFindings.find(af => af.agent === `${role}-codex`);
      if (!claudeAF || !codexAF) continue;

      const agreed: Finding[] = [];
      const disagreements: Finding[] = [];
      const matchedCodexIds = new Set<string>();

      // Match Claude findings to Codex findings on the same file
      for (const cf of claudeAF.findings) {
        const match = codexAF.findings.find(
          xf =>
            !matchedCodexIds.has(xf.id) &&
            findingsPairAgree(cf, xf, severityRank, systemDesign)
        );
        if (match) {
          matchedCodexIds.add(match.id);
          // Take the higher-severity finding, boost confidence for cross-model agreement
          const winner = severityRank[cf.severity] >= severityRank[match.severity] ? cf : match;
          agreed.push({ ...winner, confidence: Math.min(1, winner.confidence + 0.1) });
        } else {
          disagreements.push({ ...cf, confidence: cf.confidence * 0.8 });
        }
      }

      // Unmatched Codex findings
      for (const xf of codexAF.findings) {
        if (!matchedCodexIds.has(xf.id)) {
          disagreements.push({ ...xf, confidence: xf.confidence * 0.8 });
        }
      }

      const resolution =
        disagreements.length === 0
          ? 'full-agreement'
          : disagreements.length <= agreed.length
            ? 'partial-agreement'
            : 'escalated';

      agreements.push({
        role,
        claudeFindings: claudeAF,
        codexFindings: codexAF,
        agreedFindings: agreed,
        disagreements,
        resolution,
        notes: `${agreed.length} agreed, ${disagreements.length} single-source (${resolution})`,
      });
    }

    return agreements;
  }

  // ==========================================================================
  // Iterative Review
  // ==========================================================================

  /**
   * Fetch the delta between the current PR state and the previous review's snapshot.
   */
  fetchPRDelta(pr: PRIdentifier, previousMetadata: PRMetadata, repoPath: string): PRDelta {
    let newDiff = '';
    try {
      newDiff = execFileSync('gh', [
        'pr', 'diff', String(pr.number),
        '--repo', `${pr.owner}/${pr.repo}`,
      ], { encoding: 'utf-8', cwd: repoPath });
    } catch {
      // diff may fail for very large PRs
    }

    // Get current changed files
    let currentFiles: string[] = [];
    try {
      const filesJson = execFileSync('gh', [
        'pr', 'view', String(pr.number),
        '--repo', `${pr.owner}/${pr.repo}`,
        '--json', 'files',
      ], { encoding: 'utf-8', cwd: repoPath });
      const parsed = JSON.parse(filesJson);
      currentFiles = (parsed.files || []).map((f: { path: string }) => f.path);
    } catch {
      // Fall back to metadata files
      currentFiles = previousMetadata.changedFiles.map(f => f.path);
    }

    const previousFiles = new Set(previousMetadata.changedFiles.map(f => f.path));

    // Files that are new or have a different diff since the last review
    const changedSinceReview = currentFiles.filter(f => !previousFiles.has(f));
    const unchangedFiles = currentFiles.filter(f => previousFiles.has(f));

    // If we have both diffs, compare them to find files with actual changes
    if (newDiff && previousMetadata.diff) {
      const prevDiffFiles = extractDiffFiles(previousMetadata.diff);
      const newDiffFiles = extractDiffFiles(newDiff);

      // Files whose diff content has changed
      for (const file of unchangedFiles) {
        const prevContent = prevDiffFiles.get(file) || '';
        const newContent = newDiffFiles.get(file) || '';
        if (prevContent !== newContent) {
          changedSinceReview.push(file);
        }
      }
    }

    // Deduplicate
    const changedSet = [...new Set(changedSinceReview)];
    const unchangedSet = currentFiles.filter(f => !changedSet.includes(f));

    return {
      newDiff,
      changedSinceReview: changedSet,
      unchangedFiles: unchangedSet,
    };
  }

  /**
   * Build the iteration context string for agent prompts during iterative review.
   */
  buildIterationContext(
    previousReview: ReviewContext,
    delta: PRDelta,
    commentThreads: PRCommentThread[],
  ): string {
    const prevFindings = previousReview.agentFindings.flatMap(af => af.findings);
    const severityCounts: Record<string, number> = {};
    for (const f of prevFindings) {
      severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
    }

    const severitySummary = Object.entries(severityCounts)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');

    const parts: string[] = [
      '## Iteration Context (Re-Review)',
      '',
      `This is an iterative review. A previous review (${previousReview.id.slice(0, 8)}) ` +
      `found ${prevFindings.length} findings (${severitySummary}).`,
      '',
    ];

    // File change summary
    if (delta.changedSinceReview.length > 0) {
      parts.push(`### Files Changed Since Last Review (${delta.changedSinceReview.length})`);
      for (const f of delta.changedSinceReview) {
        parts.push(`  - ${f}`);
      }
      parts.push('');
    }

    if (delta.unchangedFiles.length > 0) {
      parts.push(`### Files Unchanged Since Last Review (${delta.unchangedFiles.length})`);
      for (const f of delta.unchangedFiles) {
        parts.push(`  - ${f}`);
      }
      parts.push('');
    }

    // Comment thread summary
    if (commentThreads.length > 0) {
      parts.push(`### PR Comment Threads (${commentThreads.length})`);
      for (const t of commentThreads) {
        const loc = t.file ? `${t.file}${t.line ? `:${t.line}` : ''}` : '(general)';
        const replyCount = t.replies.length;
        const status = t.isResolved ? 'resolved' : `${replyCount} replies`;
        parts.push(`  - ${loc}: "${t.rootComment.body.slice(0, 80)}..." (${status})`);
      }
      parts.push('');
    }

    parts.push('### Instructions for Iterative Review');
    parts.push('Focus on:');
    parts.push('1. Whether previous findings were addressed in the new changes');
    parts.push('2. Whether new issues were introduced in changed files');
    parts.push('3. Whether comment thread discussions resolved concerns');
    parts.push('4. Only flag findings that are still relevant or newly introduced');
    parts.push('');

    return parts.join('\n');
  }

  // ==========================================================================
  // Report Compilation
  // ==========================================================================

  compileReport(review: ReviewContext): ReviewReport {
    const allFindings: Finding[] = review.agentFindings.flatMap(af => af.findings);

    // Apply debate resolutions
    for (const debate of review.debates) {
      const finding = allFindings.find(f => f.id === debate.findingId);
      if (finding) {
        finding.severity = debate.resolvedSeverity;
      }
    }

    // Triage
    const criticalFindings = allFindings.filter(
      f => f.severity === 'critical' || f.severity === 'high'
    );
    const suggestions = allFindings.filter(
      f => f.severity === 'medium' || f.severity === 'low' || f.severity === 'info'
    );

    // Determine recommendation
    const recommendation = this.determineRecommendation(allFindings);

    // Pair agreement notes
    const pairAgreementNotes = review.pairAgreements.map(
      pa => `${pa.role}: ${pa.agreedFindings.length} agreed, ${pa.disagreements.length} single-source (${pa.resolution})`
    );

    // Debate notes
    const debateNotes = review.debates.map(
      d => `${d.topic}: ${d.notes} (resolved via ${d.resolution})`
    );

    // Build markdown
    const overview = buildOverview(review);
    const markdown = (review.profile || getReviewProfile(review.target)) === 'system-design'
      ? buildSystemDesignMarkdownReport(
          review,
          overview,
          criticalFindings,
          suggestions,
          pairAgreementNotes,
          debateNotes,
          recommendation,
        )
      : buildMarkdownReport(
          review,
          overview,
          criticalFindings,
          suggestions,
          pairAgreementNotes,
          debateNotes,
          recommendation,
        );

    const report: ReviewReport = {
      overview,
      findings: allFindings,
      criticalFindings,
      suggestions,
      pairAgreementNotes,
      debateNotes,
      recommendation,
      markdown,
      generatedAt: new Date().toISOString(),
    };

    return report;
  }

  // ==========================================================================
  // Provider-Aware Prompt Building
  // ==========================================================================

  /**
   * Build an agent prompt with provider-specific codebase-access instructions.
   */
  buildAgentPromptForProvider(
    agentRole: AgentRole,
    review: ReviewContext,
    provider: ModelProvider,
    hasCodebaseAccess: boolean,
  ): string {
    const providerLabel = provider === 'claude'
      ? `Claude ${review.config.providers.queen.model}`
      : `Codex ${review.config.providers.securityAuditor.codex.model}`;

    const basePrompt = this.buildAgentPrompt(agentRole, review, providerLabel);

    if (!hasCodebaseAccess) {
      if (review.target.kind === 'pull-request') {
        return basePrompt + '\n\nNote: Analyze ONLY the diff provided. Note when your analysis would benefit from broader codebase context.\n';
      }
      return basePrompt;
    }

    const codebaseInstructions = provider === 'claude'
      ? [
          '',
          review.target.kind === 'pull-request'
            ? 'CODEBASE ACCESS: You have full access to the repository at the PR\'s HEAD commit.'
            : 'CODEBASE ACCESS: You have full access to the repository checkout that contains the design-doc artifacts.',
          'Use Read, Grep, and Glob tools to explore beyond the diff when needed:',
          '- Check how modified functions are called elsewhere',
          '- Verify whether upstream sanitization or validation exists',
          '- Look at related modules and tests',
          '- Examine type definitions and interfaces',
          'Do NOT limit yourself to the diff — investigate the full context.',
        ].join('\n')
      : [
          '',
          review.target.kind === 'pull-request'
            ? 'CODEBASE ACCESS: You have full access to the repository at the PR\'s HEAD commit.'
            : 'CODEBASE ACCESS: You have full access to the repository checkout that contains the design-doc artifacts.',
          'Read files beyond the diff when needed:',
          '- Check how modified functions are called elsewhere',
          '- Verify whether upstream sanitization or validation exists',
          '- Look at related modules and tests',
          'Do NOT limit yourself to the diff — investigate the full context.',
        ].join('\n');

    return basePrompt + codebaseInstructions + '\n';
  }

  // ==========================================================================
  // Artifact Persistence
  // ==========================================================================

  /**
   * Persist review artifacts to ~/.claude/reviews/<owner>-<repo>-<pr>-<timestamp>/
   * so Codex can open them inside the active workspace sandbox.
   */
  persistArtifacts(
    review: ReviewContext,
    agentOutputs: Map<string, string>,
    reportMarkdown: string,
  ): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dirName = `${this.getArtifactPrefix(review)}-${timestamp}`;
    const reviewDir = path.join(this.reviewsDir, dirName);
    fs.mkdirSync(reviewDir, { recursive: true });

    // Save agent outputs
    for (const [name, content] of agentOutputs) {
      if (content.trim()) {
        fs.writeFileSync(path.join(reviewDir, `out-${name}.txt`), content);
      }
    }

    // Save report
    fs.writeFileSync(path.join(reviewDir, 'report.md'), reportMarkdown);

    // Build and save chat context
    const chatContext = this.buildChatContext(review, agentOutputs, reportMarkdown);
    fs.writeFileSync(path.join(reviewDir, 'context.md'), chatContext);

    // Save review state JSON
    fs.writeFileSync(path.join(reviewDir, 'review.json'), JSON.stringify(review, null, 2));

    return reviewDir;
  }

  // ==========================================================================
  // Chat Context
  // ==========================================================================

  /**
   * Build the chat context file for post-review Q&A.
   */
  buildChatContext(
    review: ReviewContext,
    agentOutputs: Map<string, string>,
    reportMarkdown: string,
  ): string {
    const { content } = review;
    const parts: string[] = [
      `You are the Queen Reviewer for ${review.target.label}.`,
      `Title: ${content.title} | Author: ${content.author}`,
      `Source: ${content.source}`,
      content.baseBranch || content.headBranch
        ? `Branches: ${content.headBranch || '(unknown)'} -> ${content.baseBranch || '(unknown)'}`
        : '',
      `Changes: +${content.additions}/-${content.deletions} across ${content.changedFiles.length} files`,
      review.customPrompt ? `Custom Review Prompt: ${review.customPrompt}` : '',
      '',
      'The review has already been completed. Below are the full findings from all agents',
      'and the compiled report. The user wants to discuss the findings, ask follow-up',
      'questions, drill into specific issues, or request re-evaluation of certain findings.',
      '',
      'Answer based on the review data below. If asked to re-check something, reason from',
      'the diff and findings. You have the full context of all agents\' work.',
      '',
      '---',
      '',
      '## Agent Findings',
      '',
    ];

    for (const [name, content] of agentOutputs) {
      if (content.trim()) {
        parts.push(`### ${name}`);
        parts.push('```json');
        parts.push(content);
        parts.push('```');
        parts.push('');
      }
    }

    parts.push('## Compiled Report');
    parts.push('');
    parts.push(reportMarkdown);

    return parts.join('\n');
  }

  private normalizeReview(review: ReviewContext & { metadata?: ReviewContent }): ReviewContext {
    if (review.target && review.content) {
      return review;
    }

    const pr = review.pr;
    const content = review.content || review.metadata;
    if (!content) {
      throw new Error('Review is missing content metadata');
    }

    return {
      ...review,
      target: review.target || (pr ? this.buildPRTarget(pr) : {
        kind: 'design-doc',
        label: review.id,
        slug: review.id,
      }),
      content,
      profile: review.profile || getReviewProfile(review.target || (pr ? this.buildPRTarget(pr) : {
        kind: 'design-doc',
        label: review.id,
        slug: review.id,
      })),
      pr,
    };
  }

  private buildPRTarget(pr: PRIdentifier): ReviewTarget {
    return {
      kind: 'pull-request',
      label: `${pr.owner}/${pr.repo}#${pr.number}`,
      slug: `${pr.owner}-${pr.repo}-${pr.number}`,
      description: pr.url,
    };
  }

  private getArtifactPrefix(review: ReviewContext): string {
    if (review.pr) {
      return `${review.pr.owner}-${review.pr.repo}-${review.pr.number}`;
    }
    return review.target.slug || review.id;
  }

  private getReviewLocator(review: ReviewContext): string {
    if (review.pr) {
      return `${review.pr.owner}/${review.pr.repo}#${review.pr.number}`;
    }
    return review.target.label;
  }

  private buildReviewPromptContext(review: ReviewContext): string {
    const { content, target } = review;
    const sections: string[] = [
      `You are reviewing ${target.kind === 'pull-request' ? 'a pull request' : 'a design document'}.`,
      `Target: ${target.label}`,
      `Title: ${content.title}`,
      `Author: ${content.author}`,
      `Source: ${content.source}`,
      content.baseBranch || content.headBranch
        ? `Branch: ${content.headBranch || '(unknown)'} -> ${content.baseBranch || '(unknown)'}`
        : '',
      `Changes: +${content.additions}/-${content.deletions} across ${content.changedFiles.length} files`,
      '',
    ];

    if (content.changedFiles.length > 0) {
      sections.push('Changed files:');
      sections.push(
        content.changedFiles
          .map((file) => `  ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`)
          .join('\n'),
      );
      sections.push('');
    }

    sections.push(target.kind === 'pull-request' ? 'Review Description:' : 'Review Content Summary:');
    sections.push(content.body || '(none)');

    if (content.documents.length > 0) {
      sections.push('');
      sections.push('Documents:');
      for (const document of content.documents) {
        sections.push(`### ${document.label}`);
        if (document.path) sections.push(`Path: ${document.path}`);
        sections.push(document.content.slice(0, 60000));
        sections.push('');
      }
    } else if (content.diff) {
      sections.push('');
      sections.push('Diff:');
      sections.push(content.diff.slice(0, 50000));
    }

    return sections.filter(Boolean).join('\n');
  }

  // ==========================================================================
  // Report Compilation (private helpers)
  // ==========================================================================

  private determineRecommendation(findings: Finding[]): ReviewRecommendation {
    const hasCritical = findings.some(f => f.severity === 'critical');
    const highCount = findings.filter(f => f.severity === 'high').length;

    if (hasCritical) return 'request-changes';
    if (highCount >= 2) return 'request-changes';
    if (highCount === 1) return 'comment';
    return 'approve';
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the outermost JSON object from agent output.
 * Agents return text + ```json blocks whose values contain nested code fences,
 * so a simple regex for ```...``` truncates. Instead, find the first `{` and
 * scan forward tracking brace depth, skipping strings.
 */
function extractOutermostJson(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text.trim();

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // No balanced closing brace found — return from { to end and let JSON.parse fail
  return text.slice(start);
}

/**
 * Extract per-file diff content from a unified diff string.
 * Returns a map of file path → diff hunk content.
 */
function extractDiffFiles(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  const fileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;
  const positions: { file: string; start: number }[] = [];

  while ((match = fileRegex.exec(diff)) !== null) {
    positions.push({ file: match[2], start: match.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start : diff.length;
    result.set(positions[i].file, diff.slice(positions[i].start, end));
  }

  return result;
}

function isPRIdentifier(value: ReviewTarget | PRIdentifier): value is PRIdentifier {
  return 'owner' in value && 'repo' in value && 'number' in value;
}

function buildOverview(review: ReviewContext): string {
  const { content, target } = review;
  const fileCount = content.changedFiles.length;

  if (target.kind === 'pull-request' && review.pr) {
    return (
      `PR #${review.pr.number} "${content.title}" by ${content.author} ` +
      `changes ${fileCount} file${fileCount !== 1 ? 's' : ''} ` +
      `(+${content.additions}/-${content.deletions}) ` +
      `merging ${content.headBranch} into ${content.baseBranch}.`
    );
  }

  return (
    `${target.label} "${content.title}" by ${content.author} ` +
    `includes ${content.documents.length} document${content.documents.length !== 1 ? 's' : ''} ` +
    `and ${fileCount} tracked file${fileCount !== 1 ? 's' : ''}.`
  );
}

function buildMarkdownReport(
  review: ReviewContext,
  overview: string,
  critical: Finding[],
  suggestions: Finding[],
  pairAgreementNotes: string[],
  debateNotes: string[],
  recommendation: ReviewRecommendation,
): string {
  const reportTitle = review.target.kind === 'pull-request'
    ? '# AI Consortium PR Review'
    : '# AI Consortium Design Doc Review';
  const lines: string[] = [
    reportTitle,
    '',
    '## Overview',
    overview,
    '',
  ];

  lines.push('## Triaged Findings', '');

  if (critical.length > 0) {
    lines.push('### Critical / Bugs');
    for (const f of critical) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      lines.push(`* **[${f.agent}]**${loc}: ${f.title}. ${f.suggestion || f.description}`);
    }
    lines.push('');
  }

  if (suggestions.length > 0) {
    lines.push('### Suggestions for Improvement');
    for (const f of suggestions) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      lines.push(`* **[${f.agent}]**${loc}: ${f.title}. ${f.suggestion || f.description}`);
    }
    lines.push('');
  }

  if (critical.length === 0 && suggestions.length === 0) {
    lines.push('No findings.', '');
  }

  // Suggested Fixes section — concrete remediation for every finding
  const allWithFixes = [...critical, ...suggestions].filter(f => f.suggestion);
  if (allWithFixes.length > 0) {
    lines.push('## Suggested Fixes', '');

    // Group by file for easy application
    const byFile = new Map<string, Finding[]>();
    for (const f of allWithFixes) {
      const key = f.file || '(general)';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(f);
    }

    for (const [file, findings] of byFile) {
      lines.push(`### ${file}`);
      for (const f of findings) {
        const loc = f.line ? `:${f.line}` : '';
        lines.push(`* **${f.severity}** — ${f.title}${loc}`);
        lines.push(`  > ${f.suggestion}`);
      }
      lines.push('');
    }
  }

  if (pairAgreementNotes.length > 0) {
    lines.push('## Pair Agreement (Opus vs Codex GPT 5.4)');
    for (const note of pairAgreementNotes) {
      lines.push(`* ${note}`);
    }
    lines.push('');
  }

  if (debateNotes.length > 0) {
    lines.push('## Debate Notes');
    for (const note of debateNotes) {
      lines.push(`* ${note}`);
    }
    lines.push('');
  }

  const recLabel =
    recommendation === 'approve'
      ? 'Approve'
      : recommendation === 'request-changes'
        ? 'Request Changes'
        : 'Comment';

  lines.push('## Final Recommendation', recLabel, '');

  return lines.join('\n');
}

function findingsPairAgree(
  left: Finding,
  right: Finding,
  severityRank: Record<FindingSeverity, number>,
  systemDesign: boolean,
): boolean {
  if (Math.abs(severityRank[right.severity] - severityRank[left.severity]) > 1) {
    return false;
  }

  if (left.file && right.file && left.file === right.file) {
    return true;
  }

  if (!systemDesign) {
    return false;
  }

  const titleSimilarity = normalizedTokenOverlap(left.title, right.title);
  const descriptionSimilarity = normalizedTokenOverlap(left.description, right.description);

  return (
    titleSimilarity >= 0.4 ||
    (left.category === right.category && titleSimilarity >= 0.25) ||
    descriptionSimilarity >= 0.35
  );
}

type DesignLevel = 'E4' | 'E5' | 'E6' | 'E7';
type DesignConfidence = 'high' | 'medium' | 'low';

interface ParsedDesignSummary {
  overallRead?: string;
  strengths: string[];
  gaps: string[];
  level?: DesignLevel;
  confidence?: DesignConfidence;
  rationale?: string;
  hiringRecommendation?: string;
}

function buildSystemDesignMarkdownReport(
  review: ReviewContext,
  overview: string,
  critical: Finding[],
  suggestions: Finding[],
  pairAgreementNotes: string[],
  debateNotes: string[],
  recommendation: ReviewRecommendation,
): string {
  const summaries = review.agentFindings.map(agent => parseDesignSummary(agent.summary));
  const strengths = dedupeStrings(
    summaries.flatMap(summary => summary.strengths),
  ).slice(0, 5);
  const topGaps = dedupeStrings([
    ...summaries.flatMap(summary => summary.gaps),
    ...rankDesignFindings(critical, suggestions).map(finding => finding.title),
  ]).slice(0, 6);

  const levelAssessment = deriveDesignLevelAssessment(summaries, critical, suggestions);
  const hiringRecommendation = deriveDesignHiringRecommendation(
    levelAssessment.level,
    recommendation,
    critical,
  );
  const executiveSummary = summaries
    .map(summary => summary.overallRead)
    .find(Boolean)
    || buildDesignExecutiveSummary(review, levelAssessment.level, critical, suggestions);

  const scalabilityFindings = selectDesignFindings(
    critical,
    suggestions,
    ['concurrency', 'throughput', 'latency', 'queue', 'batch', 'backpressure', 'rate limit', 'hot shard', 'fanout', 'scal'],
    ['performance', 'integration'],
  );
  const reliabilityFindings = selectDesignFindings(
    critical,
    suggestions,
    ['reliab', 'failure', 'retry', 'observab', 'rollout', 'cost', 'debug', 'operat', 'resilien', 'degrad'],
    ['security', 'integration', 'other'],
  );

  const lines: string[] = [
    '# AI Consortium System Design Review',
    '',
    '## Executive Summary',
    executiveSummary,
    '',
    '## Architecture Strengths',
  ];

  if (strengths.length > 0) {
    for (const strength of strengths) {
      lines.push(`- ${strength}`);
    }
  } else {
    lines.push('- The proposal shows intent to handle concurrency and throughput explicitly, but the strongest decisions were not articulated clearly enough to stand out.');
  }
  lines.push('');

  lines.push('## Critical Gaps');
  if (topGaps.length > 0) {
    for (const gap of topGaps) {
      lines.push(`- ${gap}`);
    }
  } else {
    lines.push('- No major architectural gaps were surfaced by the review agents.');
  }
  lines.push('');

  lines.push('## Scalability And Concurrency Review');
  lines.push(
    scalabilityFindings.length > 0
      ? formatDesignFindingParagraph(
          'The review highlights the main concurrency and scaling risks as',
          scalabilityFindings,
        )
      : 'The design does not yet make the throughput model, bottleneck assumptions, or backpressure strategy concrete enough to support a strong concurrency assessment.',
  );
  lines.push('');

  lines.push('## Reliability And Operations Review');
  lines.push(
    reliabilityFindings.length > 0
      ? formatDesignFindingParagraph(
          'Operationally, the highest-signal concerns are',
          reliabilityFindings,
        )
      : 'The proposal needs a clearer stance on failure handling, observability, rollout safety, and oncall/debugging ergonomics.',
  );
  lines.push('');

  if (pairAgreementNotes.length > 0) {
    lines.push('## Cross-Model Notes');
    for (const note of pairAgreementNotes) {
      lines.push(`- ${note}`);
    }
    if (debateNotes.length > 0) {
      for (const note of debateNotes.slice(0, 3)) {
        lines.push(`- ${note}`);
      }
    }
    lines.push('');
  }

  lines.push('## Level Assessment');
  lines.push(`- Level: ${levelAssessment.level}`);
  lines.push(`- Confidence: ${levelAssessment.confidence}`);
  lines.push(`- Rationale: ${levelAssessment.rationale}`);
  lines.push('');

  lines.push('## Hiring Recommendation');
  lines.push(hiringRecommendation);
  lines.push('');

  return lines.join('\n');
}

function parseDesignSummary(summary: string): ParsedDesignSummary {
  const lines = summary
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const parsed: ParsedDesignSummary = {
    strengths: [],
    gaps: [],
  };

  let section: 'strengths' | 'gaps' | null = null;

  for (const line of lines) {
    const normalized = line.replace(/^[*\-]\s*/, '');
    const lower = normalized.toLowerCase();

    if (lower.startsWith('overall read:') || lower.startsWith('overall:') || lower.startsWith('summary:')) {
      parsed.overallRead = normalized.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (lower.startsWith('strongest aspects:') || lower.startsWith('strengths:')) {
      const value = normalized.split(':').slice(1).join(':').trim();
      if (value) parsed.strengths.push(value);
      section = 'strengths';
      continue;
    }
    if (lower.startsWith('biggest gaps:') || lower.startsWith('gaps:') || lower.startsWith('weaknesses:')) {
      const value = normalized.split(':').slice(1).join(':').trim();
      if (value) parsed.gaps.push(value);
      section = 'gaps';
      continue;
    }
    if (lower.startsWith('level assessment:') || lower.startsWith('level:')) {
      const value = normalized.split(':').slice(1).join(':').trim();
      const levelMatch = value.match(/\b(E[4-7])\b/i);
      if (levelMatch) parsed.level = levelMatch[1].toUpperCase() as DesignLevel;
      if (/\bhigh\b/i.test(value)) parsed.confidence = 'high';
      else if (/\blow\b/i.test(value)) parsed.confidence = 'low';
      else if (/\bmedium\b/i.test(value)) parsed.confidence = 'medium';
      parsed.rationale = value;
      section = null;
      continue;
    }
    if (lower.startsWith('confidence:')) {
      const value = normalized.split(':').slice(1).join(':').trim().toLowerCase();
      if (value === 'high' || value === 'medium' || value === 'low') {
        parsed.confidence = value;
      }
      section = null;
      continue;
    }
    if (lower.startsWith('rationale:')) {
      parsed.rationale = normalized.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (lower.startsWith('hiring recommendation:')) {
      parsed.hiringRecommendation = normalized.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }

    if (section === 'strengths' && /^[*\-]/.test(line)) {
      parsed.strengths.push(normalized);
      continue;
    }
    if (section === 'gaps' && /^[*\-]/.test(line)) {
      parsed.gaps.push(normalized);
      continue;
    }

    if (!parsed.overallRead) {
      parsed.overallRead = normalized;
    }
  }

  if (!parsed.level) {
    const levelMatch = summary.match(/\b(E[4-7])\b/i);
    if (levelMatch) parsed.level = levelMatch[1].toUpperCase() as DesignLevel;
  }

  return parsed;
}

function deriveDesignLevelAssessment(
  summaries: ParsedDesignSummary[],
  critical: Finding[],
  suggestions: Finding[],
): { level: DesignLevel; confidence: DesignConfidence; rationale: string } {
  const levels = summaries
    .map(summary => summary.level)
    .filter((level): level is DesignLevel => Boolean(level));
  const counts = new Map<DesignLevel, number>();

  for (const level of levels) {
    counts.set(level, (counts.get(level) || 0) + 1);
  }

  const rankedLevels: DesignLevel[] = ['E7', 'E6', 'E5', 'E4'];
  const selectedLevel = rankedLevels.find(level => counts.has(level))
    || fallbackDesignLevel(critical, suggestions);
  const selectedCount = counts.get(selectedLevel) || 0;
  const confidence: DesignConfidence = selectedCount >= 2
    ? 'high'
    : levels.length === 1
      ? 'medium'
      : 'low';
  const summaryRationale = summaries
    .find(summary => summary.level === selectedLevel && summary.rationale)
    ?.rationale;
  const fallbackRationale = buildDesignLevelRationale(selectedLevel, critical, suggestions);

  return {
    level: selectedLevel,
    confidence,
    rationale: summaryRationale || fallbackRationale,
  };
}

function fallbackDesignLevel(critical: Finding[], suggestions: Finding[]): DesignLevel {
  const highSignalCount = critical.length;
  if (highSignalCount >= 4) return 'E4';
  if (highSignalCount >= 2) return 'E5';
  const mediumCount = suggestions.filter(finding => finding.severity === 'medium').length;
  if (mediumCount >= 3) return 'E5';
  return 'E6';
}

function buildDesignLevelRationale(
  level: DesignLevel,
  critical: Finding[],
  suggestions: Finding[],
): string {
  const topTitles = rankDesignFindings(critical, suggestions)
    .slice(0, 2)
    .map(finding => finding.title.toLowerCase());
  const evidence = topTitles.length > 0
    ? `The main limiting gaps are ${topTitles.join(' and ')}.`
    : 'The design signals were mixed and the level call is based on overall rigor rather than one decisive strength.';

  if (level === 'E4') {
    return `The proposal does not make enough of the core scaling, failure-mode, and operational tradeoffs concrete for a senior-level system design loop. ${evidence}`;
  }
  if (level === 'E5') {
    return `The design shows solid instincts, but several important tradeoffs are still underspecified before it reads as staff-level systems thinking. ${evidence}`;
  }
  if (level === 'E6') {
    return `The design demonstrates clear architectural structure and good systems judgment, with remaining gaps that look more like refinement than missing fundamentals. ${evidence}`;
  }
  return `The design demonstrates unusually strong tradeoff awareness, scaling strategy, and operational depth. ${evidence}`;
}

function buildDesignExecutiveSummary(
  review: ReviewContext,
  level: DesignLevel,
  critical: Finding[],
  suggestions: Finding[],
): string {
  const issueCount = critical.length + suggestions.length;
  const target = review.content.title || review.target.label;
  return `${target} reads like an ${level} system design submission overall. The proposal has the right problem framing, but the review still surfaced ${issueCount} material architecture concerns that affect scalability, reliability, or operating clarity.`;
}

function deriveDesignHiringRecommendation(
  level: DesignLevel,
  recommendation: ReviewRecommendation,
  critical: Finding[],
): string {
  if (recommendation === 'request-changes') {
    return critical.length >= 3 ? 'No' : 'Lean no';
  }
  if (level === 'E7') return 'Strong yes';
  if (level === 'E6') return 'Yes';
  if (level === 'E5') return recommendation === 'approve' ? 'Lean yes' : 'Lean no';
  return 'Lean no';
}

function rankDesignFindings(critical: Finding[], suggestions: Finding[]): Finding[] {
  const severityOrder: Record<FindingSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    info: 0,
  };

  return [...critical, ...suggestions].sort((left, right) => {
    const severityDelta = severityOrder[right.severity] - severityOrder[left.severity];
    if (severityDelta !== 0) return severityDelta;
    return right.confidence - left.confidence;
  });
}

function selectDesignFindings(
  critical: Finding[],
  suggestions: Finding[],
  keywords: string[],
  preferredCategories: Array<Finding['category']>,
): Finding[] {
  const matches = rankDesignFindings(critical, suggestions).filter((finding) => {
    const haystack = `${finding.title} ${finding.description} ${finding.suggestion || ''}`.toLowerCase();
    return keywords.some(keyword => haystack.includes(keyword))
      || preferredCategories.includes(finding.category);
  });

  return dedupeFindings(matches).slice(0, 3);
}

function formatDesignFindingParagraph(prefix: string, findings: Finding[]): string {
  return `${prefix} ${findings.map(formatDesignFindingSnippet).join('; ')}.`;
}

function formatDesignFindingSnippet(finding: Finding): string {
  const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
  return `${finding.title}${location}: ${finding.suggestion || finding.description}`;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];

  for (const finding of findings) {
    const key = finding.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }

  return result;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function normalizedTokenOverlap(left: string, right: string): number {
  const leftTokens = tokenizeForSimilarity(left);
  const rightTokens = tokenizeForSimilarity(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap++;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function tokenizeForSimilarity(text: string): Set<string> {
  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your',
    'have', 'will', 'would', 'should', 'could', 'does', 'did', 'are',
    'but', 'not', 'too', 'very', 'more', 'than', 'then', 'when', 'where',
    'what', 'why', 'how', 'its', 'their', 'about', 'across', 'under',
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 4 && !stopwords.has(token)),
  );
}

// ============================================================================
// Factory
// ============================================================================

export function createReviewService(
  projectRoot: string,
  config?: Partial<ReviewConfig>
): ReviewService {
  return new ReviewService(projectRoot, config);
}

export default ReviewService;
