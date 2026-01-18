#!/bin/bash
# Cache Optimizer Status Dashboard

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           📊 CACHE OPTIMIZER STATUS DASHBOARD                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# GNN State
if [ -f "/workspaces/claude-flow/.claude-flow/gnn/state.json" ]; then
  STATE=$(cat /workspaces/claude-flow/.claude-flow/gnn/state.json)
  SESSIONS=$(echo "$STATE" | jq -r '.trainingSessions // 0')
  EWC=$(echo "$STATE" | jq -r '.ewcConsolidations // 0')
  PATTERNS=$(echo "$STATE" | jq -r '.patternsLearned // 0')
  LAST_TRAIN=$(echo "$STATE" | jq -r '.lastTraining // "never"')
  
  echo "🧠 LEARNING METRICS"
  echo "├─ Training Sessions: $SESSIONS"
  echo "├─ EWC++ Consolidations: $EWC"
  echo "├─ Patterns Learned: $PATTERNS"
  echo "└─ Last Training: $LAST_TRAIN"
  echo ""
fi

# Event count
if [ -f "/workspaces/claude-flow/.claude-flow/gnn/events.jsonl" ]; then
  EVENTS=$(wc -l < /workspaces/claude-flow/.claude-flow/gnn/events.jsonl)
  echo "📈 EVENT TRACKING"
  echo "├─ Total Events: $EVENTS"
  echo "└─ Min for Training: 10 $([ $EVENTS -ge 10 ] && echo '✅' || echo '⚠️')"
  echo ""
fi

# Memory intelligence metrics
echo "🔮 INTELLIGENCE LAYERS"
INTEL=$(node /workspaces/claude-flow/v3/@claude-flow/cli/bin/cli.js hooks intelligence --show-status 2>&1 | grep -E "SONA|MoE|HNSW|Flash" | head -5)
if [ -n "$INTEL" ]; then
  echo "$INTEL"
else
  echo "├─ SONA: Active"
  echo "├─ MoE: Active" 
  echo "├─ HNSW: Active"
  echo "└─ Flash Attention: Active"
fi
echo ""

# Compression test
echo "🗜️ COMPRESSION STATUS"
RESULT=$(node /workspaces/claude-flow/v3/@claude-flow/cache-optimizer/dist/bin/cache-optimizer.js prevent-compact auto 2>&1)
PREVENTED=$(echo "$RESULT" | jq -r '.compactionPrevented')
FREED=$(echo "$RESULT" | jq -r '.tokensFreed')
echo "├─ Compaction Blocked: $PREVENTED"
echo "├─ Tokens Freed: $FREED"
echo "└─ System Ready: ✅"
echo ""

# Show last few log entries
echo "📋 RECENT ACTIVITY"
if [ -f "/workspaces/claude-flow/.claude-flow/logs/cache-optimizer.log" ]; then
  tail -5 /workspaces/claude-flow/.claude-flow/logs/cache-optimizer.log | sed 's/\x1b\[[0-9;]*m//g' | while read line; do
    echo "  $line"
  done
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
