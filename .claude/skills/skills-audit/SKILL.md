---
name: skills-audit
description: Audit project skills + MCP servers against what the architecture demands. Dual-scope: --scope=design (at /new-project time; confirms design-stage prompt packs + MCPs) or --scope=build (post-architect; confirms build-stage vendor skills + MCPs from architecture.yaml.tooling.skills.build + mcp_servers). Near-no-op when everything is already shipped; flags gaps in missingSkills[] for human follow-up OR auto-authors stubs with --auto-author-stack-skills.
when_to_use: --scope=design runs at /new-project step 5b (already ships factory skills); --scope=build runs post-architect / pre-builders in orchestrator Mode A stage 9
allowed-tools: Read Write Edit Bash Grep Glob WebSearch WebFetch
model: inherit
argument-hint: "--scope=design | --scope=build [--auto-author-stack-skills]"
---

# /skills-audit — dual-scope skill shelf auditor

Invoked twice per pipeline at different scopes (refactor-003). Reads the factory's skill shelf + the project's architecture.yaml (build scope only) + reports deltas.

## Arguments

- `--scope=<design | build>` (required). Missing → reject with `/skills-audit requires --scope=design OR --scope=build`.
- `--auto-author-stack-skills` (optional). When a stack skill is missing, trigger WebSearch+WebFetch research to author a stub. Default: flag-don't-author (cheaper + safer).

## Prerequisites

### `--scope=design`

- `mcp-defaults-design.json` at project root (factory-seeded by `/new-project`)
- `.claude/skills/` + `.claude/skills/agents/` directories exist

### `--scope=build`

- `.claude/architecture.yaml` exists (architect has run); abort otherwise with `architecture-yaml-missing; /architect has not run`
- `.claude/skills/agents/` shelf present

## Steps

### 1. Argument gate

Parse `--scope=` + optional `--auto-author-stack-skills`. Reject missing or invalid `--scope=`.

### 2. Read inputs per scope

**`--scope=design`**:

- Read `mcp-defaults-design.json` — extract expected design-stage server list (playwright, icons8, unsplash, chrome-devtools, optional image-generator behind `feature_flag: nanobanana`)
- List `.claude/skills/` — confirm shipped pipeline skills present (analyze, mockups, stylesheet, screens, visual-review, user-flows-generator, pick-style, scan-assets, draft-brief, new-project, validate-brief)
- List `.claude/skills/agents/` subdirectories — confirm 5 shipped stack skills present (back-end/node-trpc-nest, back-end/python-fastapi, front-end/react-next, front-end/svelte-kit, mobile/expo-rn)

**`--scope=build`**:

- Read `.claude/architecture.yaml`:
  - `tooling.stack.*` — for each non-null slot, check corresponding `.claude/skills/agents/{tier-dir}/{slug}/SKILL.md` exists
  - `tooling.skills.build[]` — for each slug, check `.claude/skills/{slug}/SKILL.md` OR treat as architecture annotation (vendor-specific, no dispatch path)
  - `tooling.mcp_servers[]` — collect any servers not already in `.mcp.json`

### 3. Compute gaps

Build `missingSkills[]` + `missingMcpServers[]` lists. Both default to empty.

For design scope: factory seeds everything; missing entries are a factory bug, not a project bug. Emit warning but flag as orchestrator-level (not user-fixable).

For build scope: architect's choices drive expected inputs. Missing stack skill is the architect picking an experimental slug that hasn't been authored yet. Vendor skills (stripe-connect, etc.) are often architectural annotations without a dispatch file — that's acceptable; they guide builders via architecture.yaml's integration_ref pattern, not via a loaded SKILL.md. Flag only TRUE stack-skill-missing cases (`tooling.stack.{tier}_framework` with no corresponding shelf entry).

### 4. Auto-author if flag set (rare)

If `--auto-author-stack-skills` AND `missingSkills[]` is non-empty:

- For each missing slug, spawn a sub-agent via Agent tool with WebSearch + WebFetch access
- Author a stub `.claude/skills/agents/{tier-dir}/{slug}/SKILL.md` with canonical sections
- Add to `authoredSkills[]` in output
- Emit warning for human to review the auto-authored skill before first builder invocation

Without the flag: leave `missingSkills[]` populated; orchestrator surfaces the warning + humans intervene.

### 5. Emit SkillsAuditOutput JSON

```json
{
  "success": true,
  "scope": "design" | "build",
  "missingSkills": [...],
  "missingMcpServers": [...],
  "authoredSkills": [],
  "shippedSkills": [...],
  "warnings": [...]
}
```

Orchestrator validates against its placeholder stage-output schema (accepts any `{ success: boolean }` shape until task-034b binds a proper per-stage schema). For now, `success: true` suffices.

## Error paths

- **Missing `--scope=`** → abort with usage message
- **Invalid `--scope=` value** → abort listing the 2 valid values
- **`--scope=build` without architecture.yaml** → abort (`/architect` hasn't run)
- **Stack skill missing + no `--auto-author-stack-skills` flag** → warning (not abort); orchestrator + humans handle
- **WebSearch/WebFetch budget exhausted during auto-author** → emit `auto-author-budget-exhausted`; leave partial skill; exit

## Integration Points

- **Task 035 orchestrator** invokes this skill at Mode A stages `skills-audit-design` + `skills-audit-build`
- **`.claude/agents/skills-agent.md`** — binding agent definition
- **Stack-skill shelf** at `.claude/skills/agents/{tier-dir}/{slug}/` — the on-disk source of truth for stack dispatch
- **`architecture.yaml.tooling.stack.*` + `tooling.skills.build[]` + `tooling.mcp_servers[]`** — build-scope inputs
- **`register-mcp-servers` skill** — consumes `missingMcpServers[]` output; separate skill to keep audit + registration decoupled

## Acceptance criteria

- [ ] Skill registered in available-skills list
- [ ] Rejects invocations without `--scope=`
- [ ] `--scope=design` reads `mcp-defaults-design.json` + confirms factory seeds present
- [ ] `--scope=build` reads architecture.yaml; aborts if missing
- [ ] `--auto-author-stack-skills` flag parsed; default flag-don't-author behavior
- [ ] Idempotent — re-runs on same inputs produce identical output
- [ ] Returns SkillsAuditOutput JSON with success + scope + gap lists + warnings
- [ ] Never reads `.env` (block-dangerous inheritance)
- [ ] `--scope=design` does NOT read architecture.yaml (scope separation)
