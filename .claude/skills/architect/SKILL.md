---
name: architect
description: Read analyst research + signoff artefacts, pick one vendor per integration slot and one stack-slug per tooling slot, emit architecture.yaml + .env.example + credentials/deployment checklists + docker-compose.yml + CI workflow. Runs post-signoff, pre-PM.
when_to_use: after /user-flows-generator sign-off gate (gate 4) resolves approved=true; before /pm
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "(no flags — architect is a single invocation)"
---

# /architect — post-signoff architecture + credentials

Runs after design sign-off (gate 4) and before PM. Single invocation, no phases. Produces the architecture-as-code spec, the credentials-setup surface for gate 5, and the **infrastructure minimum** (docker-compose + CI) so the generated app can boot on the user's machine.

Orchestrator (035) controls invocation. Architect does NOT fire inside the design pipeline — only at its scheduled stage position after user-flows sign-off.

## Prerequisites

- `/user-flows-generator` completed + gate 4 sign-off resolved `approved: true`
- `docs/signoff-{timestamp}.json` exists and parses
- `docs/requirements.md` + `docs/brief-summary.json` + `docs/analysis/shared/integrations-options.md` present
- `docs/selected-style.json` written (locked at gate 2)
- `schemas/architecture.schema.json` present (validation target)
- `scripts/validate-architecture.mjs` present (self-verify runner)
- `.claude/architecture.yaml.template` present (shape reference; never loaded at runtime, used for design docs only)

## Inputs (authoritative read order)

1. `docs/signoff-*.json` — the latest by filename timestamp. Parse + assert `approved: true`. Extract `uiKitVersion`, `screensManifestHash`, `visualReviewReportHash`. **Abort** on missing / unapproved.
2. `docs/requirements.md` — platforms + personas + features + compliance flags + skills needed
3. `docs/brief-summary.json` — `projectName`, `detectedPlatforms`, `integrationsResearched`
4. `docs/analysis/shared/integrations-options.md` — the research menu. One category → one decision per run.
5. `docs/selected-style.json` — carries `iconLibrary` + `dials`. **Mirror only** — don't re-decide.
6. `brief.md` §7, §8, §9, §14 — stack hints + compliance flags + infrastructure preferences
7. `docs/screens/**/*.html` — composed screens; narrow vendor SDKs to primitives actually rendered
8. `docs/asset-inventory.json` — user-supplied assets (for compliance scoping)
9. `docs/brand-extracted.yaml` (optional) — brand-guide compliance rules
10. `.claude/architecture.yaml` (optional, re-run only) — prior output. Hash it pre-overwrite; emit `docs/credentials-diff.md` post-overwrite.

## Outputs

| Path                                  | Purpose                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `.claude/architecture.yaml`           | Full architecture-as-code spec; validates against the schema                               |
| `.env.example`                        | Vendor credential placeholders grouped by required-now / later / optional                  |
| `docs/credentials-checklist.md`       | Human-readable vendor-signup table with "☐" status column                                  |
| `docs/deployment-checklist.md`        | Self-hosted services operational notes + config-template pointers                          |
| `docs/config/{service}.toml.template` | Per self-hosted integration (may be `.yaml` or `.json` depending on service)               |
| `docs/credentials-diff.md`            | Re-runs only — kept / new / changed / removed groups vs prior file                         |
| `docker-compose.yml`                  | Local dev composition — backend + database + optional Redis per integrations               |
| `apps/api/Dockerfile`                 | Per-stack Dockerfile (bug-118; copied from `.claude/templates/Dockerfile-{slug}.template`) |
| `.github/workflows/ci.yml`            | CI pipeline per `architecture.yaml.meta.ciProvider` (default: github-actions)              |
| `.mcp.json` (extended via task 041)   | Build-stage MCP servers (usually no-op)                                                    |

## Steps

### 1. Gate signoff + load inputs

- Find the newest `docs/signoff-*.json` by filename timestamp. If none: **abort** with "No signoff found — /architect runs post-gate-4".
- Parse. Assert `approved === true`. If false or missing: **abort** with "Signoff not approved; gate 4 must resolve before /architect".
- Read inputs 2–9 in order. Record which are present (brand-extracted.yaml is optional).
- If `.claude/architecture.yaml` exists, compute sha256 hex of its bytes and retain for the diff.

### 2. Parse the research menu + match to categories

Read `docs/analysis/shared/integrations-options.md`. Parse by `^## Category:` headings. For each category, extract candidate vendors + their signals (pricing, lock-in, compliance, self-hosted availability).

Record the raw menu in memory — one pick per category will emerge in step 3.

### 3. Apply decision heuristics per category

For each category, apply heuristics in precedence order:

