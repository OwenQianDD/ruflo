/**
 * Claude Flow V3 Helper Utilities
 *
 * High-level utility functions for common operations.
 * These helpers can be generated into a project via `claude-flow init`.
 */

// Attention helpers
export {
  computeAttention,
  computeAttentionBatch,
  recommendMechanism,
  isWASMAvailable,
  getAttentionStatus,
  hyperbolicDistance,
  clearAttentionCache,
  type AttentionMechanismType,
  type AttentionConfig,
  type AttentionResult,
} from './attention-helper.js';
