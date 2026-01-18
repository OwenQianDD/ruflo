/**
 * Advanced Optimizer - Integrates Flash Attention, Temporal Compression, and GNN
 *
 * Combines intelligence from @claude-flow/cache-optimizer for enhanced message optimization:
 * - FlashAttention: O(N) relevance scoring with recency, frequency, semantic, attention, expert components
 * - TemporalCompressor: Hot/Warm/Cold tier transitions with intelligent compression
 * - CacheGNN: Graph Neural Network for relationship learning and access prediction
 */

// ============================================================================
// Types (adapted from cache-optimizer for JSONL message format)
// ============================================================================

export type MessageType =
  | 'user'
  | 'assistant'
  | 'summary'
  | 'system'
  | 'file-history-snapshot'
  | 'queue-operation'
  | 'unknown';

export type TemporalTier = 'hot' | 'warm' | 'cold' | 'archived';

export interface ParsedMessage {
  line: string;
  parsed: {
    type: MessageType;
    timestamp?: number;
    uuid?: string;
    message?: {
      content?: string | Array<{ text?: string }>;
    };
    summary?: string;
    files?: string[];
    [key: string]: unknown;
  };
  tokens: number;
  relevanceScore?: RelevanceScore;
  tier?: TemporalTier;
  accessCount?: number;
  lastAccessed?: number;
}

export interface RelevanceScore {
  overall: number;
  components: RelevanceComponents;
  confidence: number;
}

export interface RelevanceComponents {
  recency: number;
  frequency: number;
  semantic: number;
  attention: number;
  expert: number;
}

export interface ScoringContext {
  timestamp: number;
  activeFiles: string[];
  activeTools: string[];
  sessionId: string;
  taskId?: string;
  currentQuery?: string;
}

export interface OptimizationResult {
  optimizedLines: string[];
  metrics: {
    originalCount: number;
    optimizedCount: number;
    originalTokens: number;
    optimizedTokens: number;
    reductionPercent: number;
    tiersDistribution: Record<TemporalTier, number>;
    gnnClusters: number;
    averageRelevance: number;
    processingTimeMs: number;
  };
}

export interface AdvancedOptimizerConfig {
  targetSizeBytes: number;
  keepRecentMessages: number;
  flashAttention: {
    blockSize: number;
    causal: boolean;
  };
  temporal: {
    hotMaxAgeMs: number;
    warmMaxAgeMs: number;
    decayRate: number;
    compressionStrategy: 'summary' | 'embedding' | 'hybrid';
  };
  gnn: {
    inputDim: number;
    outputDim: number;
    numHeads: number;
  };
}

const DEFAULT_CONFIG: AdvancedOptimizerConfig = {
  targetSizeBytes: 500000, // 500KB
  keepRecentMessages: 50,
  flashAttention: {
    blockSize: 32,
    causal: true,
  },
  temporal: {
    hotMaxAgeMs: 5 * 60 * 1000,     // 5 minutes
    warmMaxAgeMs: 30 * 60 * 1000,   // 30 minutes
    decayRate: 0.1,
    compressionStrategy: 'summary',
  },
  gnn: {
    inputDim: 32,
    outputDim: 16,
    numHeads: 4,
  },
};

// ============================================================================
// Flash Attention (adapted for JSONL messages)
// ============================================================================

class FlashAttentionScorer {
  private config: AdvancedOptimizerConfig;

  constructor(config: AdvancedOptimizerConfig) {
    this.config = config;
  }

  scoreMessages(messages: ParsedMessage[], context: ScoringContext): Map<number, RelevanceScore> {
    const results = new Map<number, RelevanceScore>();
    const now = context.timestamp;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const components = this.computeComponents(msg, context, now, i, messages.length);
      const overall = this.computeOverallScore(components);
      const confidence = this.computeConfidence(msg, components);

      results.set(i, {
        overall,
        components,
        confidence,
      });
    }

