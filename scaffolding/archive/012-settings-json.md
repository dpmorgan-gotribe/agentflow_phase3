---
task-id: "012"
title: "settings.json with Hook Wiring"
status: complete
priority: P1
tier: 3 — Configuration & Context
depends-on: ["007", "008", "009"]
estimated-scope: small
---

# 012: settings.json with Hook Wiring

## What This Task Produces

`.claude/settings.json` that wires up all hooks and permission rules.

## Scope

### Hook Wiring

Wire the three hooks from Tasks 007-009:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/block-dangerous.sh"
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/enforce-boundaries.sh"
          }
        ]
      },
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/detect-loop.mjs" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$CLAUDE_TOOL_INPUT_FILE_PATH\" 2>/dev/null || true"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"additionalContext\": \"If resuming work, run /load-context-chain to reconstruct state.\"}'"
          }
        ]
      }
    ]
  }
}
```

### Permission Rules

```json
{
  "permissions": {
    "allow": ["Read(*)", "Grep(*)", "Glob(*)", "Bash(just *)"],
    "deny": ["Bash(rm *)", "Bash(curl * | *)", "Bash(wget *)"]
  }
}
```

### Note

PostToolUse formatting hooks (prettier, eslint) are wired but will only activate once those tools are installed (Task 026+).

## Acceptance Criteria

- [ ] `.claude/settings.json` exists with valid JSON
- [ ] All three PreToolUse hooks are wired
- [ ] PostToolUse prettier hook is wired
- [ ] SessionStart context reminder is wired
- [ ] Permission allow/deny rules are set
- [ ] Bash restricted to `just *` commands

## Human Verification

Review the permission model — is `Bash(just *)` restrictive enough? Should any additional tools be allowed/denied?
