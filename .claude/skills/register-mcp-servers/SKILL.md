---
name: register-mcp-servers
description: Register MCP servers into .mcp.json and sync per-agent frontmatter mcp_servers list per Toolshed scoping. Dual-scope: --scope=design (at /new-project; reads mcp-defaults-design.json) or --scope=build (post-architect; reads architecture.yaml.tooling.mcp_servers filtered to entries beyond design set). Idempotent. Usually no-op at build scope since vendor SDKs are NPM packages not MCP servers.
when_to_use: --scope=design at /new-project step 5b; --scope=build post-architect in orchestrator Mode A stage 10
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "--scope=design | --scope=build"
---

# /register-mcp-servers — dual-scope MCP registry + agent-frontmatter sync

Registers MCP servers into `.mcp.json` and propagates their `scoped_to` field into each agent's YAML frontmatter `mcp_servers` list (Toolshed pattern). Idempotent: re-invocations on identical inputs produce zero changes.

## Arguments

- `--scope=<design | build>` (required). Missing → reject with `/register-mcp-servers requires --scope=design OR --scope=build`.

## Prerequisites

### `--scope=design`

- `mcp-defaults-design.json` at project root (factory-seeded by `/new-project`)

### `--scope=build`

- `.claude/architecture.yaml` exists (architect has run); abort otherwise
- `.mcp.json` may or may not exist yet — create if missing

## Steps

### 1. Argument gate

Parse `--scope=`. Reject missing or invalid. No additional flags in MVP scope.

### 2. Read inputs per scope

**`--scope=design`**:

- Read `mcp-defaults-design.json` — the factory-seeded design-stage MCP set (playwright, icons8, unsplash, chrome-devtools, optional image-generator gated behind `feature_flag: nanobanana`)
- Each entry has: `name`, `command`/`args` (server spawn), `scoped_to: [agent-name, ...]` (which agents see this MCP), optional `feature_flag: string`
- Read `.mcp.json` at project root (may not exist yet) — the current MCP registry

**`--scope=build`**:

- Read `.claude/architecture.yaml` — extract `tooling.mcp_servers[]` (list of build-stage MCP server entries architect added; usually empty)
- Read `.mcp.json` — the current registry (populated at design-scope time)
- Filter architecture's list to entries NOT already in `.mcp.json` — these are the new build-stage additions

### 3. Apply feature-flag filter (design scope only)

Read the pipeline's active feature flags from env var `CLAUDE_PIPELINE_FLAGS` (set by orchestrator from `--flags=<csv>` CLI arg). For each candidate server with `feature_flag`:

- Flag active → include
- Flag inactive → skip + record in `skipped[]` with reason `"feature-flag {name} inactive"`

No feature-flag on a server → always include.

### 4. Write `.mcp.json`

For each server that survives filtering AND is not already in `.mcp.json`:

- Append to `.mcp.json.mcpServers` (create the top-level `mcpServers` key if missing)
- Record in `registered[]` output
- If already present, record in `skipped[]` with reason `"already-registered"` (idempotent behavior)

Use `node -e "const m = JSON.parse(fs.readFileSync('.mcp.json','utf8')); ..."` for atomic read-modify-write; OR read → mutate → `JSON.stringify(obj, null, 2)` → write. Either path; emit deterministic formatting (2-space indent, trailing newline) so re-runs diff cleanly.

### 5. Sync per-agent frontmatter

For each server just registered, walk its `scoped_to: [agent-name, ...]`. For each named agent:

- Read `.claude/agents/{agent-name}.md`
- Parse frontmatter YAML
- Ensure `mcp_servers` field is a list (create if missing); append the server's `name` if not already present
- Write back (preserve body byte-for-byte; only frontmatter mutates)

This is the Toolshed pattern — each agent sees only the MCP servers relevant to its role. Builders don't see Playwright; ui-designer doesn't see database MCPs (if any).

### 6. Emit McpRegisterOutput JSON

```json
{
  "success": true,
  "scope": "design" | "build",
  "registered": [
    { "name": "playwright", "scopedTo": ["ui-designer", "html-verifier"] }
  ],
  "skipped": [
    { "name": "image-generator", "reason": "feature-flag nanobanana inactive" }
  ],
  "mcpJsonPath": ".mcp.json",
  "agentsUpdated": ["ui-designer", "html-verifier"],
  "warnings": []
}
```

Orchestrator validates against its placeholder stage-output schema (accepts any `{ success: boolean }`).

## Hard rules

- Idempotent: re-runs on identical inputs register zero new servers + update zero agents
- Never remove existing MCP servers from `.mcp.json` (this skill only registers; removal is a separate rare operation via different tooling)
- Never modify agent BODY — only frontmatter `mcp_servers` field
- Never read `.env`
- `--scope=design` MUST NOT read `architecture.yaml` (scope separation — design MCPs are factory-seeded, not architect decisions)
- `--scope=build` MUST NOT re-register design-scope MCPs (`skipped[]` already-registered on repeat)
- Feature-flag filter only applies on design scope (no build-scope servers have feature flags per current spec)

## Error paths

- **Missing `--scope=`** → abort
- **Invalid `--scope=` value** → abort listing valid values
- **`--scope=build` without architecture.yaml** → abort (`/architect` hasn't run)
- **`mcp-defaults-design.json` missing in design-scope** → abort (factory seeding failed)
- **Malformed JSON in `.mcp.json`** → abort; don't clobber user state

## Integration Points

- **Task 035 orchestrator** invokes this skill at Mode A stages `register-mcp-design` (implicitly, via /new-project) + `register-mcp-build`
- **`/new-project` step 5b** invokes `/register-mcp-servers --scope=design` as part of project bootstrap (pre-exists this skill; the skill now owns the registration contract)
- **`/skills-audit --scope=build`** emits `missingMcpServers[]` which THIS skill's build-scope invocation consumes (they run back-to-back in orchestrator Mode A stages 9 + 10)
- **Task 041 MCP Defaults** — `mcp-defaults-design.json` is the factory seed this skill reads; that file is shipped via task 041 scaffolding

## Acceptance criteria

- [ ] Skill registered in available-skills list
- [ ] Rejects invocations without `--scope=`
- [ ] `--scope=design` reads `mcp-defaults-design.json` + registers filtered entries into `.mcp.json`
- [ ] `--scope=build` reads architecture.yaml; aborts if missing
- [ ] Feature-flag filter honored (design scope only): servers with inactive flags go to `skipped[]`
- [ ] Per-agent frontmatter `mcp_servers` updated per `scoped_to` field
- [ ] Idempotent: re-run produces zero new registrations
- [ ] Agent file BODY unchanged (only frontmatter mutated)
- [ ] Returns McpRegisterOutput JSON with success + scope + registered + skipped + agentsUpdated + warnings
- [ ] Never removes existing MCP servers
