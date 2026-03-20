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
  PRIdentifier,
  PRMetadata,
  ChangedFile,
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
} from './review-types.js';
import { DEFAULT_REVIEW_CONFIG } from './review-types.js';

// ============================================================================
// ReviewService
// ============================================================================

export class ReviewService {
  private reviewsDir: string;
  private config: ReviewConfig;

  constructor(projectRoot: string, config?: Partial<ReviewConfig>) {
    this.reviewsDir = path.join(projectRoot, '.claude', 'reviews');
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
    const ghArgs = [
      'pr', 'view', String(pr.number),
      '--repo', `${pr.owner}/${pr.repo}`,
      '--json', 'title,body,author,baseRefName,headRefName,additions,deletions,files',
    ];

    let prJson: string;
    try {
      prJson = execFileSync('gh', ghArgs, {
        encoding: 'utf-8',
        cwd: repoPath,
      });
    } catch (error) {
      throw new Error(
        `Failed to fetch PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const raw = JSON.parse(prJson);

    let diff = '';
    try {
      diff = execFileSync('gh', [
        'pr', 'diff', String(pr.number),
        '--repo', `${pr.owner}/${pr.repo}`,
      ], { encoding: 'utf-8', cwd: repoPath });
    } catch {
      // diff may fail for very large PRs; continue without it
    }

    const changedFiles: ChangedFile[] = (raw.files || []).map(
      (f: { path: string; additions: number; deletions: number; status?: string }) => ({
        path: f.path,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        status: mapFileStatus(f.status),
      })
    );

    return {
      title: raw.title || '',
      body: raw.body || '',
      author: raw.author?.login || raw.author || '',
      baseBranch: raw.baseRefName || 'main',
      headBranch: raw.headRefName || '',
      diff,
      changedFiles,
      additions: raw.additions || 0,
      deletions: raw.deletions || 0,
    };
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

  createReview(pr: PRIdentifier, metadata: PRMetadata, worktreePath?: string): ReviewContext {
    const now = new Date().toISOString();
    const review: ReviewContext = {
      id: randomUUID(),
      pr,
      metadata,
      status: 'initializing',
      worktreePath,
      agentFindings: [],
      pairAgreements: [],
      debates: [],
      config: this.config,
      createdAt: now,
      updatedAt: now,
    };

    this.saveReview(review);
    return review;
  }

  getReview(id: string): ReviewContext | null {
    const filePath = path.join(this.reviewsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReviewContext;
    } catch {
      return null;
    }
  }

  listReviews(statusFilter?: ReviewStatus): ReviewContext[] {
    if (!fs.existsSync(this.reviewsDir)) return [];

    const files = fs.readdirSync(this.reviewsDir).filter(
      f => f.endsWith('.json') && f !== 'config.json'
    );

    const reviews: ReviewContext[] = [];
    for (const file of files) {
      try {
        const review = JSON.parse(
          fs.readFileSync(path.join(this.reviewsDir, file), 'utf-8')
        ) as ReviewContext;

        if (!statusFilter || review.status === statusFilter) {
          reviews.push(review);
        }
      } catch {
        // Skip corrupted files
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
      r => r.pr.owner === pr.owner && r.pr.repo === pr.repo && r.pr.number === pr.number
    ) || null;
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

    const artifactsBase = path.join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.claude', 'reviews',
    );

    for (const review of all) {
      const updated = new Date(review.updatedAt).getTime();
      if (updated >= cutoff) continue;

      // Remove the review state JSON
      const stateFile = path.join(this.reviewsDir, `${review.id}.json`);
      try { fs.unlinkSync(stateFile); } catch { /* already gone */ }

      // Remove matching artifact directories
      if (fs.existsSync(artifactsBase)) {
        const prefix = `${review.pr.owner}-${review.pr.repo}-${review.pr.number}`;
        const dirs = fs.readdirSync(artifactsBase, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.startsWith(prefix));
        for (const dir of dirs) {
          try { fs.rmSync(path.join(artifactsBase, dir.name), { recursive: true }); } catch { /* best effort */ }
        }
      }

      removed.push({
        id: review.id,
        pr: `${review.pr.owner}/${review.pr.repo}#${review.pr.number}`,
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
    agentRole: 'security-auditor' | 'logic-checker' | 'integration-specialist',
    review: ReviewContext,
    providerLabel?: string
  ): string {
    const { metadata, pr } = review;
    const fileSummary = metadata.changedFiles
      .map(f => `  ${f.status} ${f.path} (+${f.additions}/-${f.deletions})`)
      .join('\n');

    const base = [
      `You are reviewing PR #${pr.number} in ${pr.owner}/${pr.repo}.`,
      `Title: ${metadata.title}`,
      `Author: ${metadata.author}`,
      `Branch: ${metadata.headBranch} -> ${metadata.baseBranch}`,
      `Changes: +${metadata.additions}/-${metadata.deletions} across ${metadata.changedFiles.length} files`,
      '',
      'Changed files:',
      fileSummary,
      '',
      'PR Description:',
      metadata.body || '(none)',
      '',
      'Diff:',
      metadata.diff.slice(0, 50000), // Truncate very large diffs
    ].join('\n');

    const fixInstructions = [
      'IMPORTANT: For every finding, you MUST include a concrete suggested fix in the "suggestion" field.',
      'The suggestion must be actionable — include the specific code change, pattern, or approach.',
      'Example: "Add null check: if (user == null) return early;" or "Replace md5 with bcrypt for password hashing".',
      'Do NOT leave suggestion empty or vague.',
    ].join('\n');

    const roleInstructions: Record<string, string> = {
      'security-auditor': [
        'Focus on: OWASP Top 10, race conditions, credential exposure, input validation, auth flaws, crypto weaknesses.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
      'logic-checker': [
        'Focus on: Algorithmic correctness, off-by-one errors, boundary conditions, error handling, dead code, test gaps.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
      'integration-specialist': [
        'Focus on: Breaking API changes, architectural drift, cross-module impact, dependency changes, migration safety.',
        fixInstructions,
        'Return your findings as JSON matching the AgentFindings interface.',
      ].join('\n'),
    };

    const providerNote = providerLabel ? `\nYou are running as: ${providerLabel}.\n` : '';
    return `${base}${providerNote}\n\n${roleInstructions[agentRole]}\n\nRespond ONLY with valid JSON.`;
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
    const roles = ['security-auditor', 'logic-checker', 'integration-specialist'];
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
            xf.file === cf.file &&
            xf.file !== undefined &&
            Math.abs(severityRank[xf.severity] - severityRank[cf.severity]) <= 1
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
    const markdown = buildMarkdownReport(overview, criticalFindings, suggestions, pairAgreementNotes, debateNotes, recommendation);

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
    agentRole: 'security-auditor' | 'logic-checker' | 'integration-specialist',
    review: ReviewContext,
    provider: ModelProvider,
    hasCodebaseAccess: boolean,
  ): string {
    const providerLabel = provider === 'claude'
      ? `Claude ${review.config.providers.queen.model}`
      : `Codex ${review.config.providers.securityAuditor.codex.model}`;

    const basePrompt = this.buildAgentPrompt(agentRole, review, providerLabel);

    if (!hasCodebaseAccess) {
      return basePrompt + '\n\nNote: Analyze ONLY the diff provided. Note when your analysis would benefit from broader codebase context.\n';
    }

    const codebaseInstructions = provider === 'claude'
      ? [
          '',
          'CODEBASE ACCESS: You have full access to the repository at the PR\'s HEAD commit.',
          'Use Read, Grep, and Glob tools to explore beyond the diff when needed:',
          '- Check how modified functions are called elsewhere',
          '- Verify whether upstream sanitization or validation exists',
          '- Look at related modules and tests',
          '- Examine type definitions and interfaces',
          'Do NOT limit yourself to the diff — investigate the full context.',
        ].join('\n')
      : [
          '',
          'CODEBASE ACCESS: You have full access to the repository at the PR\'s HEAD commit.',
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
   * Returns the review directory path.
   */
  persistArtifacts(
    review: ReviewContext,
    agentOutputs: Map<string, string>,
    reportMarkdown: string,
  ): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dirName = `${review.pr.owner}-${review.pr.repo}-${review.pr.number}-${timestamp}`;
    const reviewDir = path.join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.claude', 'reviews', dirName,
    );
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
    const { metadata, pr } = review;
    const parts: string[] = [
      `You are the Queen Reviewer for PR #${pr.number} in ${pr.owner}/${pr.repo}.`,
      `Title: ${metadata.title} | Author: ${metadata.author} | Branch: ${metadata.headBranch} -> ${metadata.baseBranch}`,
      `Changes: +${metadata.additions}/-${metadata.deletions} across ${metadata.changedFiles.length} files`,
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

function mapFileStatus(status?: string): 'added' | 'modified' | 'deleted' | 'renamed' {
  switch (status?.toLowerCase()) {
    case 'added':
    case 'a':
      return 'added';
    case 'deleted':
    case 'd':
    case 'removed':
      return 'deleted';
    case 'renamed':
    case 'r':
      return 'renamed';
    default:
      return 'modified';
  }
}

function buildOverview(review: ReviewContext): string {
  const { metadata, pr } = review;
  const fileCount = metadata.changedFiles.length;
  return (
    `PR #${pr.number} "${metadata.title}" by ${metadata.author} ` +
    `changes ${fileCount} file${fileCount !== 1 ? 's' : ''} ` +
    `(+${metadata.additions}/-${metadata.deletions}) ` +
    `merging ${metadata.headBranch} into ${metadata.baseBranch}.`
  );
}

function buildMarkdownReport(
  overview: string,
  critical: Finding[],
  suggestions: Finding[],
  pairAgreementNotes: string[],
  debateNotes: string[],
  recommendation: ReviewRecommendation,
): string {
  const lines: string[] = [
    '# AI Consortium PR Review',
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
