#!/usr/bin/env bash
#
# review-pr.sh — Thin wrapper around `ruflo review`.
#
# All logic lives in TypeScript (ReviewService + ReviewDispatcher).
# This script maps legacy env vars to CLI flags for backward compatibility.
#
# Usage:
#   ./scripts/review-pr.sh https://github.com/org/repo/pull/123
#   ./scripts/review-pr.sh --chat <id>
#   ./scripts/review-pr.sh --chat --dir <path>
#   ./scripts/review-pr.sh -v org/repo#123
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_CLI="$REPO_ROOT/v3/@claude-flow/cli/bin/cli.js"

if [[ -n "${RUFLO_CMD:-}" ]]; then
  RUFLO="$RUFLO_CMD"
elif [[ -x "$LOCAL_CLI" ]]; then
  RUFLO="node $LOCAL_CLI"
else
  RUFLO="npx ruflo"
fi
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      shift
      exec $RUFLO review chat "$@"
      ;;
    --cleanup)
      shift
      exec $RUFLO review cleanup "$@"
      ;;
    -h|--help)
      echo "Usage: review-pr.sh [OPTIONS] <PR_URL_OR_SHORTHAND>"
      echo ""
      echo "Dual-model headless multi-agent PR review."
      echo "Delegates to: ruflo review init"
      echo ""
      echo "Options:"
      echo "  -v, --verbose       Debug logging"
      echo "  --log-file <path>   Custom log file"
      echo "  --claude-only       Skip Codex agents"
      echo "  --force             Force new review even if one exists"
      echo "  --no-chat           Skip interactive chat after review"
      echo "  --chat <id>         Interactive Q&A by review ID (or most recent)"
      echo "  --chat --dir <path> Interactive Q&A with explicit review directory"
      echo "  --cleanup [days]    Remove reviews older than N days (default: 21)"
      echo "  -h, --help          Show this help"
      echo ""
      echo "Environment (mapped to flags automatically):"
      echo "  CLAUDE_MODEL, CODEX_MODEL, AGENT_BUDGET, RECONCILE_BUDGET"
      exit 0
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

# Map env vars to CLI flags for backward compat
[[ -n "${CLAUDE_MODEL:-}" ]]     && ARGS+=(--claude-model "$CLAUDE_MODEL")
[[ -n "${CODEX_MODEL:-}" ]]      && ARGS+=(--codex-model "$CODEX_MODEL")
[[ -n "${AGENT_BUDGET:-}" ]]     && ARGS+=(--agent-budget "$AGENT_BUDGET")
[[ -n "${RECONCILE_BUDGET:-}" ]] && ARGS+=(--reconcile-budget "$RECONCILE_BUDGET")

exec $RUFLO review init "${ARGS[@]}"
