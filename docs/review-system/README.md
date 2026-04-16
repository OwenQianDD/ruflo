# Review System

This repository includes a local multi-agent review workflow backed by the Ruflo CLI.

The canonical entrypoints are:

- [`scripts/review-pr.sh`](../../scripts/review-pr.sh)
- `ruflo review ...` via the local CLI at `v3/@claude-flow/cli/bin/cli.js`

## Use the local CLI

Use the local development CLI instead of a globally installed package:

```bash
alias ruflo-dev="node ~/Projects/ruflo/v3/@claude-flow/cli/bin/cli.js"
```

## Prerequisites

- `gh` must be installed and authenticated. The review command fetches PR metadata and diff via `gh pr view` and `gh pr diff`.
- `claude` should be installed if you want the post-review chat flow.
- `codex` should be installed if you want dual-model review. If it is missing, the system falls back to Claude-only mode.
- The target repository must exist locally at `~/Projects/<repo>` by default. Override that root with `RUFLO_PROJECTS_DIR`.

## Start a review

Wrapper script:

```bash
./scripts/review-pr.sh https://github.com/OwenQianDD/ruflo/pull/1
```

Wrapper script with shorthand and debug logging:

```bash
./scripts/review-pr.sh -v OwenQianDD/ruflo#1
```

Direct CLI:

```bash
ruflo-dev review init --url https://github.com/OwenQianDD/ruflo/pull/1
```

Markdown design docs from a PR:

```bash
ruflo-dev review init --source pr-markdown --url https://github.com/OwenQianDD/ruflo/pull/1
```

Local design doc file:

```bash
ruflo-dev review init --source local-file --input ./docs/design.md
```

Slack thread export:

```bash
ruflo-dev review init --source slack --input ./tmp/design-thread.json
```

Custom review prompt:

```bash
ruflo-dev review init --source local-file --input ./docs/design.md \
  --review-prompt "Focus on rollout safety, observability, and unresolved assumptions."
```

Fast Codex-only review:

```bash
ruflo-dev review init --url https://github.com/OwenQianDD/ruflo/pull/1 --fast
```

Equivalent direct CLI using explicit fields:

```bash
ruflo-dev review init --owner OwenQianDD --repo ruflo --pr 1
```

## Useful flags

- `--fast`: run the three review agents on Codex only and skip debate plus queen reconciliation
- `--source <pr|pr-markdown|local-file|slack>`: choose how review content is fetched
- `--input <value>`: source-specific input for design-doc reviews
- `--review-prompt <text>`: add custom review instructions to all specialist agents and the coordinator
- `--claude-only`: skip Codex agents
- `--skip-worktree`: diff-only mode, no isolated worktree
- `--skip-debate`: skip the disagreement debate loop
- `--force`: create a fresh review even if one already exists
- `--no-chat`: do not drop into interactive chat when the review completes
- `-v, --verbose`: print more detail while agents run
- `--log-file <path>`: write logs to a custom path

The wrapper also maps these environment variables to CLI flags automatically:

```bash
CLAUDE_MODEL
CODEX_MODEL
AGENT_BUDGET
RECONCILE_BUDGET
```

## What the review does

`review init` runs a staged pipeline:

1. Resolves the requested review source
2. Fetches review content through a common source adapter
3. Creates an isolated worktree when the source needs repository context
4. Dispatches specialist reviewers
5. Runs pair agreement when both Claude and Codex are available
6. Resolves disagreements through a debate loop
7. Produces a final reconciled report

When `--fast` is set, steps 5-7 are replaced with a direct algorithmic report compiled from the Codex agent findings.

The current specialist roles are:

- `security-auditor`
- `logic-checker`
- `integration-specialist`

## Where artifacts go

Two locations are used:

- Project-local review state: `.claude/reviews/<review-id>.json`
- Persisted artifacts: `~/.claude/reviews/<owner>-<repo>-<pr>-<timestamp>/`

Artifact directories contain:

- `report.md`: final compiled review
- `context.md`: full chat context for follow-up questions
- `out-*.txt`: raw agent outputs
- `review.json`: persisted review metadata

## Inspect an existing review

List reviews:

```bash
ruflo-dev review list
```

Check status:

```bash
ruflo-dev review status <review-id>
```

Print the final report:

```bash
ruflo-dev review report <review-id>
```

Start follow-up chat:

```bash
ruflo-dev review chat <review-id>
```

Chat against an explicit artifact directory:

```bash
ruflo-dev review chat --dir ~/.claude/reviews/<owner>-<repo>-<pr>-<timestamp>
```

The wrapper supports the same flow:

```bash
./scripts/review-pr.sh --chat <review-id>
./scripts/review-pr.sh --chat --dir ~/.claude/reviews/<owner>-<repo>-<pr>-<timestamp>
```

## Clean up old reviews

Preview cleanup:

```bash
ruflo-dev review cleanup --max-age 7 --dry-run
```

Remove old reviews:

```bash
ruflo-dev review cleanup --max-age 21
```

Wrapper form:

```bash
./scripts/review-pr.sh --cleanup --max-age 21
```
