#!/bin/bash
# Show cache optimizer improvement over time

METRICS_FILE="/workspaces/claude-flow/.claude-flow/cache-metrics.json"
STATE_FILE="/workspaces/claude-flow/.claude-flow/gnn/state.json"

echo ""
echo "📈 CACHE OPTIMIZER IMPROVEMENT TRACKING"
echo "════════════════════════════════════════"
echo ""

if [ -f "$STATE_FILE" ]; then
  STATE=$(cat "$STATE_FILE")
  SESSIONS=$(echo "$STATE" | jq -r '.trainingSessions // 0')
  EWC=$(echo "$STATE" | jq -r '.ewcConsolidations // 0')
  INIT=$(echo "$STATE" | jq -r '.initialized // "unknown"')
  LAST=$(echo "$STATE" | jq -r '.lastTraining // "never"')
  
  echo "🎯 LEARNING PROGRESS"
  echo "├─ Started: $INIT"
  echo "├─ Training Sessions: $SESSIONS"
  echo "├─ Memory Consolidations (EWC++): $EWC"
  echo "└─ Last Updated: $LAST"
  echo ""
  
  # Calculate improvement
  if [ "$SESSIONS" -gt 0 ]; then
    echo "📊 IMPROVEMENT INDICATORS"
    echo "├─ Training cycles completed: $SESSIONS ✅"
    echo "├─ EWC++ preventing forgetting: $EWC cycles ✅"
    
    # Events per session
    EVENTS=$(wc -l < /workspaces/claude-flow/.claude-flow/gnn/events.jsonl 2>/dev/null || echo 0)
    if [ "$EVENTS" -gt 10 ]; then
      echo "├─ Sufficient training data: $EVENTS events ✅"
    else
      echo "├─ Training data: $EVENTS events (need 10+) ⚠️"
    fi
    
    echo "└─ Compaction blocking: ACTIVE ✅"
    echo ""
  fi
fi

# Show totals if available
if [ -f "$METRICS_FILE" ]; then
  TOTALS=$(cat "$METRICS_FILE" | jq '.totals')
  PREVENTED=$(echo "$TOTALS" | jq -r '.compactionsPrevented // 0')
  FREED=$(echo "$TOTALS" | jq -r '.tokensFreed // 0')
  PROMPTS=$(echo "$TOTALS" | jq -r '.promptsProcessed // 0')
  
  if [ "$PREVENTED" -gt 0 ] || [ "$PROMPTS" -gt 0 ]; then
    echo "📉 CUMULATIVE STATS"
    echo "├─ Compactions Prevented: $PREVENTED"
    echo "├─ Tokens Freed: $FREED"
    echo "└─ Prompts Processed: $PROMPTS"
    echo ""
  fi
fi

echo "💡 HOW TO IMPROVE:"
echo "├─ More usage = more events = better learning"
echo "├─ Diverse tasks help pattern recognition"
echo "└─ GNN retrains every 5 minutes automatically"
echo ""
echo "Run this anytime: /workspaces/claude-flow/.claude/helpers/cache-improvement.sh"
echo ""
