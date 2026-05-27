---
task-id: "036"
title: "HITL Gates + Budget Enforcement"
status: shipped-mvp
priority: P2
tier: 9 — Orchestrator
depends-on: ["035", "034b"]
estimated-scope: medium
shipped-as: plans/archive/task-036-hitl-gates-server.md
shipped-at: 2026-04-23
---

# 036: HITL Gates + Budget Enforcement

> **MVP status (2026-04-23):** shipped as `plans/active/task-036-hitl-gates-server.md`
> (archived on completion). MVP scope: **all 6 gates use file-drop**; HTTP UI
> for gates 2 + 4 (dial editor, signoff form) is **deferred post-MVP**. Gate 6
> (pr-review, new per investigate-002 answer #1) is wired. Budget enforcement
> lives in `orchestrator/src/budget-tracker.ts` (task-035 Phase 6) and is
> already shipped; this scaffolding's Budget Enforcement section is superseded
> by the BudgetTracker implementation.
>
> This file is archived for historical reference — the HTTP-server design
> documented below is a future enhancement.

## What This Task Produces

The **five** human-in-the-loop gates that sit between pipeline stages, plus the reserve-commit budget enforcer that caps MCP spend per stage. Gates 2 + 4 use backing HTTP servers; gates 1, 3, 5 are pure file-based (no server).

Refactor-001 added three endpoints, archive mechanics, hash recomputation, and uiKitVersion binding to the sign-off gate. Refactor-003 adds **gate 5 (credentials, file-drop)** between the late-running architect and PM — keeping the `.env` boundary clean by using the filesystem as the handoff rather than HTTP over localhost.

## Scope

### Five gates (refactor-003)

From blueprint §11 + refactor-001 + refactor-003:

| #     | After stage             | `gateType`        | Writes                                                         | Validates                                         |
| ----- | ----------------------- | ----------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| 1     | `/analyze`              | `requirements`    | (approval only — no artifact)                                  | `AnalyzeOutput`                                   |
| 2     | `/mockups`              | `mockups`         | `docs/selected-style.json` + archives losing styles            | `SelectedStyleSchema`                             |
| 3     | `/stylesheet`           | `design-system`   | (approval only — Storybook review)                             | `StylesheetOutput`                                |
| 4     | `/user-flows-generator` | `signoff`         | `docs/signoff-{timestamp}.json` + locks uiKitVersion           | `Signoff` (recomputes hashes, checks kit version) |
| **5** | **`/architect`**        | **`credentials`** | **`docs/credentials-confirmed.txt`** (user-authored file-drop) | **`CredentialsGateOutput`**                       |

Gate 4 is the design sign-off — **never disable** in autonomous mode; builders have no `uiKitVersion` binding otherwise. Gate 5 is the credentials gate — **never disable** in autonomous mode; builders have no `.env` otherwise. Gates 1–3 can be toggled off for expert-driver runs.

### Gate decision shape

```ts
interface GateDecision {
  approved: boolean;
  feedback?: string; // when rejected; injected into Layer 5 retry prompt
  payload?: unknown; // gate-specific data (e.g., selected styleId, dial edits)
}
```

- `approved: true` → orchestrator advances with any accompanying `payload`
- `approved: false` + `feedback` → retry upstream stage (max 3 attempts) with feedback injected
- `approved: false` + no `feedback` → abort the pipeline

### Gate callback + HTTP backing server

Each gate has two components:

1. **`onGate(stageOutput)` callback** — orchestrator-side function that decides whether the gate is a pure approval (gate 1, 3) or requires a backing server (gates 2, 4). For gates 2 and 4, it spins up an HTTP server on a dynamic port, opens the relevant HTML artifact in the user's browser, and awaits file-system writes before returning.

2. **Backing HTTP server** — an ephemeral Node/Express (or built-in `http`) server that handles the POSTs from the browser-side HTML. Lifecycle: started when the gate begins, killed when the gate's binding file is written (or the pipeline aborts).

Port assignment is dynamic (`server.listen(0)` → read actual port). The orchestrator (035) starts the server **before** the producing stage renders its HTML, then passes the resolved `GATE_API_BASE` (e.g., `http://localhost:8733`) to the stage as the `CLAUDE_GATE_API_BASE` env var. The skill substitutes the `{{GATE_API_BASE}}` placeholder in its template at write time. No post-write re-edit needed — the env var was known before the HTML was written.

### Gate 2 — Mockup gate (backing server endpoints)

Handles the `/mockups` → `/stylesheet` handoff at `docs/mockups/index.html`.

**`POST /api/dials/{styleId}`**

Body (JSON):

```json
{ "design_variance": 4, "motion_intensity": 3, "visual_density": 6 }
```

Handler:

1. Validate body against `Dials` schema (034b)
2. Read current `docs/mockups/{styleId}/dials.yaml`
3. Merge (only provided fields overwrite)
4. Write back with fsync; stamp `lastEditedAt` (current UTC) + `lastEditedBy: "human"`
5. Return 200 with the persisted values; 4xx on validation failure

Debounced ~300ms client-side, so a slider drag produces ~1 POST per settled value.

**`POST /api/select`**

Body (JSON):

```json
{ "styleId": "style-03" }
```

Handler (atomic, in this order):

1. Validate body shape; assert the referenced `docs/mockups/{styleId}/` directory exists
2. Read the current `docs/mockups/{styleId}/dials.yaml` for final dial values
3. Read the styles.md block matching `styleId` to get `styleName` and `stylesSourceRef`
4. Construct a `SelectedStyle` object matching `SelectedStyleSchema` (034b) with `selectedBy: "human"`, `selectedAt: <now>`, `nanobananaUsed: <from pipeline flag set>`
5. Validate the constructed object against `SelectedStyleSchema`
6. Write `docs/selected-style.json` with fsync
7. Move every other `docs/mockups/style-{K}/` directory (K ≠ chosen) to `docs/mockups/archive/style-{K}/`; write `docs/mockups/archive/{K}/archived.json` with `{ archivedAt, winner }`
8. Return 200 with the persisted SelectedStyle payload
9. Call `server.close()` on itself immediately after the response flush — the server terminates. The orchestrator's file watcher detects the new `docs/selected-style.json` independently and advances the pipeline. Orchestrator and server are decoupled: no cross-process signaling.

Errors: 4xx with structured detail on any validation / filesystem failure; the UI displays the error and leaves state unchanged.

### Gate 4 — Sign-off gate (backing server endpoints)

Handles the final `/user-flows-generator` approval at `docs/user-flows.html`.

**`POST /api/signoff`**

Body (JSON): the `Signoff` shape from 034b (nine fields)

Handler (atomic, in this order):

1. Validate body against `Signoff` schema
2. **Recompute `screensManifestHash`** from the current `docs/screens/**/*.html` state (using task 025's manifest-hash algorithm). Reject (4xx) with `stale: "screens"` if the submitted hash doesn't match — means something edited screens after the viewer loaded.
3. **Recompute `visualReviewReportHash`** from the current `docs/visual-review/report.json`. Reject with `stale: "visual-review"` if mismatch.
4. **Verify kit version binding**: read `packages/ui-kit/package.json.version`; if it differs from `body.uiKitVersion`, reject with `stale: "ui-kit"`.
5. If all three checks pass: write `docs/signoff-{body.signedAt}.json` with fsync
6. Return 200 with the persisted Signoff
7. Orchestrator's file watch detects the new signoff; if `approved: true`, advance to build phase; if `approved: false`, loop back with `comments` as feedback (max 3 design-pipeline retries)

The three stale-checks are what the 025/036 refactor locks down: a sign-off is bound to a specific (screens, visual-review, kit) triple. Any of them drifting invalidates the sign-off.

### Gate 1 — Requirements gate (no backing server)

Pure CLI / file-based approval. Orchestrator prints a summary of `docs/requirements.md` + brief stats from `AnalyzeOutput`; user approves via a simple `y/n` prompt in the terminal (or a plain file drop `docs/requirements-approved.txt`). No HTTP server needed.

### Gate 3 — Design-system gate (no backing server, but opens browser)

Orchestrator opens `packages/ui-kit/storybook-static/index.html` AND `docs/design-system-preview.html` in the browser. User previews; approves via CLI `y/n` prompt. No HTTP POST needed — approval is a simple yes/no, not a multi-field form.

Optional future enhancement: a backing server that accepts design-system feedback + routes it into Layer 5 retry for `/stylesheet`. Out of scope for v1.

### Gate 5 — Credentials gate (file-drop, no backing server)

Refactor-003. Handles the `/architect` → `/pm` handoff. Architect has just written `.env.example`, `docs/credentials-checklist.md`, `docs/deployment-checklist.md`, and (on re-runs) `docs/credentials-diff.md`. User fills in `.env` in their own editor; gate 5 file-watches for a single confirmation file.

**No HTTP server.** No backing port, no POST endpoints. The `.env` boundary stays clean — secrets never pass through Claude, never enter tool-call logs, never get reflected through a localhost form. `block-dangerous.sh` (task 007) keeps `.env` unreadable by every agent including the architect itself.

**User flow** (orchestrator prints this in the terminal after architect completes):

```
/architect complete. Review these files:
  - docs/credentials-checklist.md   (vendor services needing signup)
  - docs/deployment-checklist.md    (self-hosted services needing config)
  - docs/credentials-diff.md        (re-runs only — what changed since last run)
  - .env.example                    (placeholder rows grouped by required-now / required-later / optional)

To proceed, fill in .env and drop a confirmation:

  cp .env.example .env
  # edit .env in your own editor, paste real keys
  echo proceed > docs/credentials-confirmed.txt          # all required-now keys are set
  # OR
  echo 'defer:ServiceA,ServiceB' > docs/credentials-confirmed.txt   # skip these services with rationale in checklist
  # OR
  echo abort > docs/credentials-confirmed.txt            # stop the pipeline (resumable checkpoint saved)

Waiting for docs/credentials-confirmed.txt ...
```

Orchestrator re-prints the "Waiting ..." line every 60 seconds as a soft reminder; not spam.

**File watch** — chokidar or built-in `fs.watch`, poll interval ~500ms:

- Watches `docs/credentials-confirmed.txt`.
- On write, reads the file (permitted — it's not `.env`), parses the directive.
- Parses `proceed` / `defer:A,B` / `abort` (case-insensitive, whitespace-trimmed). Any other content = malformed; orchestrator logs warning + continues waiting.

**Parsing + handler logic:**

1. **`proceed`** (happy path):
   - Optional sanity check: `fs.statSync('.env').isFile()` — stat only, never `readFileSync`. Missing `.env` = warn "\.env not found; /build-backend will fail loudly. Continuing anyway — you may have keys in your shell environment instead."
   - Build `CredentialsGateOutput` (034b): `decision: "proceed"`, `servicesConfirmed: <all vendor deployment IDs from architecture.yaml>`, `servicesDeferred: []`, `deferralReasons: {}`, `envFileExists: <stat result>`, `warnings: []`.
   - Write `docs/credentials-captured.json` with the serialized output (for audit / re-run diff baselines).
   - File watcher closes; orchestrator advances to `/pm`.

2. **`defer:SVC1,SVC2,...`**:
   - Parse comma-separated service list. For each deferred service, look up the entry in architecture.yaml.apps.\*.integrations by id.
   - Load reasons from `docs/credentials-checklist.md § Deferred` (user was expected to add one-line rationales there before confirming). If any deferred service has no rationale, warn but don't block — use placeholder `"no rationale provided"`.
   - If any deferred service has `requiredNow: true`, log a RED warning: `"/build-backend will fail at runtime if SERVICE_X remains unset. Continuing anyway per user directive."`
   - Build output with `decision: "defer"`, populate `servicesDeferred` + `deferralReasons`.
   - Write `docs/credentials-captured.json` + advance.

3. **`abort`**:
   - Build output with `decision: "abort"`.
   - Save resumable checkpoint (context snapshot at current state; task 013's `/save-context`) so re-running `/architect` onwards is cheap.
   - Orchestrator exits with code 2 (user-initiated abort, not failure).

**Security properties:**

- Orchestrator NEVER reads `.env`. Stat-only (`fs.statSync`), which reveals existence but not contents.
- Architect NEVER reads `.env`. Same posture, enforced by agent tool list + block-dangerous.sh.
- `.env` is user-only from first creation through build. Reviewer (032) scans built code for leaked secret-prefixed keys, which is the final line of defense.
- `.env.example` is world-readable (no secrets in it — just placeholders + comments). Best-effort chmod 0644 when the filesystem supports it; Windows NTFS default user-scoping is fine.
- `.env` permissions are user's responsibility in their own filesystem. `.gitignore` in every project already excludes `.env` (018b scaffold guarantees this).

**Windows permissions note:** On Windows, `fs.chmodSync(0o600)` on `.env` is a no-op (NTFS uses ACLs, not POSIX perms). Architect's `.env.example` chmod gets swallowed silently; `.env` ends up with default user-scope NTFS perms, which is fine for local dev. CI/CD environments typically run on Linux where POSIX perms do apply — relevant for future auto-deploy flows that inject secrets. Not a v1 concern.

### Gate toggling config

```yaml
# config/pipeline.yaml (refactor-003)
stages:
  analyze: { gateEnabled: true } # gate 1
  skills-audit-design: { gateEnabled: false }
  mockups: { gateEnabled: true } # gate 2
  stylesheet: { gateEnabled: true } # gate 3
  screens: { gateEnabled: false } # no gate — /visual-review runs directly after
  visual-review: { gateEnabled: false } # no gate — feeds user-flows
  user-flows: { gateEnabled: true } # gate 4 — design sign-off; never disable in autonomous mode
  architect: { gateEnabled: true } # gate 5 — credentials file-drop; never disable in autonomous mode
  pm: { gateEnabled: false }
  skills-audit-build: { gateEnabled: false }
  register-mcp-build: { gateEnabled: false }
  build-backend: { gateEnabled: false }
  build-web: { gateEnabled: false }
  build-mobile: { gateEnabled: false }
  test: { gateEnabled: false }
  review: { gateEnabled: false }
  git: { gateEnabled: false }
```

Config keys match the stage names in 035's `STAGES` array exactly. Gate 4's key is `user-flows` (was `screens` in the pre-refactor blueprint); the sign-off gate moved to its own stage when `/visual-review` was inserted. The old `screens: { gateEnabled }` key is removed — keeping it would be an active foot-gun now that `screens` has no gate.

Gate 5's key is `architect` (refactor-003). The credentials file-drop fires AFTER the architect stage completes; the orchestrator file-watches `docs/credentials-confirmed.txt` before advancing to `pm`. Setting `architect.gateEnabled: false` in autonomous mode would skip credential capture entirely — builders would run with no `.env`, fail loudly, and the pipeline would stop with no graceful remediation path. The config schema rejects this (see §Gate toggling validation below).

### Retry loop

On gate rejection with feedback:

1. Orchestrator increments a per-stage retry counter
2. Re-invokes the upstream stage with the feedback injected into the prompt
3. Waits for stage completion → re-validates → re-opens gate
4. Abort if retries hit 3

Per-gate retry counters are independent. Gate 2 retries the `/mockups` stage; gate 4 retries the `/screens → /visual-review → /user-flows-generator` sequence. Visual-review's own per-screen retry budget (from 025b) is separate and runs inside the `/screens → /visual-review` loop — it doesn't consume gate 4's outer budget.

### Budget Enforcement — reserve-commit pattern

From blueprint lines 2253-2271:

```ts
interface Budget {
  totalCapUsd: number; // from architecture.yaml.tooling.budget
  totalImageGenCalls: number; // only enforced when --nanobanana active
  consumedUsd: number;
  imageGenCallsUsed: number;
  reserve(agent: string, estimatedUsd: number): ReservationId;
  commit(id: ReservationId, actualUsd: number): void;
  release(id: ReservationId): void; // on failure — don't charge
}
```

Pattern: every MCP call wrapped in `reserve() → external call → commit(actualCost)` or `release()` on failure. The orchestrator aborts the pipeline if a reservation would exceed the cap.

Per-server budgets (e.g., `image-generator: { max_calls: 50 }` in architecture.yaml) are enforced at the reservation step — the orchestrator rejects a reservation if the per-server count would exceed its cap, even when the overall budget has room.

### Feature-flag budget gating

When `--nanobanana` is inactive for the run, `image-generator` is omitted from `.mcp.json` (task 041) and the orchestrator does not enforce `totalImageGenCalls` — no image-gen will happen. When active, enforce strictly; on exhaustion the orchestrator aborts the CURRENT stage with a structured error and surfaces a recommendation to re-run with a higher cap.

### Sign-off Detection (file watcher)

Orchestrator watches three paths during their respective gates (refactor-003 adds the third):

1. `docs/selected-style.json` — gate 2 resolution
2. `docs/signoff-*.json` — gate 4 resolution
3. `docs/credentials-confirmed.txt` — gate 5 resolution (file-drop, no HTTP server)

`chokidar` or built-in `fs.watch`; poll interval acceptable (~500ms) since these files are human-rate writes.

Orchestrator does NOT poll the HTTP servers — they push state to disk, orchestrator watches disk. This decoupling means the orchestrator survives an ephemeral HTTP-server crash (spin up a new one; the file watch still resolves when the user re-POSTs from the browser). Gate 5 has no HTTP server at all — the file-watch is the entire gate mechanism.

## Integration Points

- **Task 023** (/mockups): emits `docs/mockups/index.html` with `{{GATE_API_BASE}}` placeholder; this gate's server hosts the endpoints it calls
- **Task 024** (/stylesheet): produces the Storybook that gate 3 opens
- **Task 025** (/screens + /user-flows-generator): emits `docs/user-flows.html` with `{{GATE_API_BASE}}` placeholder; this gate's server hosts `/api/signoff`
- **Task 025b** (/visual-review): produces `docs/visual-review/report.json` that gate 4 hash-checks
- **Task 034b** (schemas): `SelectedStyleSchema`, `Signoff`, `Dials` — all runtime-validated at gate endpoints
- **Task 035** (orchestrator): invokes gates via `onGate` callbacks; manages retry counters; signals advance based on file watch
- **Task 041** (MCP registration): passes active flag set to orchestrator; feature-flagged servers absent from `.mcp.json` when flag is off
- **Task 020** (/architect — refactor-003): emits `.env.example` + `docs/credentials-checklist.md` + `docs/deployment-checklist.md` + (re-runs) `docs/credentials-diff.md` that gate 5 surfaces to the user in its "review these files" preamble

## Acceptance Criteria

- [ ] **Five** gates implemented: `requirements`, `mockups`, `design-system`, `signoff`, `credentials` (refactor-003)
- [ ] Gate 2 + gate 4 each spin a backing HTTP server (dynamic port) with the endpoints above
- [ ] Gate 5 has NO backing HTTP server — pure file-drop via `docs/credentials-confirmed.txt`
- [ ] Gate 2 `POST /api/dials/{styleId}` validates against `Dials`; fsync-writes dials.yaml; returns persisted values
- [ ] Gate 2 `POST /api/select` validates → writes `docs/selected-style.json` (SelectedStyleSchema) → archives losing styles → returns payload → triggers server shutdown
- [ ] Gate 4 `POST /api/signoff` validates Signoff → recomputes BOTH hashes → verifies uiKitVersion matches `packages/ui-kit/package.json` → writes signoff-{ts}.json
- [ ] Gate 4 rejects with `stale: "screens" | "visual-review" | "ui-kit"` on any drift
- [ ] Gate 5 file-watches `docs/credentials-confirmed.txt`; parses `proceed` / `defer:A,B` / `abort` directives
- [ ] Gate 5 writes `docs/credentials-captured.json` (`CredentialsGateOutput` schema) with decision + services confirmed/deferred + `envFileExists` stat result
- [ ] Gate 5 NEVER reads `.env` — uses `fs.statSync` for existence only; orchestrator + architect agents have no `.env` read path
- [ ] Gate 5 prints terminal instructions including exact shell commands for `proceed` / `defer` / `abort`
- [ ] Gate 5 re-prints "Waiting for docs/credentials-confirmed.txt..." every 60s as a soft reminder
- [ ] Gate 5 `abort` path writes a resumable context checkpoint and exits with code 2
- [ ] Gate 5 `defer` path warns in RED when a deferred service has `requiredNow: true` in architecture.yaml but allows advance per user directive
- [ ] Gate 1 + gate 3 are pure CLI approvals (no HTTP server)
- [ ] Gate 3 opens Storybook + design-system-preview.html in browser
- [ ] Gate toggling via `config/pipeline.yaml`; gate 4 documented as "never disable in autonomous mode"; gate 5 documented as "never disable in autonomous mode" — builders have no `.env` otherwise
- [ ] Retry-with-feedback: max 3 retries per gate; retry counters independent across gates
- [ ] Visual-review's per-screen retry budget (025b) runs inside the design loop and does NOT count against gate 4's outer retry budget
- [ ] Budget reserve-commit pattern implemented per blueprint L2253-2271
- [ ] Per-server budgets enforced at reservation step
- [ ] `--nanobanana` flag gating: when off, `totalImageGenCalls` is not enforced and image-generator is not provisioned
- [ ] Pipeline aborts with structured error when budget exceeded mid-stage
- [ ] File watcher detects `docs/signoff-*.json` and `docs/selected-style.json`; orchestrator advances on `approved: true`
- [ ] `{{GATE_API_BASE}}` mechanism documented (env var to skill OR template placeholder at render time)
- [ ] JSON-Schema validators for Signoff and SelectedStyle (exported by 034b) used at endpoint handlers

## Human Verification

1. Run through the full pipeline with all gates enabled. Does each gate open its expected artifact in the browser and wait for the relevant file write?
2. At the mockup gate, edit dials and pick a style. Is `docs/selected-style.json` written correctly? Are losing style directories archived?
3. At the sign-off gate, submit the form. Now hand-edit a screen under `docs/screens/` and resubmit (simulate a stale form). Does the server reject with `stale: "screens"`?
4. Bump `packages/ui-kit/package.json.version` between sign-off load and submit. Does the server reject with `stale: "ui-kit"`?
5. Reject at the mockup gate with feedback "accent too muted." Does the orchestrator re-invoke `/mockups` with the feedback in the prompt?
6. Hit the per-server image-generator budget. Does the orchestrator abort the current stage with a clear message?
7. Disable gate 3 in config. Does the pipeline auto-advance past design-system review?
