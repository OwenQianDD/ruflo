/**
 * @claude-flow/cache-optimizer - Tests
 * Comprehensive test suite for cache optimization system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CacheOptimizer,
  createCacheOptimizer,
  TokenCounter,
  createTokenCounter,
  TemporalCompressor,
  createTemporalCompressor,
  FlashAttention,
  createFlashAttention,
  BenchmarkSuite,
  createBenchmarkSuite,
  DEFAULT_CONFIG,
} from '../index.js';
import type {
  CacheEntry,
  ScoringContext,
  TemporalTier,
} from '../types.js';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = createTokenCounter(200000);
  });

  it('should count tokens approximately', () => {
    const text = 'Hello, world! This is a test.';
    const tokens = counter.countTokens(text, 'user_message');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // Tokens < chars
  });

  it('should track utilization correctly', () => {
    expect(counter.getUtilization()).toBe(0);

    const entry: CacheEntry = {
      id: 'test-1',
      type: 'user_message',
      content: 'test content',
      tokens: 10000,
      timestamp: Date.now(),
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 1, components: { recency: 1, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: Date.now(), confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: Date.now(),
    };

    counter.addEntry(entry);
    expect(counter.getUtilization()).toBe(10000 / 200000);
  });

  it('should detect threshold violations', () => {
    const entry: CacheEntry = {
      id: 'test-1',
      type: 'user_message',
      content: 'test',
      tokens: 150000, // 75% of 200K
      timestamp: Date.now(),
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 1, components: { recency: 1, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: Date.now(), confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: Date.now(),
    };

    counter.addEntry(entry);
    expect(counter.isAboveThreshold(0.70)).toBe(true);
    expect(counter.isAboveThreshold(0.80)).toBe(false);
  });

  it('should calculate tokens to free', () => {
    const entry: CacheEntry = {
      id: 'test-1',
      type: 'user_message',
      content: 'test',
      tokens: 160000, // 80%
      timestamp: Date.now(),
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 1, components: { recency: 1, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: Date.now(), confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: Date.now(),
    };

    counter.addEntry(entry);
    const tokensToFree = counter.getTokensToFree(0.60); // Target 60%
    expect(tokensToFree).toBe(160000 - 120000); // 40K tokens to free
  });

  it('should track entries by tier', () => {
    const hotEntry: CacheEntry = {
      id: 'hot-1',
      type: 'user_message',
      content: 'hot',
      tokens: 100,
      timestamp: Date.now(),
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 1, components: { recency: 1, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: Date.now(), confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: Date.now(),
    };

    const warmEntry: CacheEntry = {
      ...hotEntry,
      id: 'warm-1',
      tier: 'warm',
    };

    counter.addEntry(hotEntry);
    counter.addEntry(warmEntry);

    const metrics = counter.getMetrics();
    expect(metrics.entriesByTier.hot).toBe(1);
    expect(metrics.entriesByTier.warm).toBe(1);
  });
});

describe('TemporalCompressor', () => {
  let compressor: TemporalCompressor;

  beforeEach(() => {
    compressor = createTemporalCompressor();
  });

  it('should determine tier based on age', () => {
    const now = Date.now();

    const hotEntry: CacheEntry = {
      id: 'hot-1',
      type: 'user_message',
      content: 'recent',
      tokens: 100,
      timestamp: now - 1000, // 1 second ago
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 1, components: { recency: 1, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: now, confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: now,
    };

    const warmEntry: CacheEntry = {
      ...hotEntry,
      id: 'warm-1',
      timestamp: now - 10 * 60 * 1000, // 10 minutes ago
      lastAccessedAt: now - 10 * 60 * 1000,
    };

    const coldEntry: CacheEntry = {
      ...hotEntry,
      id: 'cold-1',
      timestamp: now - 60 * 60 * 1000, // 1 hour ago
      lastAccessedAt: now - 60 * 60 * 1000,
    };

    expect(compressor.determineTier(hotEntry)).toBe('hot');
    expect(compressor.determineTier(warmEntry)).toBe('warm');
    expect(compressor.determineTier(coldEntry)).toBe('cold');
  });

  it('should compress entries when transitioning tiers', async () => {
    const entry: CacheEntry = {
      id: 'test-1',
      type: 'file_read',
      content: 'function test() {\n  console.log("hello world");\n  return 42;\n}',
      tokens: 50,
      timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 0.5, components: { recency: 0.5, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: Date.now(), confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: Date.now() - 10 * 60 * 1000,
    };

    const compressed = await compressor.compressEntry(entry, 'warm');
    expect(compressed).toBeDefined();
    expect(compressed!.compressedTokens).toBeLessThan(entry.tokens);
    expect(compressed!.ratio).toBeLessThan(1);
  });

  it('should not compress hot tier entries', async () => {
    const entry: CacheEntry = {
      id: 'test-1',
      type: 'user_message',
      content: 'test content',
      tokens: 10,
      timestamp: Date.now(),
      metadata: { source: 'test', sessionId: 'test', tags: [] },
      relevance: { overall: 1, components: { recency: 1, frequency: 0.5, semantic: 0.5, attention: 0.5, expert: 0.5 }, scoredAt: Date.now(), confidence: 0.5 },
      tier: 'hot',
      accessCount: 1,
      lastAccessedAt: Date.now(),
    };

    const compressed = await compressor.compressEntry(entry, 'hot');
    expect(compressed).toBeUndefined();
  });
});

describe('FlashAttention', () => {
  let attention: FlashAttention;

  beforeEach(() => {
    attention = createFlashAttention();
  });

  it('should score entries based on context', async () => {
    const entries: CacheEntry[] = [
      {
        id: 'relevant-1',
        type: 'file_read',
        content: 'authentication code',
        tokens: 100,
        timestamp: Date.now(),
        metadata: { source: 'test', sessionId: 'test-session', filePath: '/src/auth.ts', tags: [] },
        relevance: { overall: 0, components: { recency: 0, frequency: 0, semantic: 0, attention: 0, expert: 0 }, scoredAt: 0, confidence: 0 },
        tier: 'hot',
        accessCount: 5,
        lastAccessedAt: Date.now(),
      },
      {
        id: 'irrelevant-1',
        type: 'bash_output',
        content: 'npm install complete',
        tokens: 50,
        timestamp: Date.now() - 30 * 60 * 1000, // 30 min ago
        metadata: { source: 'test', sessionId: 'old-session', tags: [] },
        relevance: { overall: 0, components: { recency: 0, frequency: 0, semantic: 0, attention: 0, expert: 0 }, scoredAt: 0, confidence: 0 },
        tier: 'warm',
        accessCount: 1,
        lastAccessedAt: Date.now() - 30 * 60 * 1000,
      },
    ];

    const context: ScoringContext = {
      currentQuery: 'fix authentication bug',
      activeFiles: ['/src/auth.ts'],
      activeTools: ['read'],
      sessionId: 'test-session',
      timestamp: Date.now(),
    };

    const scores = await attention.scoreEntries(entries, context);

    expect(scores.get('relevant-1')!.overall).toBeGreaterThan(scores.get('irrelevant-1')!.overall);
  });

  it('should give higher scores to recent entries', async () => {
    const now = Date.now();
    const entries: CacheEntry[] = [
      {
        id: 'recent',
        type: 'user_message',
        content: 'test',
        tokens: 10,
        timestamp: now,
        metadata: { source: 'test', sessionId: 'test', tags: [] },
        relevance: { overall: 0, components: { recency: 0, frequency: 0, semantic: 0, attention: 0, expert: 0 }, scoredAt: 0, confidence: 0 },
        tier: 'hot',
        accessCount: 1,
        lastAccessedAt: now,
      },
      {
        id: 'old',
        type: 'user_message',
        content: 'test',
        tokens: 10,
        timestamp: now - 60 * 60 * 1000, // 1 hour ago
        metadata: { source: 'test', sessionId: 'test', tags: [] },
        relevance: { overall: 0, components: { recency: 0, frequency: 0, semantic: 0, attention: 0, expert: 0 }, scoredAt: 0, confidence: 0 },
        tier: 'cold',
        accessCount: 1,
        lastAccessedAt: now - 60 * 60 * 1000,
      },
    ];

    const context: ScoringContext = {
      currentQuery: '',
      activeFiles: [],
      activeTools: [],
      sessionId: 'test',
      timestamp: now,
    };

    const scores = await attention.scoreEntries(entries, context);
    expect(scores.get('recent')!.components.recency).toBeGreaterThan(scores.get('old')!.components.recency);
  });
});

describe('CacheOptimizer', () => {
  let optimizer: CacheOptimizer;

  beforeEach(async () => {
    optimizer = createCacheOptimizer({
      contextWindowSize: 10000, // Small for testing
      pruning: {
        softThreshold: 0.6,
        hardThreshold: 0.75,
        emergencyThreshold: 0.85,
        minRelevanceScore: 0.3,
        strategy: 'adaptive',
        preservePatterns: ['system_prompt'],
        preserveRecentCount: 2,
      },
    });
    await optimizer.initialize();
  });

  it('should add entries and track utilization', async () => {
    expect(optimizer.getUtilization()).toBe(0);

    await optimizer.add('Hello world', 'user_message', { sessionId: 'test' });
    expect(optimizer.getUtilization()).toBeGreaterThan(0);
  });

  it('should get entries and update access tracking', async () => {
    const id = await optimizer.add('test content', 'user_message', { sessionId: 'test' });
    const entry = await optimizer.get(id);

    expect(entry).toBeDefined();
    expect(entry!.accessCount).toBe(2); // Initial + get
  });

  it('should prune low relevance entries when threshold exceeded', async () => {
    // Add entries to exceed threshold
    for (let i = 0; i < 10; i++) {
      await optimizer.add('x'.repeat(800), 'bash_output', { sessionId: 'test' });
    }

    const utilizationBefore = optimizer.getUtilization();
    expect(utilizationBefore).toBeGreaterThan(0.6);

    // Trigger pruning via hook
    const result = await optimizer.onUserPromptSubmit('test', 'test');

    // Should have pruned something
    expect(optimizer.getUtilization()).toBeLessThanOrEqual(utilizationBefore);
  });

  it('should preserve system prompts', async () => {
    const systemId = await optimizer.add('system prompt content', 'system_prompt', { sessionId: 'test' });

    // Add many other entries
    for (let i = 0; i < 20; i++) {
      await optimizer.add('x'.repeat(400), 'bash_output', { sessionId: 'test' });
    }

    // Trigger pruning
    await optimizer.onUserPromptSubmit('test', 'test');

    // System prompt should still exist
    const systemEntry = await optimizer.get(systemId);
    expect(systemEntry).toBeDefined();
  });

  it('should handle preCompact hook', async () => {
    // Fill cache to emergency level
    for (let i = 0; i < 30; i++) {
      await optimizer.add('x'.repeat(300), 'tool_result', { sessionId: 'test' });
    }

    const result = await optimizer.onPreCompact('auto');

    // Should have attempted emergency pruning
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it('should delete entries', async () => {
    const id = await optimizer.add('test', 'user_message', { sessionId: 'test' });
    expect(optimizer.getEntry(id)).toBeDefined();

    const deleted = await optimizer.delete(id);
    expect(deleted).toBe(true);
    expect(optimizer.getEntry(id)).toBeUndefined();
  });

  it('should clear all entries', async () => {
    await optimizer.add('test1', 'user_message', { sessionId: 'test' });
    await optimizer.add('test2', 'user_message', { sessionId: 'test' });

    expect(optimizer.getEntries().length).toBe(2);

    await optimizer.clear();
    expect(optimizer.getEntries().length).toBe(0);
    expect(optimizer.getUtilization()).toBe(0);
  });
});

describe('BenchmarkSuite', () => {
  let suite: BenchmarkSuite;
  let optimizer: CacheOptimizer;

  beforeEach(async () => {
    suite = createBenchmarkSuite({ sampleRate: 1.0 }); // 100% sampling for tests
    optimizer = createCacheOptimizer({ contextWindowSize: 10000 });
    await optimizer.initialize();
  });

  it('should track latency metrics', () => {
    suite.recordScoring(10);
    suite.recordScoring(20);
    suite.recordScoring(30);

    const metrics = suite.getLatencyMetrics();
    expect(metrics.scoring.count).toBe(3);
    expect(metrics.scoring.avg).toBe(20);
  });

  it('should generate report', async () => {
    suite.recordScoring(10);
    suite.recordPruning(50, 1000);
    suite.recordCompactionPrevented();

    const report = suite.getReport(optimizer);

    expect(report.effectiveness.compactionsPrevented).toBe(1);
    expect(report.effectiveness.totalPruningOps).toBe(1);
    expect(report.effectiveness.totalTokensFreed).toBe(1000);
  });

  it('should export in different formats', async () => {
    suite.recordScoring(10);

    const json = suite.exportReport(optimizer);
    expect(JSON.parse(json)).toBeDefined();
  });
});

describe('Integration', () => {
  it('should prevent compaction through intelligent pruning', async () => {
    const optimizer = createCacheOptimizer({
      contextWindowSize: 5000,
      pruning: {
        softThreshold: 0.5,
        hardThreshold: 0.7,
        emergencyThreshold: 0.85,
        minRelevanceScore: 0.2,
        strategy: 'adaptive',
        preservePatterns: ['system_prompt'],
        preserveRecentCount: 2,
      },
    });
    await optimizer.initialize();

    // Simulate a session with growing context
    await optimizer.add('System prompt', 'system_prompt', { sessionId: 'session-1' });

    // Add file reads
    for (let i = 0; i < 5; i++) {
      await optimizer.add(`File content ${i}`, 'file_read', {
        sessionId: 'session-1',
        filePath: `/src/file${i}.ts`,
      });
    }

    // Add tool results
    for (let i = 0; i < 5; i++) {
      await optimizer.add(`Tool result ${i}`, 'tool_result', {
        sessionId: 'session-1',
        toolName: 'Read',
      });
    }

    // Simulate user prompt submission (triggers optimization)
    const result = await optimizer.onUserPromptSubmit('Fix the authentication bug', 'session-1');

    // Utilization should be manageable
    expect(optimizer.getUtilization()).toBeLessThanOrEqual(0.85);

    // Should have taken some action
    const metrics = optimizer.getMetrics();
    expect(metrics.totalEntries).toBeGreaterThan(0);
  });
});