1. **Brief signal wins.** Grep `brief.md` §7.3 + §8 for explicit vendor names from the candidate list. If one matches, pick it unless integrations-options.md flagged a blocker.
2. **Compliance fit.** If `requirements.md` names GDPR / HIPAA / SOC 2 / COPPA, filter candidates to ones that offer compliant residency/tier.
3. **Lock-in risk.** Equal on price + features → prefer lower lock-in.
4. **Scale realism.** Pick free-tier matching user's implied scale; no Enterprise without signal.
5. **Self-hosted preference.** Messaging / infrastructure / mesh networking often signal self-hosted — honour the signal.

Record for each integration:

- `category`
- `deployment: vendor | self-hosted | declined`
- `vendor` (if vendor)
- `signupUrl` + `credentialsRequired[]` + `requiredBy[]` + `requiredNow` (if vendor)
- `configTemplate` + `deploymentChecklist` + `operationalNotes` (if self-hosted)
- `declinedRationale` (if declined — must include why + when to reconsider)
- `decisionRationale` — always, one-line prose citing the heuristic that applied

### 4. Pick stack-slugs per tooling.stack slot (feat-002)

For each slot (`web_framework`, `web_styling`, `mobile_framework`, `backend_language`, `backend_framework`, `orm`, `database`, `persistence_layer`):

1. Check brief §7/§8 for explicit names (`FastAPI`, `SvelteKit`, `Expo`, etc.) → pick.
2. Otherwise check `docs/analysis/shared/competitors.md` for dominant stacks in the winning vertical → borrow.
3. Otherwise use factory defaults:
   - `web_framework: react-next`, `web_styling: tailwind`
   - `mobile_framework: expo-rn`
   - `backend_language: node`, `backend_framework: node-trpc-nest`
   - `orm: prisma`
   - `database: postgres`
4. No-tier case: set slot to `null` (e.g. `mobile_framework: null` for web-only projects). PM uses `features[].skip[]` to skip the builder for null tiers.

**`persistence_layer` (feat-038 Phase 2B)** — drives the E2E data-seeding strategy per `.claude/rules/testing-policy.md §E2E data-seeding strategy`. Pick from the (web_framework, backend_framework, database) shape:

- `database != null` → `persistence_layer: real-db` (Strategy C — hybrid baseline + per-block seed)
- `database == null && backend_framework != null` → `persistence_layer: external-api-only` (Strategy D — page.route intercept of the upstream API)
- `database == null && backend_framework == null && web_framework != null` → `persistence_layer: localStorage` (Strategy A — per-test localStorage clear)
- All-null (no app surface) → `persistence_layer: null`

The synthesizer `scripts/synthesize-flow-e2e.mjs` infers from the same rule when `persistence_layer` is absent, so legacy projects keep working — but new architect runs MUST set the field explicitly so the slot is auditable in `stackRationale[]`.

For every slot, record a `stackRationale[]` entry:

```yaml
- slot: web_framework
  pick: react-next
  reason: "Factory default — brief did not name a framework"
  briefSignal: null
  rejected: [svelte-kit, remix]
```

When picking a non-null slug, verify that `.claude/skills/agents/{tier}/{stack-slug}/SKILL.md` exists. If it doesn't, the slot is a **draft stack** — record in `stackRationale[].reason` as `"draft stack — triggers /skills-audit --scope=build --auto-author-stack-skills"`. Skills-audit step 11 will author it.

### 5. Compose architecture.yaml

Build the YAML structure per `.claude/architecture.yaml.template`:

- `meta`: projectName (from brief-summary), generatedAt (now, ISO-8601), generatedBy: `"/architect (refactor-003)"`, priorArchitectureSha (from step 1), ciProvider (default `github-actions`; override from brief §8 if specified), signoff subtree populated from the signoff file.
- `apps`: one entry per app in `detectedPlatforms` plus `api` (inferred — every project with a backend has an api app). `framework` is the free-text mirror of `tooling.stack.{tier}_framework`. `integrations` subtree contains the per-category decisions from step 3.
- `packages`: ui-kit (version mirrored from signoff.uiKitVersion), types, utils, api-client, orchestrator-contracts.
- `tooling.stack`: the slot picks from step 4.
- `tooling.icon_library`: mirrored from `docs/selected-style.json.iconLibrary`.
- `tooling.design_dials`: mirrored from `docs/selected-style.json.dials`.
- `tooling.mcp_servers`: read existing `.mcp.json` entries; preserve them as an array. Usually architect adds zero new entries.
- `tooling.skills.design`: derived from `tooling.stack` (e.g. `storybook-tailwind`, `nativewind-expo`).
- `tooling.skills.build`: one slug per vendor pick (e.g. `stripe-connect`, `thirdweb-embedded-wallets`).
- `tooling.budget`: total_mcp_cost_usd (default 25), total_image_gen_calls (default 100 — enforced only when `--flags=nanobanana`).
- `assets.provenance`: derive from `docs/asset-inventory.json` (user vs hybrid vs research).
- `compliance`: mirror from `requirements.md` + `brief.md` §14.
- `stackRationale[]`: from step 4.

