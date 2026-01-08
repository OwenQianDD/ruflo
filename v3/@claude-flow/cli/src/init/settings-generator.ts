/**
 * Settings.json Generator
 * Creates .claude/settings.json with V3-optimized hook configurations
 */

import type { InitOptions, HooksConfig } from './types.js';

/**
 * Generate the complete settings.json content
 */
export function generateSettings(options: InitOptions): object {
  const settings: Record<string, unknown> = {};

  // Add hooks if enabled
  if (options.components.settings) {
    settings.hooks = generateHooksConfig(options.hooks);
  }

  // Add statusLine configuration if enabled
  if (options.statusline.enabled) {
    settings.statusLine = generateStatusLineConfig(options);
  }

  // Add permissions
  settings.permissions = {
    // Auto-allow claude-flow MCP tools
    allow: [
      'Bash(npx claude-flow*)',
      'Bash(npx @claude-flow/*)',
      'mcp__claude-flow__*',
    ],
    // Auto-deny dangerous operations
    deny: [],
  };

  // Note: Claude Code expects 'model' to be a string, not an object
  // Model preferences are stored in claudeFlow settings instead
  // settings.model = 'claude-sonnet-4-20250514'; // Uncomment if you want to set a default model

  // Add V3-specific settings
  settings.claudeFlow = {
    version: '3.0.0',
    enabled: true,
    modelPreferences: {
      default: 'claude-opus-4-5-20251101',
      routing: 'claude-opus-4-5-20251101',
    },
    swarm: {
      topology: options.runtime.topology,
      maxAgents: options.runtime.maxAgents,
    },
    memory: {
      backend: options.runtime.memoryBackend,
      enableHNSW: options.runtime.enableHNSW,
    },
    neural: {
      enabled: options.runtime.enableNeural,
    },
    daemon: {
      autoStart: true,
      workers: ['map', 'audit', 'optimize', 'consolidate', 'testgaps'],
    },
  };

  return settings;
}

/**
 * Generate statusLine configuration for Claude Code
 * This configures the Claude Code status bar to show V3 metrics
 */
function generateStatusLineConfig(options: InitOptions): object {
  const config = options.statusline;

  // Build the command that generates the statusline
  const statuslineCommand = 'npx @claude-flow/hooks statusline 2>/dev/null || node .claude/helpers/statusline.js 2>/dev/null || echo "▊ V3"';

  return {
    // Type must be "command" for Claude Code validation
    type: 'command',
    // Command to execute for statusline content
    command: statuslineCommand,
    // Refresh interval in milliseconds (5 seconds default)
    refreshMs: config.refreshInterval,
    // Enable the statusline
    enabled: config.enabled,
  };
}

/**
 * Generate hooks configuration
 */
function generateHooksConfig(config: HooksConfig): object {
  const hooks: Record<string, unknown[]> = {};

  // PreToolUse hooks - cross-platform via npx
  if (config.preToolUse) {
    hooks.PreToolUse = [
      // File edit hooks with intelligence routing
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks pre-edit --file "$TOOL_INPUT_file_path" --intelligence',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Bash command hooks with safety validation
      {
        matcher: '^Bash$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks pre-command --command "$TOOL_INPUT_command" --validate-safety',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Task/Agent hooks
      {
        matcher: '^Task$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks pre-task --description "$TOOL_INPUT_prompt"',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Search hooks for pattern caching
      {
        matcher: '^(Grep|Glob|Read)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks pre-search --pattern "$TOOL_INPUT_pattern"',
            timeout: 2000,
            continueOnError: config.continueOnError,
          },
        ],
      },
    ];
  }

  // PostToolUse hooks - cross-platform via npx
  if (config.postToolUse) {
    hooks.PostToolUse = [
      // File edit hooks with neural pattern training
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks post-edit --file "$TOOL_INPUT_file_path" --success "$TOOL_SUCCESS" --train-patterns',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Bash command hooks with metrics and exit code tracking
      {
        matcher: '^Bash$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks post-command --command "$TOOL_INPUT_command" --success "$TOOL_SUCCESS" --exit-code "$TOOL_EXIT_CODE" --track-metrics',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Task completion hooks with analysis
      {
        matcher: '^Task$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks post-task --agent-id "$TOOL_RESULT_agent_id" --success "$TOOL_SUCCESS" --analyze',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Search result caching for HNSW optimization
      {
        matcher: '^(Grep|Glob)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks post-search --cache-results',
            timeout: 2000,
            continueOnError: config.continueOnError,
          },
        ],
      },
    ];
  }

  // UserPromptSubmit for intelligent routing
  if (config.userPromptSubmit) {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks route --task "$PROMPT" --intelligence --include-explanation',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
    ];
  }

  // SessionStart for context loading and daemon auto-start
  if (config.sessionStart) {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest daemon start --quiet',
            timeout: 5000,
            continueOnError: true,
          },
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks session-start --session-id "$SESSION_ID" --load-context',
            timeout: 10000,
            continueOnError: true,
          },
        ],
      },
    ];
  }

  // Stop hooks for task evaluation
  if (config.stop) {
    hooks.Stop = [
      {
        hooks: [
          {
            type: 'prompt',
            prompt: `Evaluate ONLY for hard failures. Return {"ok": true} UNLESS any of these occurred:
- Tool returned an error (non-zero exit, exception thrown)
- Assistant said it cannot/failed to complete the request
- Request was blocked or denied

DO NOT fail for: suggestions, warnings, discovered issues, code review findings, TODOs, or recommendations. These are informational outputs, not failures.

Default to {"ok": true} when uncertain.`,
          },
        ],
      },
    ];
  }

  // Notification hooks - store notifications in memory for swarm awareness
  if (config.notification) {
    hooks.Notification = [
      {
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli@latest hooks notify --message "$NOTIFICATION_MESSAGE" --swarm-status',
            timeout: 3000,
            continueOnError: true,
          },
        ],
      },
    ];
  }

  // PermissionRequest for auto-allowing claude-flow tools
  if (config.permissionRequest) {
    hooks.PermissionRequest = [
      {
        matcher: '^mcp__claude-flow__.*$',
        hooks: [
          {
            type: 'command',
            command: 'echo \'{"decision": "allow", "reason": "claude-flow MCP tool auto-approved"}\'',
            timeout: 1000,
          },
        ],
      },
      {
        matcher: '^Bash\\(npx @?claude-flow.*\\)$',
        hooks: [
          {
            type: 'command',
            command: 'echo \'{"decision": "allow", "reason": "claude-flow CLI auto-approved"}\'',
            timeout: 1000,
          },
        ],
      },
    ];
  }

  return hooks;
}

/**
 * Generate settings.json as formatted string
 */
export function generateSettingsJson(options: InitOptions): string {
  const settings = generateSettings(options);
  return JSON.stringify(settings, null, 2);
}