    return results;
  }

  private computeComponents(
    msg: ParsedMessage,
    context: ScoringContext,
    now: number,
    index: number,
    totalMessages: number
  ): RelevanceComponents {
    return {
      recency: this.computeRecency(msg, now, index, totalMessages),
      frequency: this.computeFrequency(msg),
      semantic: this.computeSemantic(msg, context),
      attention: this.computeAttention(msg),
      expert: this.computeExpert(msg),
    };
  }

  private computeRecency(msg: ParsedMessage, now: number, index: number, total: number): number {
    // Use timestamp if available, otherwise position-based
    if (msg.parsed.timestamp) {
      const ageMs = now - msg.parsed.timestamp;
      const halfLifeMs = 5 * 60 * 1000; // 5 min half-life
      return Math.max(0, Math.min(1, Math.pow(0.5, ageMs / halfLifeMs)));
    }
    // Position-based fallback (newer = higher score)
    return (index + 1) / total;
  }

  private computeFrequency(msg: ParsedMessage): number {
    const accessCount = msg.accessCount || 1;
    return Math.min(1, Math.log10(accessCount + 1) / 2);
  }

  private computeSemantic(msg: ParsedMessage, context: ScoringContext): number {
    let score = 0.5;

    // Boost for matching file paths
    if (msg.parsed.type === 'file-history-snapshot' && msg.parsed.files) {
      const fileMatches = msg.parsed.files.filter(f =>
        context.activeFiles.some(af => af.includes(f) || f.includes(af))
      ).length;
      score += Math.min(0.3, fileMatches * 0.1);
    }

    // Boost for current query match (keyword overlap)
    if (context.currentQuery) {
      const queryWords = new Set(context.currentQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const msgContent = this.extractContent(msg);
      const msgWords = new Set(msgContent.toLowerCase().split(/\s+/).filter(w => w.length > 2));

      let overlap = 0;
      for (const word of queryWords) {
        if (msgWords.has(word)) overlap++;
      }
      const jaccard = queryWords.size > 0 ? overlap / queryWords.size : 0;
      score += jaccard * 0.2;
    }

    return Math.min(1, score);
  }

  private computeAttention(msg: ParsedMessage): number {
    // Type-based attention weights
    const typeWeights: Record<MessageType, number> = {
      'summary': 0.95,           // Critical for context recovery
      'system': 0.85,            // Configuration context
      'user': 0.7,               // User intent
      'assistant': 0.6,          // Responses
      'file-history-snapshot': 0.5, // File context
      'queue-operation': 0.3,    // Less important
      'unknown': 0.4,
    };
    return typeWeights[msg.parsed.type] || 0.5;
  }

  private computeExpert(msg: ParsedMessage): number {
    // Map types to expert domains
    const expertWeights: Record<MessageType, number> = {
      'summary': 0.9,
      'system': 0.85,
      'user': 0.75,
      'assistant': 0.7,
      'file-history-snapshot': 0.6,
      'queue-operation': 0.4,
      'unknown': 0.5,
    };
    return expertWeights[msg.parsed.type] || 0.5;
  }

  private computeOverallScore(components: RelevanceComponents): number {
    const weights = {
      recency: 0.25,
      frequency: 0.10,
      semantic: 0.25,
      attention: 0.30,
      expert: 0.10,
    };
    return Math.min(1, Math.max(0,
      components.recency * weights.recency +
      components.frequency * weights.frequency +
      components.semantic * weights.semantic +
      components.attention * weights.attention +
      components.expert * weights.expert
    ));
  }

  private computeConfidence(msg: ParsedMessage, components: RelevanceComponents): number {
    let confidence = 0.5;
    if (msg.parsed.timestamp) confidence += 0.2;
    if (msg.parsed.uuid) confidence += 0.1;
    if (components.semantic > 0.6) confidence += 0.1;
    if (components.attention > 0.7) confidence += 0.1;
    return Math.min(1, confidence);
  }

  private extractContent(msg: ParsedMessage): string {
    const content = msg.parsed.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(c => c.text || '').join(' ');
    }
    if (msg.parsed.summary) return msg.parsed.summary;
    return msg.line.slice(0, 500);
  }
}

// ============================================================================
// Temporal Compressor (adapted for JSONL messages)
// ============================================================================

class TemporalCompressor {
  private config: AdvancedOptimizerConfig;

  constructor(config: AdvancedOptimizerConfig) {
    this.config = config;
  }

  determineTier(msg: ParsedMessage, now: number): TemporalTier {
    const timestamp = msg.parsed.timestamp || now;
    const age = now - timestamp;

    // Recently accessed messages stay hot
    if (msg.lastAccessed && (now - msg.lastAccessed) < this.config.temporal.hotMaxAgeMs) {
      return 'hot';
    }

    if (age < this.config.temporal.hotMaxAgeMs) return 'hot';
    if (age < this.config.temporal.warmMaxAgeMs) return 'warm';
    return 'cold';
  }