Write to `.claude/architecture.yaml` using js-yaml with `noRefs: true, lineWidth: 120`.

### 6. Validate architecture.yaml

Run:

```bash
node scripts/validate-architecture.mjs .claude/architecture.yaml
```

If exit code non-zero, **abort** with the error messages. Fix + retry.

### 7. Emit .env.example

Three groups, in this order:

```bash
# =============================================================================
# .env.example — auto-generated by /architect
# Copy to .env and fill in values. Never commit .env.
# Gate 5 file-watches for docs/credentials-confirmed.txt
# =============================================================================

# -----------------------------------------------------------------------------
# REQUIRED NOW — /build-backend will fail without these
# -----------------------------------------------------------------------------

# <VendorName> (<category>) — <signupUrl>
# Pricing: <pricingTier from research>
# required-now: true
<KEY_1>=
<KEY_2>=

# -----------------------------------------------------------------------------
# REQUIRED LATER — needed at /deploy (not build)
# -----------------------------------------------------------------------------

# ... (same pattern, requiredNow: false, required by deploy)

# -----------------------------------------------------------------------------
# OPTIONAL — feature-flag gated
# -----------------------------------------------------------------------------

# <VendorName> — gated by --flags=<flagName>
# ...
```

A vendor decision with `requiredNow: true` goes in REQUIRED NOW. A vendor decision with `requiredBy` including `deploy` (not `build-backend`) goes in REQUIRED LATER. A vendor decision inside a feature-flag-gated integration (e.g. image-generator when `nanobanana` is the flag) goes in OPTIONAL with the flag name.

