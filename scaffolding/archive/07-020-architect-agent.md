---
task-id: "020"
title: "Architect Agent + Architecture.yaml Template (late-running, vendor decisions, credential emission)"
status: pending
priority: P2
tier: 6.5 — Post-Design Planning
depends-on: ["019", "025b"]
estimated-scope: medium
---

# 020: Architect Agent + Architecture.yaml Template

## Position in pipeline (refactor-003)

The architect runs **after** the design sign-off gate (gate 4, task 036) and **before** PM (task 021). It is a single invocation — no phases. By the time it runs, the user has already approved:

- analyst outputs + requirements + integrations-options research menu
- a style (gate 2 → `docs/selected-style.json`)
- a UI Kit (gate 3)
- composed screens + visual review
- a design sign-off that binds `screensManifestHash + visualReviewReportHash + uiKitVersion`

The architect's job is to **pick one vendor per integration slot** from the analyst's research menu, emit the project's stack configuration as `architecture.yaml`, and generate the user-facing credential-setup files the gate-5 file-drop flow consumes. The architect does NOT touch `.env`, ever. `.env` is user-authored at gate 5 using the `.env.example` the architect produces.

## What This Task Produces

1. Agent definition at `.claude/agents/architect.md`
2. Architecture.yaml template at `.claude/architecture.yaml.template`
3. `/architect` skill at `.claude/skills/architect/SKILL.md`
4. `.env.example` generator logic (inline in the skill)
5. `credentials-checklist.md` + `deployment-checklist.md` + `credentials-diff.md` emission (inline in the skill)
6. `.mcp.json` extension for build-stage MCP servers (delegating to task 041 `/register-mcp-servers --scope=build`)

## Scope

### Agent Definition

```yaml
---
name: architect
description: Produces architecture.yaml + .env.example + credentials & deployment checklists from analyst research, selected style, composed screens, and signoff. Runs once, post-signoff, pre-PM. Never writes .env.
tools: Read, Write, Bash, Grep, Glob
model: inherit
maxTurns: 40
effort: max
---
```

System-prompt themes (full content in the agent file):

- Senior technical architect. Opinionated but evidence-driven. Picks one vendor per slot from the research menu — no fence-sitting.
- Output files are consumed by downstream stages (PM, builders, reviewer, compliance). Format is a contract.
- NEVER reads or writes `.env`. That file is gate-5 user territory, enforced by `block-dangerous.sh`.
- Self-hosted is a first-class deployment decision. Not every integration is a vendor signup.
- Three-way decision enum per integration: `vendor | self-hosted | declined`. Declined must carry a rationale.

### /architect Skill

Skill at `.claude/skills/architect/SKILL.md`.

```yaml
---
name: architect
description: Read analyst research + signoff artefacts, pick one vendor per integration slot, emit architecture.yaml + .env.example + credentials/deployment checklists. Runs post-signoff, pre-PM.
when_to_use: after /user-flows-generator sign-off gate (gate 4) resolves approved=true; before /pm
allowed-tools: Read Write Bash Grep Glob
---
```

### Inputs (in read order)