  getCompressionRatio(tier: TemporalTier): number {
    switch (tier) {
      case 'hot': return 1.0;      // No compression
      case 'warm': return 0.7;     // 30% compression
      case 'cold': return 0.3;     // 70% compression
      case 'archived': return 0.1; // 90% compression
      default: return 1.0;
    }
  }

  compressMessage(msg: ParsedMessage, tier: TemporalTier): string {
    if (tier === 'hot') return msg.line;

    const ratio = this.getCompressionRatio(tier);
    const targetChars = Math.floor(msg.line.length * ratio);

    if (targetChars >= msg.line.length) return msg.line;

    // For summaries, never compress
    if (msg.parsed.type === 'summary') return msg.line;

    // Compress based on type
    try {
      const parsed = { ...msg.parsed };

      if (parsed.message?.content) {
        if (typeof parsed.message.content === 'string') {
          parsed.message.content = this.truncateWithEllipsis(parsed.message.content, targetChars - 100);
        } else if (Array.isArray(parsed.message.content)) {
          parsed.message.content = parsed.message.content.map(c => ({
            ...c,
            text: c.text ? this.truncateWithEllipsis(c.text, Math.floor(targetChars / parsed.message!.content!.length)) : c.text,
          }));
        }
      }

      return JSON.stringify(parsed);
    } catch {
      // Fallback: simple truncation
      return msg.line.slice(0, targetChars) + '"}';
    }
  }

  private truncateWithEllipsis(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  calculateDecayMultiplier(tier: TemporalTier): number {
    switch (tier) {
      case 'hot': return 1.0;
      case 'warm': return 1.0 - this.config.temporal.decayRate;
      case 'cold': return 1.0 - (this.config.temporal.decayRate * 2);
      case 'archived': return 1.0 - (this.config.temporal.decayRate * 3);
      default: return 1.0;
    }
  }
}

// ============================================================================
// Simplified GNN for relationship scoring (lightweight version)
// ============================================================================

interface MessageNode {
  index: number;
  type: MessageType;
  features: number[];
}

interface MessageEdge {
  source: number;
  target: number;
  weight: number;
  type: 'sequential' | 'same_type' | 'same_session';
}

class LightweightGNN {
  private nodes: Map<number, MessageNode> = new Map();
  private edges: MessageEdge[] = [];
  private config: AdvancedOptimizerConfig;

  constructor(config: AdvancedOptimizerConfig) {
    this.config = config;
  }

  buildGraph(messages: ParsedMessage[]): void {
    this.nodes.clear();
    this.edges = [];

    // Create nodes
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      this.nodes.set(i, {
        index: i,
        type: msg.parsed.type,
        features: this.extractFeatures(msg, i, messages.length),
      });
    }

    // Create edges
    for (let i = 1; i < messages.length; i++) {
      // Sequential edges
      this.edges.push({
        source: i - 1,
        target: i,
        weight: 0.5,
        type: 'sequential',
      });

      // Same-type edges (within window)
      for (let j = Math.max(0, i - 10); j < i; j++) {
        if (messages[i].parsed.type === messages[j].parsed.type) {
          this.edges.push({
            source: j,
            target: i,
            weight: 0.3,
            type: 'same_type',
          });
        }
      }
    }
  }

  private extractFeatures(msg: ParsedMessage, index: number, total: number): number[] {
    const typeIndex = this.typeToIndex(msg.parsed.type);
    const position = index / total;
    const normalized_tokens = Math.min(msg.tokens / 5000, 1);

    // One-hot type (7 types) + position + token ratio
    const features: number[] = [];
    for (let i = 0; i < 7; i++) {
      features.push(i === typeIndex ? 1 : 0);
    }
    features.push(position);
    features.push(normalized_tokens);

    return features;
  }

  private typeToIndex(type: MessageType): number {
    const types: MessageType[] = ['user', 'assistant', 'summary', 'system', 'file-history-snapshot', 'queue-operation', 'unknown'];
    return types.indexOf(type);
  }

