---
task-id: "038"
title: "Skills Agent (scope-split: design + build)"
status: pending
priority: P3
tier: 10 — Meta & Compliance
depends-on: ["019"]
estimated-scope: small
---

# 038: Skills Agent (refactor-003 scope split)

## What This Task Produces

Agent definition at `.claude/agents/skills-agent.md` plus a `/skills-audit` skill at `.claude/skills/skills-audit/SKILL.md` accepting a `--scope=design | --scope=build` argument.

Refactor-003 splits the prior single-invocation audit into two scope-discriminated invocations keyed to pipeline position:

- **`--scope=design`** (post-analyze, pre-mockups) — design-stage tooling: NativeWind 4, Storybook 8 with Tailwind preset, CVA v1, Tailwind plugins, MCP clients (playwright, icons8, unsplash, chrome-devtools, image-generator if nanobanana)
- **`--scope=build`** (post-architect-full, pre-build) — build-stage vendor SDKs from `architecture.yaml.apps.*.integrations` (Stripe, ThirdWeb, Mapbox, Resend, etc.)

Both scopes share the underlying skill-authoring logic; only the audit-target list differs.

## Scope

### Agent Definition

```yaml
---
name: skills-agent
description: Audits whether the project has skills for the chosen stack. Invoked twice per pipeline at different scopes. If missing, researches documentation, authors new SKILL.md with bundled resources, validates on a minimal test case.
tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch
model: inherit
maxTurns: 30
effort: high
---
```

### Skill frontmatter

```yaml
---
name: skills-audit
description: Audit project skills for either design-stage or build-stage tech stack. Accepts --scope=design|build; the two scopes target different inputs and run at different pipeline positions.
when_to_use: --scope=design runs post-analyze pre-mockups; --scope=build runs post-architect pre-build
argument-hint: --scope=design | --scope=build
allowed-tools: Read Write Edit Bash Grep Glob WebSearch WebFetch
---
```

### Responsibilities by scope

#### `--scope=design` (runs post-analyze, pre-mockups)

Audit the design-stage tooling list. Read:

- `docs/requirements.md` — `§Skills Needed` subset relevant to design stages
- `docs/analysis/shared/styles.md` — extracted font/typography libs
- `docs/analysis/shared/assets.md` — icon library choice
- `docs/analysis/shared/inspirations.md` — referenced pattern libraries
- `docs/selected-style.json` — NOT YET AVAILABLE at this stage (gate 2 hasn't fired). Scope defaults to ALL styles' requirements; the post-gate-2 re-audit is unnecessary because design-stage MCPs + pattern libs are style-agnostic.

Target skills to audit:

- `nativewind-expo` — NativeWind 4 + Expo 52 integration
- `storybook-tailwind` — Storybook 8 with Tailwind preset + framework-agnostic primitives
- `cva` — class-variance-authority v1 patterns
- Tailwind plugins referenced in any `styles.md` block (e.g., `@tailwindcss/typography`, `@tailwindcss/container-queries`, `@tailwindcss/forms`)
- MCP client usage skills: `playwright-mcp`, `icons8-mcp`, `unsplash-mcp`, `chrome-devtools-mcp`, and `gemini-mcp` (if `--flags=nanobanana` is active)

For each target: check if a skill exists at `.claude/skills/` or `~/.claude/skills/`. If missing, research documentation + author SKILL.md with templates + validate on a minimal test case.

#### `--scope=build` (runs post-architect, pre-build)

Audit the build-stage **vendor SDKs** AND **stack skills** (feat-002). Read:

- `.claude/architecture.yaml` — **authoritative** source. Two distinct subsets:
  - `apps.*.integrations[]` where `deployment === "vendor"` → drives vendor SDK skill audit (Stripe, Resend, etc.)
  - `tooling.stack.*` → drives stack-skill audit per feat-002 (below)
- `docs/requirements.md § Skills Needed` — build-stage subset

##### Vendor SDK audit

Target vendor SDK skills are derived dynamically from architecture.yaml vendor picks. Ignore `declined` and `self-hosted` entries (different skill needs — self-hosted gets a deployment-checklist pointer, not an SDK skill). Examples for a typical project:

- `stripe-connect` — if `integrations.payments.vendor === "stripe"`
- `thirdweb-embedded-wallets` — if `integrations.auth.vendor === "thirdweb"`
- `mapbox-gl-js` — if `integrations.maps.vendor === "mapbox"`
- `resend-node` — if `integrations.email-transactional.vendor === "resend"`
- `firebase-messaging` — if `integrations.push.vendor === "firebase-cloud-messaging"`
- `sentry-node` — if `integrations.monitoring.vendor === "sentry"`

For each vendor: check if a skill exists, research the vendor's documentation if missing, author SKILL.md with a minimal integration recipe (e.g., how to initialize + make one representative call), validate on a stub test.

##### Stack-skill audit (feat-002)

For each non-null slot in `architecture.yaml.tooling.stack`:

1. Resolve slot → tier + slug:
   - `web_framework` / `web_styling` → tier `front-end`
   - `mobile_framework` → tier `mobile`
   - `backend_language` / `backend_framework` / `orm` / `database` → tier `back-end`
2. Check if `.claude/skills/agents/{tier}/{slug}/SKILL.md` exists on disk.
3. Decide action:
   - **Exists + maturity `shipped`**: nothing to do (report as `auditedShipped: +1`).
   - **Exists + maturity `draft`**: flag for human review on first production use; report as `auditedDraft: +1`.
   - **Exists but `dependencyPinsRefreshedAt` > 90 days old**: emit a warning; do not block. Report as `stalePin: +1`.
   - **Missing, and `--auto-author-stack-skills` flag is present**: research via WebSearch + WebFetch on the stack's official docs; author a new SKILL.md with `maturity: draft`, filling every required section per the `_template/SKILL.md` contract; smoke-test if possible (install + `typecheck` on a hello-world). Report as `stackSkillsAuthored: +1`.
   - **Missing, no `--auto-author-stack-skills` flag**: **abort with a clear error**. Example: `"Stack skill missing: architecture.yaml.tooling.stack.backend_framework = 'go-chi' but .claude/skills/agents/back-end/go-chi/SKILL.md does not exist. Re-run /skills-audit --scope=build --auto-author-stack-skills OR manually author the skill OR change the architecture.yaml pick to a shipped slug."`

**Shipped stack-slug registry** (initial feat-002 drop):

- front-end: `react-next`, `svelte-kit`
- back-end: `node-trpc-nest`, `python-fastapi`
- mobile: `expo-rn`

**Enum-valid but draft (needs authoring)**: `remix`, `astro`, `qwik`, `vue-nuxt`, `solid-start`, `node-trpc-only`, `node-express`, `node-fastify`, `python-django`, `go-chi`, `go-echo`, `rust-axum`, `ruby-rails`, `bare-rn`, `flutter`, `tauri-mobile`, `native-kotlin`, `native-swift`. Allowed by `schemas/architecture.schema.json` enum; auto-authored on first use.

### Shared logic (both scopes)

1. Check `.claude/skills/{skill-name}/` and `~/.claude/skills/{skill-name}/` for existing SKILL.md.
2. If missing: research via WebFetch on official docs + WebSearch for integration patterns.
3. Author SKILL.md following factory skill conventions (frontmatter with `name`, `description`, `when_to_use`, `allowed-tools`; steps section; examples).
4. Validate by running a minimal test case (e.g., initialize the SDK with a fake credential + ensure import resolves without error). Smoke-test only, not full integration test.
5. Deposit at `~/.claude/skills/{skill-name}/` (global) AND copy into `.claude/skills/{skill-name}/` (project-local). The `/new-project --force` refresh path will re-copy on next refresh.

### Invocation points

- **`--scope=design`**: orchestrator invokes between `analyze` (gate 1 resolved) and `mockups`. See task 035 `STAGES` array.
- **`--scope=build`**: orchestrator invokes between `pm` and `register-mcp-build`. See task 035.

### Output

Both scopes return `SkillsAuditOutput` (034b discriminated union on `scope`):

```ts
{
  scope: "design" | "build",
  success: true,
  skillsAudited: N,
  skillsAuthored: N,           // net new skills created
  vendorSdksAudited?: N,       // build scope only
  warnings: [...]
}
```

## Acceptance Criteria

- [ ] `.claude/agents/skills-agent.md` exists with correct frontmatter
- [ ] `.claude/skills/skills-audit/SKILL.md` exists with `argument-hint: --scope=design | --scope=build`
- [ ] Skill rejects invocations without `--scope` arg with clear error: `"--scope is required: --scope=design (pre-design) or --scope=build (post-architect)"`
- [ ] `--scope=design` reads `docs/requirements.md`, `docs/analysis/shared/{styles,assets,inspirations}.md`; does NOT read `architecture.yaml` (may not exist yet)
- [ ] `--scope=build` reads `.claude/architecture.yaml`; filters `apps.*.integrations[]` to entries with `deployment: "vendor"`; ignores `self-hosted` and `declined`
- [ ] Both scopes: for each missing skill, author SKILL.md with research-backed content, validate with smoke test, deposit globally + locally
- [ ] Return `SkillsAuditOutput` with the correct `scope` discriminator value
- [ ] Orchestrator (035) invokes at the two specified positions; task 034b `StageSchemas` keys `skills-audit-design` and `skills-audit-build` both resolve to `SkillsAuditOutput`

## Human Verification

On a test project with a mix of design + build skill gaps:

1. Run `/skills-audit --scope=design` post-analyze. Does it author missing design-stage skills only, ignoring architecture.yaml (which doesn't exist yet)?
2. Run `/skills-audit --scope=build` post-architect. Does it author vendor SDK skills based on the concrete integrations.yaml decisions? Does it correctly skip `deployment: self-hosted` and `deployment: declined` entries?
3. Invoke without `--scope`. Does the skill reject with the clear error message?