Self-hosted integrations go in `.env.example` ONLY if they also carry a vendor-side API key (rare — usually they're config-file only).

### 7b. Emit per-app env contracts (multi-tier projects only) — bug-032 Phase C

When `architecture.yaml.apps` includes BOTH a web/mobile-frontend tier AND a backend `api` tier, the architect MUST emit per-app env files declaring the cross-tier wiring contract. Without this, the frontend's API client constructs same-origin URLs that hit the frontend dev server and 404 — silently breaking every flow that exercises the backend (empirically observed on `repo-health-dashboard-01` 2026-04-30).

**For `apps/web/`** (or `apps/admin/` — any browser-tier app that consumes a workspace `@repo/api-client`-style package):

Author `apps/web/.env.example` declaring `NEXT_PUBLIC_API_BASE`:

```env
# =============================================================================
# apps/web/.env.example — frontend env contract (auto-generated by /architect).
# Copy to .env.local for local dev. .env.local is gitignored.
# =============================================================================

# Backend API origin — MUST match the FastAPI process's bound port.
#
# In dev:    copy this file to .env.local and set the port to whatever
#            apps/api/ binds. Default is :<BACKEND_PORT> (per
#            apps/api/.env.example).
# In prod:   set in deployment env (Vercel project settings, etc.) to the
#            deployed backend's full origin (https://api.example.com).
#
# Empty string falls back to same-origin — works ONLY if the backend is
# proxied through Next.js rewrites, which this scaffold does NOT configure.
NEXT_PUBLIC_API_BASE=http://localhost:<BACKEND_PORT>
```

Substitute `<BACKEND_PORT>` with whatever the backend stack defaults to (8000 for FastAPI per pydantic-settings convention; 3001 historically for Express; etc.).

**For `apps/api/`:**

Author `apps/api/.env.example` declaring `PORT` + `CORS_ORIGIN`:

```env
# =============================================================================
# apps/api/.env.example — backend env contract (auto-generated by /architect).
# Copy to .env (or apps/api/.env) for local dev. .env is gitignored.
# =============================================================================

# Port the backend process binds. Default per stack convention.
# When changed, MUST also update apps/web/.env.local NEXT_PUBLIC_API_BASE
# to point at the same port (or use scripts/dev.mjs which handles
# port coordination automatically).
PORT=<BACKEND_PORT>

# CORS origin — MUST match the frontend dev origin (typically :3000).
# Mismatched ports → CORS preflight failure on every API call.
CORS_ORIGIN=http://localhost:<FRONTEND_PORT>

# Vendor secrets (GitHub PAT, etc.) — see project-root .env.example
# for full contract. Backend-side only; never sent to the browser.
```

**When `architecture.yaml.tooling.stack.persistence_layer == "real-db"`** (Strategy C — managed DB backend), the architect MUST ALSO add:

```env
# E2E test-seed gating (per .claude/rules/testing-policy.md Strategy-C-test-seed-contract).
# DEV DEFAULT: 1 — exposes POST /test/seed, /test/cleanup, /test/seed-baseline
# under /test/ prefix. The verifier + playwright globalSetup require these.
# PROD: leave unset OR explicitly =0; the runtime guard in apps/api/src/app.ts
# checks `process.env.ENABLE_TEST_SEED === "1"`, so prod must NEVER have it set.
# NEVER ship this file with `=0` — that breaks the dev verifier loop (bug-080).
ENABLE_TEST_SEED=1
```

This is non-negotiable: the back-end stack skills (`.claude/skills/agents/back-end/{node-fastify,node-trpc-nest,python-fastapi}/SKILL.md §3 step 4`) all mandate this line with the literal value `1`. Empirical motivator (bug-080, 2026-05-11): all 4 reading-log projects shipped with `=0`, breaking manual operator boots and exposing the verifier to silent runtime-error masking. The line MUST be in the architect-emitted `apps/api/.env.example` template — backend-builder follow-up alone has been unreliable.

**`.env.local` is operator-authored, NOT auto-generated.** The factory's `enforce-boundaries.sh` hook (correctly) blocks writes to `.env.local`-pattern files as a secrets guard. The architect MUST document the operator copy step in `docs/credentials-checklist.md`'s gate-5 section (see step 8 below):

```
For local dev, after editing .env:
  cp apps/web/.env.example apps/web/.env.local
  cp apps/api/.env.example apps/api/.env
```

### 7c. Emit `scripts/dev.mjs` (multi-tier projects only) — bug-032 Phase C + bug-040 Phase A.5

When the project has both tiers per step 7b, the architect MUST also emit a project-root `scripts/dev.mjs` that boots BOTH halves with port coordination.

**The template is stack-specific.** Per bug-040 Phase A.5 (2026-05-03), the factory ships one template per backend stack:

| `architecture.yaml.tooling.stack.backend_framework` | Canonical template                                             |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `python-fastapi`                                    | `.claude/templates/dev-multi-tier-python-fastapi.mjs.template` |
| `node-fastify`                                      | `.claude/templates/dev-multi-tier-node-fastify.mjs.template`   |
| `node-trpc-nest`                                    | `.claude/templates/dev-multi-tier-node-trpc-nest.mjs.template` |
| `node-express`                                      | `.claude/templates/dev-multi-tier-node-express.mjs.template`   |

Resolution algorithm:

```
slug      = architecture.yaml.tooling.stack.backend_framework
template  = .claude/templates/dev-multi-tier-{slug}.mjs.template

if !exists(template):
    HARD-FAIL with "no canonical dev.mjs template for backend_framework=<slug>;
                    add it under .claude/templates/ before re-running architect"
    (do NOT silently fall back — better to fail fast than ship a non-booting project)

cp $template <projectDir>/scripts/dev.mjs
```

Each backend stack skill (`.claude/skills/agents/back-end/{slug}/SKILL.md`) carries a `§dev-orchestrator` subsection naming the canonical template + documenting the spawn-command shape; consult that section when authoring/extending stack support.

What every template handles:

- Reading `.env` + `.env.local` for the actual `PORT` value (precedence chain matches bug-038's `resolveBackendPort`)
- Spawning the backend with the stack-appropriate command (FastAPI: `uv run uvicorn ...` from `apps/api/`; node-\*: `pnpm --filter @repo/api dev` or `start:dev` from monorepo root)
- Awaiting `/health` before booting frontend
- Setting `NEXT_PUBLIC_API_BASE=http://localhost:<port>` in the Next.js spawn env so the frontend's API client points at the real backend
- Pre-flight refuse-to-start when EITHER backend port or `:3000` is already taken (the latter matters because Next.js auto-falls-back to `:3001` outside the backend's CORS allowlist, silently breaking every API call)
- Cross-platform spawn (Windows: `pnpm.cmd` + PATHEXT shim; POSIX: native commands + detached process group)

DO NOT hand-edit the template after copy — the per-stack file already does the right thing. If the project's stack doesn't fit any shipped template, add a new template + stack skill `§dev-orchestrator` section first (factory work), then dispatch architect against the new stack. Inline edits to the project's `scripts/dev.mjs` get clobbered on `/architect` re-runs and put the project out-of-sync with the orchestrator's verifier-time spawn (`orchestrator/src/dev-server.ts STACK_BACKEND_SPAWN_COMMAND` — bug-043).

### 8. Emit docs/credentials-checklist.md

Human-readable table with "☐" status column per row. One section per group (required-now / required-later / optional / deferred). Columns: #, Service, Category, Signup URL, Pricing, Keys, Status.

Include the gate-5 file-drop instruction at the top:

```
## Gate 5 confirmation

After filling in `.env`, drop one of the following as `docs/credentials-confirmed.txt`:
  - `proceed` — all required-now keys set
  - `defer:SERVICE_A,SERVICE_B` — deferring these services with rationale below
  - `abort` — stop the pipeline
```

The `Deferred` section starts empty; populated by gate 5 when the user writes `defer:...`.

**Multi-tier projects only — bug-032 Phase C:** when step 7b authored per-app `.env.example` files, also include a "Local dev setup" sub-section so the operator copies them to `.env.local` / `.env` before running `node scripts/dev.mjs`:

```
## Local dev setup (multi-tier projects)

The factory's `enforce-boundaries.sh` hook intentionally blocks auto-creation
of `.env.local` files (secrets-pattern guard). After filling in your project-
root `.env`, run these once:

  cp apps/web/.env.example apps/web/.env.local
  cp apps/api/.env.example apps/api/.env

Then `node scripts/dev.mjs` from the project root boots both halves with
port coordination. See `scripts/dev.mjs` source for the full contract.
```

### 7d. Copy E2E seed-helper template (feat-038 Phase 2B)

When `architecture.yaml.tooling.stack.web_framework` is non-null AND `persistence_layer` is non-null, copy the strategy-appropriate factory template to the project's e2e helpers directory so the synthesizer (`scripts/synthesize-flow-e2e.mjs`) can import from it without manual operator setup:

```bash
mkdir -p <project>/apps/web/e2e/helpers
case "$persistence_layer" in
  localStorage)
    cp .claude/templates/seed-localstorage.ts.template <project>/apps/web/e2e/helpers/seed-localstorage.ts
    ;;
  external-api-only)
    cp .claude/templates/seed-intercept.ts.template <project>/apps/web/e2e/helpers/seed-intercept.ts
    ;;
  real-db)
    cp .claude/templates/seed-db.ts.template <project>/apps/web/e2e/helpers/seed-db.ts
    mkdir -p <project>/apps/web/playwright
    cp .claude/templates/playwright-global-setup.ts.template <project>/apps/web/playwright/global-setup.ts
    ;;
esac
```

For `real-db` projects also wire `globalSetup: "./playwright/global-setup.ts"` into `apps/web/playwright.config.ts` (if the config exists at architect time; otherwise the web-frontend-builder picks this up when scaffolding the config). The `/test/seed` + `/test/cleanup` endpoint contract that `seed-db.ts` consumes is documented in `.claude/skills/agents/back-end/python-fastapi/SKILL.md §Testing`.

Strategy mapping:

| persistence_layer   | template copied                                           | strategy slug |
| ------------------- | --------------------------------------------------------- | ------------- |
| `localStorage`      | seed-localstorage.ts.template                             | A             |
| `external-api-only` | seed-intercept.ts.template                                | D             |
| `real-db`           | seed-db.ts.template + playwright-global-setup.ts.template | C             |

Idempotent — overwrite existing helpers on each architect re-run so the project stays in lockstep with factory updates.

### 9. Emit docs/deployment-checklist.md (self-hosted only)

One section per self-hosted integration. Include: config template path, deployment footprint notes, ports / runtime dependencies / operational notes from the research menu.

If there are no self-hosted integrations, still write the file with a short header stating "No self-hosted integrations — all vendor-backed" (so downstream stages always find the file).

### 10. Emit docs/config/{service}.toml.template per self-hosted integration

Each self-hosted integration gets one template file. Name the file after the vendor slug (e.g. `docs/config/postgres.toml.template`, `docs/config/conduwuit.toml.template`). Include:

- Commented header: "Config template for <Service>. Copy to docs/config/<service>.toml and fill in."
- Section-by-section placeholders per the service's documented config schema.

For postgres specifically, emit a minimal config template with `port`, `data_directory`, `shared_preload_libraries`, and `max_connections` placeholders.

### 11. Emit docker-compose.yml + apps/api/Dockerfile (must-have infrastructure minimum)

**Two artefacts ship together.** The compose file references `dockerfile: Dockerfile`; the referenced file MUST exist at the same relative path or `docker-compose up api` fails with `failed to read dockerfile`. Both are emitted in lockstep per bug-118.

**11a — Emit `apps/api/Dockerfile` from the per-stack factory template.**

Same per-stack-template selection pattern as step 7c's `scripts/dev.mjs`. Lookup:

| `architecture.yaml.tooling.stack.backend_framework` | Template                                               |
| --------------------------------------------------- | ------------------------------------------------------ |
| `node-fastify`                                      | `.claude/templates/Dockerfile-node-fastify.template`   |
| `node-trpc-nest`                                    | `.claude/templates/Dockerfile-node-trpc-nest.template` |
| `node-express`                                      | `.claude/templates/Dockerfile-node-express.template`   |
| `python-fastapi`                                    | `.claude/templates/Dockerfile-python-fastapi.template` |

Resolution algorithm (identical to §7c):

```
slug      = architecture.yaml.tooling.stack.backend_framework
template  = .claude/templates/Dockerfile-{slug}.template

if !exists(template):
    HARD-FAIL with "no canonical Dockerfile template for backend_framework=<slug>;
                    add it under .claude/templates/ before re-running architect"
    (do NOT silently fall back — better to fail fast than ship a non-booting project)

cp $template <projectDir>/apps/api/Dockerfile
```

Skip step 11a entirely when `tooling.stack.backend_framework` is `null` (frontend-only project). The matching compose-file emission also skips the `api` service in that case (see 11b).

**Empirical motivator**: `gotribe-tribe-wizard` 2026-05-17 — every prior shipped project's compose file referenced `apps/api/Dockerfile` that was never authored; the reviewer's "api boots on 3001" check stayed silent because no sibling project exercised `docker-compose up api`. The hole opened the first time a reviewer interpreted the boot check literally + tried `compose up`.

**11b — Emit `docker-compose.yml`.** Shape:

```yaml
version: "3.8"

services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: "postgres://postgres:postgres@db:5432/app"
      # other env vars referenced from .env via `env_file` below
    env_file:
      - .env
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "<BACKEND_PORT>:<BACKEND_PORT>"
    healthcheck:
      test:
        [
          "CMD",
          "wget",
          "--quiet",
          "--tries=1",
          "--spider",
          "http://localhost:<BACKEND_PORT>/health",
        ]
      interval: 10s
      timeout: 3s
      retries: 5

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  # Redis added only when integrations mention queue / cache / session-store
  # redis:
  #   image: redis:7-alpine
  #   ports: ["6379:6379"]
  #   healthcheck:
  #     test: ["CMD", "redis-cli", "ping"]
  #     interval: 5s
  #     timeout: 3s
  #     retries: 5

volumes:
  db-data:
```

**Per-stack `<BACKEND_PORT>` substitution** (substitute the literal value per `backend_framework` slug BEFORE writing the file):

| `backend_framework` | `<BACKEND_PORT>` |
| ------------------- | ---------------- |
| `node-fastify`      | `3001`           |
| `node-trpc-nest`    | `3001`           |
| `node-express`      | `3001`           |
| `python-fastapi`    | `8000`           |

The same value MUST match the per-stack Dockerfile's `EXPOSE` line + the value the architect writes into `apps/api/.env.example` `PORT=<BACKEND_PORT>` per step 7b. Three places, one number.

**Skip clauses** (record each as a warning):

- **Skip 11a (Dockerfile emission)** when `tooling.stack.backend_framework` is `null`.
- **Skip 11b's `api` service block** when `tooling.stack.backend_framework` is `null`. The `db` service still emits if `tooling.stack.database` is non-null.
- **Skip 11b entirely (whole compose.yml)** when BOTH `tooling.stack.backend_framework` AND `tooling.stack.database` are `null` (frontend-only static-site project).

### 12. Emit .github/workflows/ci.yml (or equivalent)

Branch per `architecture.yaml.meta.ciProvider`:

- `github-actions` (default) → `.github/workflows/ci.yml`
- `gitlab-ci` → `.gitlab-ci.yml`
- `circleci` → `.circleci/config.yml`

For github-actions:

```yaml
name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r lint

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: app
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U postgres"
          --health-interval=5s
          --health-timeout=3s
          --health-retries=5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r test
        env:
          DATABASE_URL: "postgres://postgres:postgres@localhost:5432/app"

  build:
    runs-on: ubuntu-latest
    needs: [typecheck, lint, test]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
```

Skip `test` job's postgres service when `tooling.stack.database` is null. Skip the whole workflow emission if ALL of `web_framework`, `mobile_framework`, `backend_framework` are null (nothing to CI). Record skips in warnings.

### 13. Emit credentials-diff.md (re-runs only)

If step 1 recorded a priorArchitectureSha, load the prior architecture.yaml (the sha hash was computed pre-overwrite, so the prior content is still available in memory from step 1). Diff per-integration:

- **Kept** — vendor + keys unchanged
- **New** — vendor pick not in prior
- **Changed** — same category but different vendor (write both old + new keys; signup URL for new)
- **Removed** — category in prior but not in current

Write to `docs/credentials-diff.md`. Include: timestamp, one section per group, explicit "add to .env" / "safe to remove from .env" language per the scaffolding §docs/credentials-diff.md shape.

Skip this step if prior architecture.yaml didn't exist.

### 14. Delegate to task 041 (/register-mcp-servers --scope=build)

Invoke the skill if it exists. If `.claude/skills/register-mcp-servers/SKILL.md` is missing, emit a warning ("register-mcp-servers build scope not yet implemented; see task-041") and record `buildMcpServersAdded: []`. The actual registration is usually no-op (vendor SDKs are NPM packages).

### 15. Self-verify (all 11 checks)

Execute each check:

1. `node scripts/validate-architecture.mjs .claude/architecture.yaml` → exit 0
2. Grep `.claude/architecture.yaml` for every `apps.*.integrations.*` entry → each has `deployment` field
3. For each `deployment: vendor`, confirm `vendor`, `signupUrl`, `credentialsRequired`, `requiredBy`, `requiredNow`, `decisionRationale` populated
4. For each `deployment: self-hosted`, confirm `configTemplate` path resolves to a file under `docs/config/`
5. For each `deployment: declined`, confirm `declinedRationale` non-empty
6. `.env.example` has the three group headers (`REQUIRED NOW`, `REQUIRED LATER`, `OPTIONAL`)
7. Every non-null `tooling.stack` slot has a matching `.claude/skills/agents/{tier}/{slug}/SKILL.md` OR appears in `stackRationale[].reason` as "draft stack"
8. `tooling.icon_library` exactly equals `docs/selected-style.json.iconLibrary`
9. `docker-compose.yml` exists when any `apps.*.framework` is non-null
   9b. **`apps/api/Dockerfile` exists when `tooling.stack.backend_framework` is non-null (bug-118).** AND its content matches `.claude/templates/Dockerfile-{slug}.template` byte-for-byte (the architect copies the template verbatim — no per-project edits). AND `docker-compose.yml`'s `services.api.build.dockerfile` value resolves to a file present on disk at the same relative path the field declares (default: `apps/api/Dockerfile`). Failure mode without this check (empirically observed gotribe-tribe-wizard 2026-05-17): compose.yml ships referencing `dockerfile: Dockerfile` but no Dockerfile is authored; `docker-compose up api` fails with `failed to read dockerfile`; reviewer's "api boots on 3001" check blocks the feature.
10. `.github/workflows/ci.yml` (or equivalent) exists when any `tooling.stack.*_framework` is non-null
11. Grep own execution log for `.env` reads/writes — zero allowed outside `.env.example` context

Any failure → fix + retry the specific step, then re-verify. After 3 self-verify attempts, abort with an error listing the failed checks.

### 16. Emit return JSON

Write the ArchitectOutput JSON to stdout as a single line or final block. The orchestrator parses it via `ArchitectOutputSchema`. Shape:

```json
{
  "success": true,
  "architectureYamlPath": ".claude/architecture.yaml",
  "envExamplePath": ".env.example",
  "appsCount": <integer>,
  "packagesCount": <integer>,
  "vendorDecisions": [...],
  "selfHostedDecisions": [...],
  "declinedDecisions": [...],
  "envVarsRequiredNow": [...],
  "envVarsRequiredLater": [...],
  "envVarsOptional": [...],
  "credentialsChecklistPath": "docs/credentials-checklist.md",
  "deploymentChecklistPath": "docs/deployment-checklist.md",
  "credentialsDiffEmitted": <bool>,
  "credentialsDiffPath": "docs/credentials-diff.md" | null,
  "configTemplatesEmitted": [...],
  "stackRationale": [...],
  "dockerComposePath": "docker-compose.yml" | null,
  "ciWorkflowPath": ".github/workflows/ci.yml" | null,
  "buildMcpServersAdded": [],
  "warnings": [...]
}
```

## Error paths

- **Signoff missing / unapproved** — abort with "Signoff not approved; gate 4 must resolve approved=true before /architect".
- **integrations-options.md missing** — abort with "Analyst integrations research missing. Re-run /analyze."
- **selected-style.json missing** — abort with "Selected style missing. Gate 2 must resolve before /architect."
- **Schema validation fails on architecture.yaml** — retry generation up to 3 attempts with error context. After 3: abort with the last validation errors.
- **self-verify fails** — retry up to 3 attempts. After 3: abort listing failed checks.
- **.env read/write detected** — HARD abort regardless of intent. This is a security boundary.

## Integration Points

- **Task 036 Gate 5** reads `docs/credentials-confirmed.txt` file-drop post-architect. Consumes `.env.example` group structure for required-now inventory (stat-only; never reads `.env`).
- **Task 041 /register-mcp-servers --scope=build** consumes `.claude/architecture.yaml.tooling.mcp_servers` + appends to `.mcp.json`. Usually no-op. Step 14 delegates.
- **Task 021 /pm --mode=tasks** reads `architecture.yaml` + requirements.md to produce `docs/tasks.yaml` v2. Task-035 Mode B scheduler drives `features[]` from there.
- **Builders (028/029/030)** read `architecture.yaml.tooling.stack` for stack dispatch; read `architecture.yaml.apps.*.integrations.*` for vendor SDK pinning + import scoping.
- **Reviewer (032)** reads architecture.yaml for "no secrets in code" enforcement.

## Auto-run chain (ADR-005)

`/architect` is an operator-invokable parent command. Per ADR-005, after this skill's primary work completes (architecture.yaml + .env.example + credentials-checklist + deployment-checklist + per-self-hosted config templates + docker-compose.yml + CI workflow), it **MUST automatically invoke the internal child skill via the Skill tool**:

**Child to auto-run (after Gate 5 credentials drop):**

1. **`stylesheet-primitives`** — via `Skill(skill: "stylesheet-primitives", args: "")`
   - Reads `architecture.yaml.tooling.stack.web_framework` (chosen stack: react-next / svelte-kit / vue-nuxt / etc.)
   - Dispatches `ui-designer` to the matching skill in `.claude/skills/agents/front-end/{slug}/` to author the stack-bound primitives (Button.tsx for React, Button.vue for Vue, Button.svelte for Svelte, etc.) + patterns + layouts + Storybook + 022b artifacts
   - Binds the kit-core authored pre-architect by `/stylesheet` to the chosen stack
   - Updates `packages/ui-kit/package.json` with React (or stack-equivalent) peerDeps; emits CONTRACT.md update; emits 022b validate-consumer.ts + eslint-plugin scoped to .ts(x)/.js(x)

**Gate-5 timing.** Per `orchestrator/src/stages-array.ts`, `architect` has `gateEnabled:true, gateType:"credentials"`; `stylesheet-primitives` has `gateEnabled:false`. The natural flow is: architect's work → Gate 5 (operator drops `gate-5-credentials-approved.txt` after filling .env + setting up vendor accounts) → auto-run stylesheet-primitives.

**Manual-mode polling for Gate 5.** When this skill runs in manual operator mode, after architect's primary work it polls for `docs/gate-5-credentials-approved.txt` (or `.claude/state/{runId}/gate-5-approved.txt`) every 5 seconds for up to 60 seconds. If the file appears, auto-invoke stylesheet-primitives. If timeout, return to the operator with message: "Architect complete. Drop the Gate 5 credentials file to auto-advance to /stylesheet-primitives, or re-run /architect after the drop to resume." Pipeline-mode unaffected (cli-runner owns its own gate-wait via gate-server-lifecycle).

**Idempotency:** `stylesheet-primitives` returns `{success:true, skipped:true}` if `packages/ui-kit/src/primitives/` already populated with the current stack's fingerprint. Pipeline-mode double-invocation safe.

## Acceptance criteria

- [ ] `.claude/skills/architect/SKILL.md` exists with the frontmatter above
- [ ] Reads 10 inputs in authoritative order; aborts on missing/unapproved signoff
- [ ] Five-heuristic vendor decision discipline applied per category with `decisionRationale` non-empty on every vendor pick
- [ ] Stack picks populate every `tooling.stack` slot; `stackRationale[]` has one entry per slot
- [ ] `.claude/architecture.yaml` validates against `schemas/architecture.schema.json` before proceeding
- [ ] `.env.example` grouped by required-now / required-later / optional with signup URL comment blocks
- [ ] `docs/credentials-checklist.md` emitted with "☐" status column + gate-5 file-drop instruction
- [ ] `docs/deployment-checklist.md` emitted (even if no self-hosted integrations — degenerate header)
- [ ] Per-self-hosted config template emitted under `docs/config/`
- [ ] `docker-compose.yml` emitted when any app framework is non-null
- [ ] `.github/workflows/ci.yml` (or equivalent) emitted when any framework is non-null
- [ ] `docs/credentials-diff.md` emitted on re-runs with kept/new/changed/removed groups
- [ ] Task 041 delegation attempted; graceful warning if the skill is missing
- [ ] 11-check self-verify runs before return; all must pass or the stage retries
- [ ] Return JSON validates against `ArchitectOutputSchema` from `@repo/orchestrator-contracts`
- [ ] Grep of skill code for `.env` (outside `.env.example` context) returns zero matches