  computeImportance(): Map<number, number> {
    const importance = new Map<number, number>();

    // Initialize with uniform importance
    for (const [idx] of this.nodes) {
      importance.set(idx, 1.0);
    }

    // Simple PageRank-like iteration
    const damping = 0.85;
    const iterations = 3;

    for (let iter = 0; iter < iterations; iter++) {
      const newImportance = new Map<number, number>();

      for (const [idx, node] of this.nodes) {
        // Base importance from type
        let base = this.typeToIndex(node.type) === 2 ? 0.9 : 0.5; // Boost summaries

        // Aggregate from neighbors
        let neighborSum = 0;
        let neighborCount = 0;

        for (const edge of this.edges) {
          if (edge.target === idx) {
            const sourceImportance = importance.get(edge.source) || 0;
            neighborSum += sourceImportance * edge.weight;
            neighborCount++;
          }
        }

        const neighborContrib = neighborCount > 0 ? neighborSum / neighborCount : 0;
        newImportance.set(idx, (1 - damping) * base + damping * neighborContrib);
      }

      // Update importance
      for (const [idx, val] of newImportance) {
        importance.set(idx, val);
      }
    }

    // Normalize to [0, 1]
    let maxImportance = 0;
    for (const val of importance.values()) {
      maxImportance = Math.max(maxImportance, val);
    }
    if (maxImportance > 0) {
      for (const [idx, val] of importance) {
        importance.set(idx, val / maxImportance);
      }
    }

    return importance;
  }

  getClusterCount(): number {
    // Simple clustering: count distinct types as proxy for clusters
    const types = new Set<MessageType>();
    for (const node of this.nodes.values()) {
      types.add(node.type);
    }
    return types.size;
  }
}

// ============================================================================
// Advanced Optimizer (main class)
// ============================================================================

export class AdvancedOptimizer {
  private config: AdvancedOptimizerConfig;
  private flashAttention: FlashAttentionScorer;
  private temporalCompressor: TemporalCompressor;
  private gnn: LightweightGNN;

  constructor(config: Partial<AdvancedOptimizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.flashAttention = new FlashAttentionScorer(this.config);
    this.temporalCompressor = new TemporalCompressor(this.config);
    this.gnn = new LightweightGNN(this.config);
  }