1. `docs/requirements.md` — platforms + personas + features + compliance flags + skills needed
2. `docs/brief-summary.json` — machine-readable index including `integrationsResearched` count
3. `docs/analysis/shared/integrations-options.md` — **the vendor research menu**. One of these candidates becomes each integration slot's pick.
4. `docs/selected-style.json` — locked at gate 2; carries `iconLibrary` (refactor-003 schema addition). Architect MIRRORS this into `architecture.yaml.tooling.icon_library` — does not decide.
5. `brief.md` §7 (Architecture Overview), §8 (Infrastructure), §9 (Backend Modules), §14 (Compliance)
6. `docs/screens/**/*.html` — composed screens; architect scopes SDK imports to primitives actually used (e.g., if no map screen exists, Mapbox isn't pinned even if brief mentioned it)
7. `docs/signoff-{timestamp}.json` — the binding design sign-off; architect reads it only to confirm `approved: true` + record the `uiKitVersion` in architecture.yaml
8. `docs/asset-inventory.json` — user-supplied assets (for compliance scoping)
9. `docs/brand-extracted.yaml` (optional) — brand-guide compliance rules
10. `.claude/architecture.yaml` (optional, re-run only) — prior architect output. On re-runs, architect reads this and emits `docs/credentials-diff.md` vs current decisions.

### Outputs

| File                                                                           | Purpose                                                                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `.claude/architecture.yaml`                                                    | Full architecture-as-code spec: apps, packages, tooling, integrations (with three-way `deployment` enum), compliance |
| `.env.example`                                                                 | Placeholder rows per vendor credential, annotated with signup URL + required-by + required-now flags                 |
| `docs/credentials-checklist.md`                                                | Human-readable table of vendor services needing signup; grouped by required-now / required-later / optional          |
| `docs/deployment-checklist.md`                                                 | Human-readable entries for self-hosted integrations with config-template pointers + operational notes                |
| `docs/config/{service}.toml.template` (or `.yaml.template` / `.json.template`) | One per self-hosted integration — config file the user fills in during deployment                                    |
| `docs/credentials-diff.md` (re-runs only)                                      | Kept / new / changed / removed integrations vs prior architecture.yaml                                               |
| `.mcp.json` (extended)                                                         | Build-stage MCP servers appended to design-stage defaults (usually no-op)                                            |

### Three-way `deployment` enum per integration

Every entry in `architecture.yaml.apps.*.integrations[]` carries this block:

```yaml
integrations:
  email-transactional:
    deployment: vendor # vendor | self-hosted | declined
    vendor: resend
    signupUrl: https://resend.com
    pricingTier: "Free 100/day; paid from $20/mo for 50k"
    credentialsRequired:
      - name: RESEND_API_KEY
        format: "re_..."
    requiredBy: [build-backend]
    requiredNow: true # blocks /build-backend if unset
    freeTierNotes: "Forever-free up to 100 emails/day"
    lockInRisk: low
    decisionRationale: "Simplest API + transactional receipts flow fits §12 email requirements; lowest lock-in vs SendGrid"

  messaging:
    deployment: self-hosted
    vendor: conduwuit
    configTemplate: docs/config/conduwuit.toml.template
    deploymentChecklist: docs/deployment-checklist.md#matrix-homeserver
    credentialsRequired: [] # self-hosted — no vendor key
    requiredBy: [deploy]
    operationalNotes: "One homeserver per node (brief §7.3); federates with public Matrix"

  analytics:
    deployment: declined
    declinedRationale: "Brief §12 mentions ML rec/fraud/churn but v1 ships without product analytics; reconsider Release 3. No .env row, no checklist entry."
```

### Emission paths differ per deployment

- **`vendor`** → row(s) in `.env.example` with `# ServiceName — SIGNUP_URL (required by STAGE)` comment block; entry in `credentials-checklist.md` under the appropriate required-\* group.
- **`self-hosted`** → entry in `deployment-checklist.md`; config template under `docs/config/`. No `.env.example` row unless the self-hosted service also needs an API secret (rare).
- **`declined`** → `declinedRationale` field only. Nothing emitted to checklists. PM + builders skip this integration entirely.

### `.env.example` shape

Architect writes a single `.env.example` at project root with this structure:

```bash
# =============================================================================
# .env.example — auto-generated by /architect (refactor-003)
# Copy to .env and fill in values. Never commit .env.
# Gate 5 file-watches for docs/credentials-confirmed.txt — see CREDENTIALS-CHECKLIST.md.
# =============================================================================

# -----------------------------------------------------------------------------
# REQUIRED NOW — /build-backend will fail without these
# -----------------------------------------------------------------------------

# Stripe (payments) — https://dashboard.stripe.com/register
# Pricing: 2.9% + $0.29/txn; Connect adds 0.25%/txn
# required-now: true
STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Resend (transactional email) — https://resend.com
# Pricing: Free 100/day; paid $20/mo for 50k
# required-now: true
RESEND_API_KEY=

# -----------------------------------------------------------------------------
# REQUIRED LATER — needed at /deploy (not build)
# -----------------------------------------------------------------------------

# Firebase Cloud Messaging (push) — https://console.firebase.google.com
# Pricing: Free
# required-now: false (needed for production push; build works without)
FCM_SERVER_KEY=

# -----------------------------------------------------------------------------
# OPTIONAL — feature-flag gated
# -----------------------------------------------------------------------------

# Gemini (nanobanana image generation) — https://aistudio.google.com/
# Required only when --flags=nanobanana is active
# required-now: false
GOOGLE_API_KEY=
```

### `docs/credentials-checklist.md` shape

```markdown
# Credentials Checklist

_Auto-generated by /architect. Fill in `.env` before confirming at gate 5._

## Gate 5 confirmation

After filling in `.env`, drop one of the following as `docs/credentials-confirmed.txt`:

- `proceed` — all required-now keys are set
- `defer:SERVICE_A,SERVICE_B` — deferring these services with rationale below
- `abort` — stop the pipeline

## Required now (blocks /build-backend)

| #   | Service | Category            | Signup                                | Pricing                      | Keys                                                             | Status |
| --- | ------- | ------------------- | ------------------------------------- | ---------------------------- | ---------------------------------------------------------------- | ------ |
| 1   | Stripe  | Payments            | https://dashboard.stripe.com/register | 2.9% + $0.29/txn             | STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET | ☐      |
| 2   | Resend  | Transactional Email | https://resend.com                    | Free 100/day, $20/mo for 50k | RESEND_API_KEY                                                   | ☐      |

## Required later (needed at /deploy)

| #   | Service                  | Category           | Signup                              | Pricing | Keys           | Status |
| --- | ------------------------ | ------------------ | ----------------------------------- | ------- | -------------- | ------ |
| 1   | Firebase Cloud Messaging | Push Notifications | https://console.firebase.google.com | Free    | FCM_SERVER_KEY | ☐      |

## Optional (feature-flag gated)

| #   | Service | Category         | Gated by           | Signup                       | Pricing      | Keys           | Status |
| --- | ------- | ---------------- | ------------------ | ---------------------------- | ------------ | -------------- | ------ |
| 1   | Gemini  | Image Generation | --flags=nanobanana | https://aistudio.google.com/ | Pay-per-call | GOOGLE_API_KEY | ☐      |

## Deferred (user decision at gate 5)

_None yet. Update when `docs/credentials-confirmed.txt` contains `defer:...`._
```

### `docs/deployment-checklist.md` shape

```markdown
# Deployment Checklist

_Auto-generated by /architect. Self-hosted integrations that need
operational setup at deploy time (not build time). No credentials here —
see credentials-checklist.md for vendor services._

## Matrix homeserver (Conduwuit)

- **Config template:** `docs/config/conduwuit.toml.template`
- **Deployment footprint:** one homeserver per node
- **Ports:** 8448 (federation), 443 (client)
- **Notes:** Federates with public Matrix; signed agreements ride over this
- **Runtime dependencies:** PostgreSQL 16 (shared), GarageHQ media store

## K3s cluster

- **Provisioning:** Ansible role `add-node` (see `skills/k3s-ansible`)
- **Nodes:** initial 3-node cluster per Release 1 (Hetzner CX22 recommended)
- **Terraform module:** `skills/terraform-hetzner`
```

### `docs/credentials-diff.md` (re-runs only)

Emitted only when `.claude/architecture.yaml` existed at architect-start time. Shape:

```markdown
# Credentials Diff — {today}

_Comparison of current architect decisions vs prior `.claude/architecture.yaml`._

## Kept (no action — keys in .env still valid)

- Stripe (STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
- ThirdWeb (THIRDWEB_CLIENT_ID, THIRDWEB_SECRET_KEY)

## New (supply keys in .env)

- Resend (RESEND_API_KEY) — signup at https://resend.com

## Changed (vendor swap — supply new keys, old rows safe to remove)

- Analytics: PostHog → Plausible
  - Remove from .env: POSTHOG_API_KEY, POSTHOG_HOST
  - Add to .env: PLAUSIBLE_DOMAIN, PLAUSIBLE_API_KEY
  - Signup: https://plausible.io

## Removed (safe to delete from .env — no longer used)

- SendGrid (SENDGRID_API_KEY) — superseded by Resend
```

**Architect NEVER reads or modifies `.env`.** The user is the sole `.env` author. Credentials-diff.md is a guide, not an instruction the orchestrator executes.

### Vendor-decision heuristics

When the research menu has 2–3 candidates, architect picks by this priority:

1. **Brief signal wins.** If brief §7.3 explicitly names a vendor, pick it unless integrations-options.md flagged a blocker (e.g., EU-residency unavailable and GDPR required).
2. **Compliance fit.** If compliance flags require EU residency / HIPAA / SOC 2, filter to candidates that offer it. Document as `decisionRationale`.
3. **Lock-in risk.** When candidates are equal on price + features, prefer lower lock-in risk (lower switching cost, open-source alternatives available).
4. **Scale realism.** Pick the free-tier that fits the user's implied scale from requirements.md; don't commit to Enterprise tier without brief signal.
5. **Self-hosted where brief signals it.** Messaging / infrastructure / mesh networking are often brief-signalled as self-hosted — honour that signal.

Every vendor decision MUST include a `decisionRationale` field citing which heuristic applied.

### Architecture.yaml Template

Template at `.claude/architecture.yaml.template` shows the expected structure. Key sections:

```yaml
meta:
  projectName: "..."
  generatedAt: "ISO-8601"
  generatedBy: "/architect (refactor-003)"
  priorArchitectureSha: null # filled on re-runs from sha256 of prior file
  signoff:
    file: docs/signoff-{timestamp}.json
    uiKitVersion: "1.0.0"
    screensManifestHash: "..."
    visualReviewReportHash: "..."

apps:
  web:
    platformId: webapp
    framework: next
    frameworkVersion: "15.x"
    routing: app-router
    auth: thirdweb-embedded-wallets # from integrations.auth vendor pick
    state: zustand
    integrations:
      auth: { ... }
      payments: { ... }
      # ...
  mobile:
    platformId: mobile
    framework: expo
    # ...
  api:
    platformId: (no platformId — api is a build target, not a design platform)
    framework: nestjs
    orm: drizzle
    database: postgres-16
    integrations: { ... }
  admin:
    platformId: admin
    framework: next
    # ...

packages:
  ui-kit:
    version: "1.0.0" # mirrored from signoff.uiKitVersion
    source: packages/ui-kit/
  types: { ... }
  utils: { ... }
  api-client: { ... }
  orchestrator-contracts: { ... }

tooling:
  # NEW per feat-002-stack-skill-shelf: the authoritative stack choice lives here.
  # Each slot is a stack-slug that resolves to .claude/skills/agents/{tier}/{stack-slug}/SKILL.md.
  # Builders dispatch via these values: backend-builder reads backend_framework, web-frontend-builder
  # reads web_framework, mobile-frontend-builder reads mobile_framework. null on a slot = "no app of
  # that tier" (skip builder entirely). Schema: schemas/architecture.schema.json#/definitions/stack.
  stack:
    web_framework: react-next # shipped: react-next | svelte-kit; draft: remix, astro, qwik, vue-nuxt, solid-start
    web_styling: tailwind # shipped: tailwind
    mobile_framework: expo-rn # shipped: expo-rn; draft: flutter, bare-rn, native-kotlin, native-swift
    backend_language: node # enum per stack.schema (node | python | go | rust | ruby | java)
    backend_framework: node-trpc-nest # shipped: node-trpc-nest, python-fastapi; draft: others per schema
    orm: prisma # enum per schema (prisma | drizzle | sqlalchemy | sqlmodel | diesel | ...)
    database: postgres # informational — drives docker-compose + dev-setup, not builder prompts
  icon_library: lucide # MIRRORED from selected-style.json.iconLibrary
  design_dials: # MIRRORED from selected-style.json.dials
    design_variance: 4
    motion_intensity: 3
    visual_density: 5
  mcp_servers:
    # Design-stage servers merged in from mcp-defaults-design.json at /new-project time.
    # Architect appends build-stage servers only (usually zero — vendor SDKs are NPM, not MCP).
    - name: playwright
      scoped_to: [ui-designer, html-verifier]
      # ... (pre-existing from /new-project)
    # Build-stage additions (if any) appended here
  skills:
    design:
      - nativewind-expo
      - storybook-tailwind
      - cva
    build:
      - stripe-connect
      - thirdweb-embedded-wallets
      - matrix-conduwuit
      - powersync-sqlite
      # derived from integrations picks
  budget:
    total_mcp_cost_usd: 25
    total_image_gen_calls: 100 # enforced only when --flags=nanobanana

assets:
  provenance:
    logos: user
    icons: hybrid # user + lucide gap-fill
    fonts: research
    images: stock # Unsplash by default; generated if --nanobanana

compliance:
  gdpr: true
  coppa_under_13: excluded
  kyc_aml: stripe-identity # if brief §14 flagged
  privacy_manifest:
    data_collected: [...]
    third_party_ai: [] # Apple 5.1.2(i) — list AI providers
    age_rating: 17+
  required_assets:
    - privacy_policy_url
    - terms_url
    - support_url
```

Architect produces ONE `architecture.yaml`. No Phase A / Phase B split. On re-runs, architect overwrites the file (preserving `meta.priorArchitectureSha` = sha256 of the version it just superseded) and emits `credentials-diff.md` from the delta.

### Steps

The skill runs these in order:

1. Read all inputs listed above. Abort if `docs/signoff-*.json` is missing or `approved: false`.
2. If `.claude/architecture.yaml` exists, hash it and retain for diff.
3. For each integration category in `integrations-options.md`: apply decision heuristics, pick one candidate (or `declined` with rationale), record decision.
   3b. **Stack pick** (feat-002). For each `tooling.stack` slot (web_framework, web_styling, mobile_framework, backend_language, backend_framework, orm, database), pick a stack-slug that matches a shipped (or recently-authored-draft) skill under `.claude/skills/agents/{tier}/{stack-slug}/SKILL.md`. Picking heuristic: - **Brief-hinted stack wins.** If brief §7 (Architecture) or §8 (Build Decisions) names a stack explicitly ("FastAPI", "SvelteKit", "Expo"), the architect picks that without further analysis. - **Competitor alignment**. If brief doesn't name a stack, check `docs/analysis/shared/competitors.md` for the dominant stack in the winning vertical — borrow the same stack when user context (team skills, deploy target) doesn't push otherwise. - **Factory defaults (no signal)**: `web_framework: react-next`, `mobile_framework: expo-rn`, `backend_framework: node-trpc-nest`, `orm: prisma`, `database: postgres`, `web_styling: tailwind`. These match the current blueprint §17 defaults. - **No-tier case**: if the project has no web tier, set `web_framework: null` + `web_styling: null`. Same for mobile + backend. PM uses `features[].skip[]` to skip builders for null tiers. - For every slot, write a `stackRationale[]` entry: `{slot, pick, reason, briefSignal: <quote or null>, rejected: [<slug>, ...]}`. Archive the reasoning — downstream agents (PM, builders, tester) read this to understand why a stack was chosen.
4. Compose `apps.*`, `packages.*`, `tooling.*` (incl. `tooling.stack`), `compliance.*`, `stackRationale[]` (mirroring selected-style.json fields, not re-deciding).
5. Write `.claude/architecture.yaml`. Validate against `schemas/architecture.schema.json` (strict for `tooling.stack` subtree; loose for consumer-specific app fields).
6. Generate `.env.example` grouped by required-now / required-later / optional.
7. Generate `docs/credentials-checklist.md` (table form).
8. Generate `docs/deployment-checklist.md` for any self-hosted integrations.
9. Emit config templates at `docs/config/{service}.toml.template` for each self-hosted integration.
10. If a prior architecture.yaml existed: emit `docs/credentials-diff.md`.
11. Invoke `/register-mcp-servers --scope=build` (task 041) — reads architecture.yaml, appends any new build-stage MCP entries to `.mcp.json`. Usually no-op.
12. Self-verify: every integration has a `deployment` field; every vendor-deployment has `credentialsRequired` + `signupUrl`; every self-hosted has `configTemplate`; every declined has `declinedRationale`. No `.env` read or write. All inputs still accounted for in outputs.
13. Return `ArchitectOutput` JSON (schema in 034b): `appsCount, packagesCount, vendorDecisions, selfHostedDecisions, declinedDecisions, envVarsRequiredNow, envVarsRequiredLater, envVarsOptional, credentialsDiffEmitted, buildMcpServersAdded, warnings`.

## Acceptance Criteria

- [ ] `.claude/agents/architect.md` exists; `tools` list does NOT include `Edit` or `Read` access to `.env` (block-dangerous.sh already enforces; agent def makes the boundary explicit)
- [ ] `.claude/architecture.yaml.template` shows all sections (apps, packages, tooling, assets, compliance, meta)
- [ ] Template includes the `apps.*.integrations[].deployment: vendor | self-hosted | declined` three-way enum
- [ ] `.claude/skills/architect/SKILL.md` exists with frontmatter `when_to_use: after /user-flows-generator sign-off gate (gate 4) resolves approved=true; before /pm`
- [ ] Skill is a single invocation (no `--phase` arg)
- [ ] Skill reads `docs/selected-style.json.iconLibrary` and mirrors it into `architecture.yaml.tooling.icon_library` (NOT decides it fresh)
- [ ] Skill reads `docs/selected-style.json.dials` and mirrors into `architecture.yaml.tooling.design_dials`
- [ ] **Skill populates `architecture.yaml.tooling.stack` with stack-slugs matching entries under `.claude/skills/agents/{tier}/`** (feat-002). Every non-null slot must resolve to a SKILL.md on disk OR trigger `/skills-audit --scope=build --auto-author-stack-skills` at step 11.
- [ ] Skill emits `architecture.yaml.stackRationale[]` with one entry per populated stack slot — `{slot, pick, reason, briefSignal, rejected[]}` — per `schemas/architecture.schema.json`
- [ ] Brief-hinted stacks (explicit mention of FastAPI / SvelteKit / Expo / etc. in brief §7 or §8) override architect-inferred picks; rationale records the brief quote
- [ ] Factory defaults used when no signal present: web_framework=react-next, mobile_framework=expo-rn, backend_framework=node-trpc-nest, orm=prisma, web_styling=tailwind
- [ ] Architecture validates against `schemas/architecture.schema.json` — `tooling.stack` subtree strict (`additionalProperties: false`); other subtrees loose
- [ ] Skill reads `docs/analysis/shared/integrations-options.md` and picks exactly one candidate per category (or declines with rationale)
- [ ] Every integration in architecture.yaml has `deployment` + (if vendor) `vendor, signupUrl, credentialsRequired, requiredBy, requiredNow, decisionRationale` OR (if self-hosted) `configTemplate, deploymentChecklist` OR (if declined) `declinedRationale`
- [ ] Skill emits `.env.example` grouped by required-now / required-later / optional with signup URL comments per block
- [ ] Skill emits `docs/credentials-checklist.md` in table form with "☐" status column for human tracking
- [ ] Skill emits `docs/deployment-checklist.md` with one entry per self-hosted integration
- [ ] Skill emits `docs/config/{service}.toml.template` (or .yaml/.json) per self-hosted integration
- [ ] On re-runs, skill detects prior architecture.yaml + emits `docs/credentials-diff.md` with kept / new / changed / removed groups
- [ ] Skill NEVER reads `.env` — grep of skill source/spec for `.env` outside of `.env.example` context returns zero matches
- [ ] Skill invokes `/register-mcp-servers --scope=build` (task 041) after writing architecture.yaml
- [ ] Skill returns `ArchitectOutput` matching 034b schema: `appsCount, packagesCount, vendorDecisions, selfHostedDecisions, declinedDecisions, envVarsRequiredNow, envVarsRequiredLater, envVarsOptional, credentialsDiffEmitted, buildMcpServersAdded, warnings`
- [ ] Vendor-decision heuristics documented in skill §Scope; `decisionRationale` field populated on every vendor decision
- [ ] HITL gate 5 (credentials, file-drop) follows this stage — see task 036 §Gate 5

## Downstream Implications

- **Task 021 PM** reads architecture.yaml + requirements.md to produce `docs/tasks.yaml` (main mode). Kit-change-request detour mini-plans don't need architecture.yaml.
- **Task 028–030 Builders** read architecture.yaml for stack + integrations; read `.env` (user-authored at gate 5) for runtime secrets.
- **Task 032 Reviewer** reads architecture.yaml; scans built code for "no secrets in code" (already an acceptance criterion).
- **Task 036 Gate 5** reads `docs/credentials-confirmed.txt` file-drop; consumes `.env.example` structure for required-now key inventory (stat-only, never read `.env`).
- **Task 040 App Store Compliance** reads `architecture.yaml.compliance` — now available since architect runs before compliance stage.
- **Task 041 MCP Registration** invoked with `--scope=build`; appends to existing `.mcp.json` (design-scope servers registered at /new-project time).

## Human Verification

Review the template + skill on a post-signoff gotribe-v1 run:

1. Does architect pick exactly one vendor per integration category? No fence-sitting.
2. Does `.env.example` group correctly by required-now / required-later / optional?
3. Do self-hosted integrations appear in deployment-checklist.md with config templates?
4. On a re-run, does credentials-diff.md correctly show kept / new / changed / removed?
5. Does the skill NEVER touch `.env`? (grep its invocation logs for any `.env` read-or-write attempt)
6. Does architecture.yaml.tooling.icon_library match selected-style.json.iconLibrary exactly?
