/**
 * Tests for ReviewService — state management, debate logic, report compilation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReviewService, createReviewService } from '../../v3/@claude-flow/cli/src/services/review-service.js';
import type {
  PRIdentifier,
  PRMetadata,
  AgentFindings,
  Finding,
  DebatePosition,
  ReviewContext,
} from '../../v3/@claude-flow/cli/src/services/review-types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function makePR(): PRIdentifier {
  return { owner: 'test-org', repo: 'test-repo', number: 42, url: 'https://github.com/test-org/test-repo/pull/42' };
}

function makeMetadata(): PRMetadata {
  return {
    title: 'Add user authentication',
    body: 'Implements OAuth2 login flow',
    author: 'test-user',
    baseBranch: 'main',
    headBranch: 'feature/auth',
    diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,10 @@\n+function login() {}',
    changedFiles: [
      { path: 'src/auth.ts', additions: 10, deletions: 0, status: 'modified' },
      { path: 'src/middleware.ts', additions: 5, deletions: 2, status: 'modified' },
    ],
    additions: 15,
    deletions: 2,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-001',
    agent: 'security-auditor',
    severity: 'high',
    category: 'security',
    title: 'Missing input validation',
    description: 'User input is not validated before use',
    file: 'src/auth.ts',
    line: 5,
    confidence: 0.9,
    ...overrides,
  };
}

function makeAgentFindings(agent: string, findings: Finding[]): AgentFindings {
  return {
    agent,
    model: 'test-model',
    findings,
    summary: `${findings.length} findings from ${agent}`,
    completedAt: new Date().toISOString(),
    durationMs: 1000,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('ReviewService', () => {
  let tmpDir: string;
  let service: ReviewService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
    service = createReviewService(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Initialization
  // ==========================================================================

  describe('initialize', () => {
    it('creates the reviews directory', async () => {
      await service.initialize();
      const reviewsDir = path.join(tmpDir, '.claude', 'reviews');
      expect(fs.existsSync(reviewsDir)).toBe(true);
    });

    it('is idempotent', async () => {
      await service.initialize();
      await service.initialize();
      const reviewsDir = path.join(tmpDir, '.claude', 'reviews');
      expect(fs.existsSync(reviewsDir)).toBe(true);
    });
  });

  // ==========================================================================
  // Review CRUD
  // ==========================================================================

  describe('createReview / getReview', () => {
    it('creates and persists a review', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());

      expect(review.id).toBeDefined();
      expect(review.status).toBe('initializing');
      expect(review.pr.number).toBe(42);

      const loaded = service.getReview(review.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(review.id);
      expect(loaded!.metadata.title).toBe('Add user authentication');
    });

    it('returns null for nonexistent review', async () => {
      await service.initialize();
      expect(service.getReview('nonexistent-id')).toBeNull();
    });
  });

  describe('listReviews', () => {
    it('lists all reviews sorted by newest first', async () => {
      await service.initialize();
      const r1 = service.createReview(makePR(), makeMetadata());
      const r2 = service.createReview(
        { ...makePR(), number: 43 },
        { ...makeMetadata(), title: 'Second PR' }
      );

      const all = service.listReviews();
      expect(all).toHaveLength(2);
      // newest first
      expect(all[0].id).toBe(r2.id);
      expect(all[1].id).toBe(r1.id);
    });

    it('filters by status', async () => {
      await service.initialize();
      const r1 = service.createReview(makePR(), makeMetadata());
      r1.status = 'completed';
      service.saveReview(r1);
      service.createReview({ ...makePR(), number: 43 }, makeMetadata());

      const completed = service.listReviews('completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(r1.id);
    });

    it('returns empty array when no reviews', async () => {
      await service.initialize();
      expect(service.listReviews()).toEqual([]);
    });
  });

  describe('saveReview', () => {
    it('updates the updatedAt timestamp', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      const originalUpdated = review.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 10));

      review.status = 'reviewing';
      service.saveReview(review);

      const loaded = service.getReview(review.id)!;
      expect(loaded.status).toBe('reviewing');
      expect(loaded.updatedAt).not.toBe(originalUpdated);
    });
  });

  // ==========================================================================
  // Agent Prompt Building
  // ==========================================================================

  describe('buildAgentPrompt', () => {
    it('builds a prompt containing PR info', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());

      const prompt = service.buildAgentPrompt('security-auditor', review);
      expect(prompt).toContain('PR #42');
      expect(prompt).toContain('test-org/test-repo');
      expect(prompt).toContain('Add user authentication');
      expect(prompt).toContain('OWASP');
    });

    it('includes role-specific instructions', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());

      const secPrompt = service.buildAgentPrompt('security-auditor', review);
      expect(secPrompt).toContain('OWASP');

      const logicPrompt = service.buildAgentPrompt('logic-checker', review);
      expect(logicPrompt).toContain('off-by-one');

      const intPrompt = service.buildAgentPrompt('integration-specialist', review);
      expect(intPrompt).toContain('Breaking');
    });
  });

  // ==========================================================================
  // Agent Output Parsing
  // ==========================================================================

  describe('parseAgentOutput', () => {
    it('parses valid JSON output', () => {
      const json = JSON.stringify({
        findings: [makeFinding()],
        summary: '1 finding',
      });

      const result = service.parseAgentOutput('security-auditor', 'opus', json, 1500);
      expect(result.agent).toBe('security-auditor');
      expect(result.findings).toHaveLength(1);
      expect(result.summary).toBe('1 finding');
      expect(result.durationMs).toBe(1500);
    });

    it('extracts JSON from markdown code block', () => {
      const output = '```json\n{"findings": [], "summary": "clean"}\n```';
      const result = service.parseAgentOutput('logic-checker', 'sonnet', output, 800);
      expect(result.findings).toEqual([]);
      expect(result.summary).toBe('clean');
    });

    it('handles non-JSON output gracefully', () => {
      const result = service.parseAgentOutput('logic-checker', 'sonnet', 'This is plain text output', 500);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('info');
      expect(result.findings[0].description).toContain('plain text');
    });
  });

  // ==========================================================================
  // Disagreement Detection
  // ==========================================================================

  describe('findDisagreements', () => {
    it('returns empty when no disagreements', () => {
      const findings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'medium' }),
        ]),
        makeAgentFindings('logic-checker', [
          makeFinding({ id: 'logic-1', severity: 'medium', agent: 'logic-checker' }),
        ]),
      ];

      const disputed = service.findDisagreements(findings);
      expect(disputed).toHaveLength(0);
    });

    it('detects severity disagreements on same file', () => {
      const findings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'critical', file: 'src/auth.ts' }),
        ]),
        makeAgentFindings('logic-checker', [
          makeFinding({ id: 'logic-1', severity: 'low', agent: 'logic-checker', file: 'src/auth.ts' }),
        ]),
      ];

      const disputed = service.findDisagreements(findings);
      expect(disputed.length).toBeGreaterThanOrEqual(1);
      expect(disputed[0].id).toBe('sec-1');
    });

    it('flags critical findings not mentioned by other agents', () => {
      const findings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'critical', file: 'src/secret.ts' }),
        ]),
        makeAgentFindings('logic-checker', [
          // No findings for src/secret.ts
          makeFinding({ id: 'logic-1', severity: 'medium', agent: 'logic-checker', file: 'src/other.ts' }),
        ]),
      ];

      const disputed = service.findDisagreements(findings);
      expect(disputed.some(f => f.id === 'sec-1')).toBe(true);
    });
  });

  // ==========================================================================
  // Debate Loop
  // ==========================================================================

  describe('runDebateLoop', () => {
    it('returns empty rounds when no disagreements', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'low' }),
        ]),
      ];

      const rounds = service.runDebateLoop(review, () => []);
      expect(rounds).toHaveLength(0);
    });

    it('resolves with consensus when agents agree', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'critical', file: 'src/auth.ts' }),
        ]),
        makeAgentFindings('logic-checker', [
          makeFinding({ id: 'logic-1', severity: 'low', agent: 'logic-checker', file: 'src/auth.ts' }),
        ]),
      ];

      const rounds = service.runDebateLoop(review, () => [
        { agent: 'security-auditor', stance: 'agree', reasoning: 'Confirmed critical' },
        { agent: 'logic-checker', stance: 'agree', reasoning: 'I agree on re-evaluation' },
        { agent: 'integration-specialist', stance: 'agree', reasoning: 'Concur' },
      ]);

      expect(rounds.length).toBeGreaterThanOrEqual(1);
      expect(rounds[0].resolution).toBe('consensus');
    });

    it('falls back to queen override after max rounds', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'critical', file: 'src/auth.ts' }),
        ]),
        makeAgentFindings('logic-checker', [
          makeFinding({ id: 'logic-1', severity: 'low', agent: 'logic-checker', file: 'src/auth.ts' }),
        ]),
      ];

      const rounds = service.runDebateLoop(review, () => [
        { agent: 'security-auditor', stance: 'disagree', reasoning: 'Still critical' },
        { agent: 'logic-checker', stance: 'disagree', reasoning: 'Still low' },
      ]);

      const lastRound = rounds[rounds.length - 1];
      expect(lastRound.resolution).toBe('queen-override');
    });
  });

  // ==========================================================================
  // Report Compilation
  // ==========================================================================

  describe('compileReport', () => {
    it('compiles a report with correct recommendation', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'critical' }),
        ]),
        makeAgentFindings('logic-checker', [
          makeFinding({ id: 'logic-1', severity: 'low', agent: 'logic-checker', category: 'logic' }),
        ]),
      ];
      review.debates = [];

      const report = service.compileReport(review);
      expect(report.recommendation).toBe('request-changes');
      expect(report.criticalFindings).toHaveLength(1);
      expect(report.suggestions).toHaveLength(1);
      expect(report.markdown).toContain('# AI Consortium PR Review');
      expect(report.markdown).toContain('Request Changes');
    });

    it('recommends approve when no critical/high findings', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'low' }),
        ]),
      ];

      const report = service.compileReport(review);
      expect(report.recommendation).toBe('approve');
    });

    it('includes debate notes in report', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [
        makeAgentFindings('security-auditor', [
          makeFinding({ id: 'sec-1', severity: 'medium' }),
        ]),
      ];
      review.debates = [{
        round: 1,
        topic: 'Input validation',
        findingId: 'sec-1',
        positions: [],
        resolution: 'consensus',
        resolvedSeverity: 'medium',
        notes: 'All agents agreed on medium severity.',
      }];

      const report = service.compileReport(review);
      expect(report.debateNotes).toHaveLength(1);
      expect(report.markdown).toContain('Debate Notes');
    });

    it('generates valid markdown', async () => {
      await service.initialize();
      const review = service.createReview(makePR(), makeMetadata());
      review.agentFindings = [];

      const report = service.compileReport(review);
      expect(report.markdown).toContain('# AI Consortium PR Review');
      expect(report.markdown).toContain('## Overview');
      expect(report.markdown).toContain('## Final Recommendation');
    });
  });

  // ==========================================================================
  // Local Repo Validation
  // ==========================================================================

  describe('validateLocalRepo', () => {
    it('throws when repo does not exist', () => {
      const pr = makePR();
      expect(() => service.validateLocalRepo(pr)).toThrow('Local repo not found');
    });

    it('returns path when .git exists', () => {
      const pr = makePR();
      const repoPath = path.join(tmpDir, 'Projects', pr.repo);
      fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });

      // Need a service with projectsDir pointing to our tmpDir/Projects
      const svc = createReviewService(tmpDir, {
        projectsDir: path.join(tmpDir, 'Projects'),
      });

      const result = svc.validateLocalRepo(pr);
      expect(result).toBe(repoPath);
    });
  });
});