  /**
   * Optimize messages using all three intelligence systems
   *
   * CRITICAL: Maintains tool_use/tool_result pairs to avoid API errors.
   * The Anthropic API requires that every tool_result references a tool_use
   * in the immediately preceding assistant message.
   */
  async optimize(
    messages: Array<{ line: string; parsed: unknown }>,
    context?: Partial<ScoringContext>
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    const now = context?.timestamp || Date.now();

    // Convert to ParsedMessage format
    const parsedMessages: ParsedMessage[] = messages.map(m => ({
      line: m.line,
      parsed: m.parsed as ParsedMessage['parsed'],
      tokens: Math.ceil(m.line.length / 4), // Approximate token count
    }));

    // CRITICAL: Build tool_use -> tool_result pair mappings
    // Tool pairs must be kept or removed together to maintain API validity
    const toolUsePairs = this.buildToolUsePairs(parsedMessages);

    const originalTokens = parsedMessages.reduce((sum, m) => sum + m.tokens, 0);
    const originalCount = parsedMessages.length;

    // Calculate total size
    const totalSize = parsedMessages.reduce((sum, m) => sum + m.line.length, 0);

    // If under target, return as-is
    if (totalSize < this.config.targetSizeBytes) {
      return {
        optimizedLines: parsedMessages.map(m => m.line),
        metrics: {
          originalCount,
          optimizedCount: originalCount,
          originalTokens,
          optimizedTokens: originalTokens,
          reductionPercent: 0,
          tiersDistribution: { hot: originalCount, warm: 0, cold: 0, archived: 0 },
          gnnClusters: 1,
          averageRelevance: 1,
          processingTimeMs: Date.now() - startTime,
        },
      };
    }

    // Build scoring context
    const scoringContext: ScoringContext = {
      timestamp: now,
      activeFiles: context?.activeFiles || [],
      activeTools: context?.activeTools || [],
      sessionId: context?.sessionId || 'default',
      taskId: context?.taskId,
      currentQuery: context?.currentQuery,
    };

    // Step 1: Flash Attention scoring
    const relevanceScores = this.flashAttention.scoreMessages(parsedMessages, scoringContext);

    // Apply scores to messages
    for (const [idx, score] of relevanceScores) {
      parsedMessages[idx].relevanceScore = score;
    }

    // Step 2: Temporal tier assignment
    const tierDistribution: Record<TemporalTier, number> = { hot: 0, warm: 0, cold: 0, archived: 0 };
    for (const msg of parsedMessages) {
      msg.tier = this.temporalCompressor.determineTier(msg, now);
      tierDistribution[msg.tier]++;
    }

    // Step 3: GNN relationship analysis
    this.gnn.buildGraph(parsedMessages);
    const gnnImportance = this.gnn.computeImportance();

    // Combine scores: Flash Attention * Temporal Decay * GNN Importance
    const combinedScores: Array<{ index: number; score: number; msg: ParsedMessage }> = [];
    for (let i = 0; i < parsedMessages.length; i++) {
      const msg = parsedMessages[i];
      const flashScore = msg.relevanceScore?.overall || 0.5;
      const temporalMultiplier = this.temporalCompressor.calculateDecayMultiplier(msg.tier!);
      const gnnScore = gnnImportance.get(i) || 0.5;

      // Weighted combination
      const combinedScore = flashScore * 0.5 + temporalMultiplier * 0.2 + gnnScore * 0.3;

      combinedScores.push({ index: i, score: combinedScore, msg });
    }

    // Step 4: Select messages within budget
    // CRITICAL: Respect tool_use/tool_result pairs to avoid API errors
    // Always keep summaries and system messages
    const mustKeepIndices = new Set<number>();
    const candidates: typeof combinedScores = [];

    for (const item of combinedScores) {
      if (item.msg.parsed.type === 'summary') {
        mustKeepIndices.add(item.index);
      } else if (item.msg.parsed.type === 'system') {
        mustKeepIndices.add(item.index);
      } else {
        candidates.push(item);
      }
    }

    // Sort by combined score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    // Track which indices we're keeping
    const keepIndices = new Set<number>(mustKeepIndices);

    // Add recent messages (always keep last N) WITH their tool pairs
    const recentCandidates = candidates
      .filter(c => c.msg.parsed.type === 'user' || c.msg.parsed.type === 'assistant')
      .slice(-this.config.keepRecentMessages);

    for (const item of recentCandidates) {
      keepIndices.add(item.index);
      // If this message is part of a tool pair, keep the pair
      if (toolUsePairs.toolUseToResult.has(item.index)) {
        keepIndices.add(toolUsePairs.toolUseToResult.get(item.index)!);
      }
      if (toolUsePairs.resultToToolUse.has(item.index)) {
        keepIndices.add(toolUsePairs.resultToToolUse.get(item.index)!);
      }
    }

    // Fill remaining budget with high-scoring messages, respecting pairs
    const addedFromCandidates = new Set<number>();
    for (const item of candidates) {
      if (keepIndices.has(item.index)) continue;
      if (addedFromCandidates.has(item.index)) continue;

      // Calculate size needed (including pair if applicable)
      let sizeNeeded = item.msg.line.length;
      let pairIndex: number | undefined;

      if (toolUsePairs.toolUseToResult.has(item.index)) {
        pairIndex = toolUsePairs.toolUseToResult.get(item.index);
        if (pairIndex !== undefined && !keepIndices.has(pairIndex)) {
          sizeNeeded += parsedMessages[pairIndex].line.length;
        }
      } else if (toolUsePairs.resultToToolUse.has(item.index)) {
        pairIndex = toolUsePairs.resultToToolUse.get(item.index);
        if (pairIndex !== undefined && !keepIndices.has(pairIndex)) {
          sizeNeeded += parsedMessages[pairIndex].line.length;
        }
      }

      // Check if we can add this (and its pair)
      const currentSize = [...keepIndices].reduce((sum, i) => sum + parsedMessages[i].line.length, 0);
      if (currentSize + sizeNeeded < this.config.targetSizeBytes) {
        keepIndices.add(item.index);
        addedFromCandidates.add(item.index);
        if (pairIndex !== undefined) {
          keepIndices.add(pairIndex);
          addedFromCandidates.add(pairIndex);
        }
      } else if (!toolUsePairs.pairedIndices.has(item.index)) {
        // Only break early for non-paired messages (paired ones may have smaller partners)
        break;
      }
    }

    // Build final output maintaining original order
    const optimizedMessages: ParsedMessage[] = [];
    for (let i = 0; i < parsedMessages.length; i++) {
      if (keepIndices.has(i)) {
        const msg = parsedMessages[i];
        const tier = msg.tier || 'hot';
        const compressedLine = this.temporalCompressor.compressMessage(msg, tier);
        optimizedMessages.push({ ...msg, line: compressedLine });
      }
    }

    // Calculate final metrics
    const optimizedTokens = optimizedMessages.reduce((sum, m) => sum + Math.ceil(m.line.length / 4), 0);
    const avgRelevance = optimizedMessages.reduce((sum, m) => sum + (m.relevanceScore?.overall || 0.5), 0) / optimizedMessages.length;

    return {
      optimizedLines: optimizedMessages.map(m => m.line),
      metrics: {
        originalCount,
        optimizedCount: optimizedMessages.length,
        originalTokens,
        optimizedTokens,
        reductionPercent: ((originalTokens - optimizedTokens) / originalTokens) * 100,
        tiersDistribution: tierDistribution,
        gnnClusters: this.gnn.getClusterCount(),
        averageRelevance: avgRelevance,
        processingTimeMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Build mappings of tool_use -> tool_result pairs
   *
   * Returns a Map where:
   * - Key: index of message containing tool_use
   * - Value: index of message containing corresponding tool_result
   *
   * Also returns reverse mapping and set of indices that are part of pairs.
   */
  private buildToolUsePairs(messages: ParsedMessage[]): {
    toolUseToResult: Map<number, number>;
    resultToToolUse: Map<number, number>;
    pairedIndices: Set<number>;
  } {
    const toolUseToResult = new Map<number, number>();
    const resultToToolUse = new Map<number, number>();
    const pairedIndices = new Set<number>();

    // Extract tool_use_ids from assistant messages
    const toolUseIdToIndex = new Map<string, number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const parsed = msg.parsed as Record<string, unknown>;

      // Check for assistant messages with tool_use in content
      if (parsed.message && typeof parsed.message === 'object') {
        const message = parsed.message as { role?: string; content?: unknown };
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
              const toolUseBlock = block as { id?: string };
              if (toolUseBlock.id) {
                toolUseIdToIndex.set(toolUseBlock.id, i);
              }
            }
          }
        }
      }
    }

    // Find corresponding tool_result messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const parsed = msg.parsed as Record<string, unknown>;

      // Check for user messages with tool_result in content
      if (parsed.message && typeof parsed.message === 'object') {
        const message = parsed.message as { role?: string; content?: unknown };
        if (message.role === 'user' && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
              const toolResultBlock = block as { tool_use_id?: string };
              if (toolResultBlock.tool_use_id) {
                const toolUseIndex = toolUseIdToIndex.get(toolResultBlock.tool_use_id);
                if (toolUseIndex !== undefined) {
                  toolUseToResult.set(toolUseIndex, i);
                  resultToToolUse.set(i, toolUseIndex);
                  pairedIndices.add(toolUseIndex);
                  pairedIndices.add(i);
                }
              }
            }
          }
        }
      }

      // Also check for toolUseResult field (Claude Code format)
      if (parsed.toolUseResult) {
        // Find the preceding assistant message that should have the tool_use
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j].parsed as Record<string, unknown>;
          if (prevMsg.message && typeof prevMsg.message === 'object') {
            const prevMessage = prevMsg.message as { role?: string };
            if (prevMessage.role === 'assistant') {
              toolUseToResult.set(j, i);
              resultToToolUse.set(i, j);
              pairedIndices.add(j);
              pairedIndices.add(i);
              break;
            }
          }
        }
      }
    }

    return { toolUseToResult, resultToToolUse, pairedIndices };
  }

  /**
   * Check if a message can be independently removed (not part of a tool pair)
   */
  private canRemoveIndependently(index: number, pairedIndices: Set<number>): boolean {
    return !pairedIndices.has(index);
  }

  /**
   * Get configuration
   */
  getConfig(): AdvancedOptimizerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AdvancedOptimizerConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Factory function
export function createAdvancedOptimizer(config?: Partial<AdvancedOptimizerConfig>): AdvancedOptimizer {
  return new AdvancedOptimizer(config);
}

// Export for testing
export { FlashAttentionScorer, TemporalCompressor, LightweightGNN };
