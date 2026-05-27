# Reviewer Playbook — 7 dimensions, concrete pass/fail criteria

This is the operational reference for the `reviewer` agent (see `.claude/agents/reviewer.md` + `.claude/skills/reviewer/SKILL.md`; scaffolding at `scaffolding/18-032-reviewer-agent.md`). Every review fires against these 7 dimensions. Every flagged issue cites the relevant section + concrete criterion. "Looks off" is never a finding; every finding names an exact tool invocation, an exact threshold, and an exact retry target.

**Binding contract**: this file is the stable reference. Stack skills' `§Review` / `§Gotchas` blocks add stack-specific checks ON TOP of these 7 dimensions — they don't replace them.

**Scope**: reviewer runs on the diff introduced by ONE feature's branch (`git log --oneline main..HEAD` inside the worktree). Not whole-repo. Not retroactive on prior features.

**Verdict model**:

- `pass` — dimension passed all its criteria
- `fail` — ≥1 criterion failed with a clear retry target
- `skipped` — tooling unavailable (e.g., no Lighthouse in scratch, no axe-core installed); surfaced as `warnings[]` entry, not counted as fail

**Overall verdict composed from dimension results**:

- `approved` — zero fails (skipped + warnings OK)
- `needs-revision` — ≥1 fail with actionable retry target (builder retry ladder max 3)
- `blocked` — spec contradiction (e.g., brief says "GDPR required" but architecture.yaml says `compliance.gdpr: false` — needs human)

---

## 1. Architecture adherence

### What it checks

Committed code matches the decisions in `architecture.yaml`. Vendors wired as spec'd; stack slots match the app directories; tasks.yaml feature statuses agree with git history.

### Tool invocation

```bash
# For each integration in architecture.yaml.apps.*.integrations with deployment:vendor|self-hosted:
grep -rE "<vendor-package-name>" apps/ packages/ | head -5
# ...expected: ≥1 import per vendor that's required-now

# Stack slot alignment:
test -d apps/api && test "$(yq .tooling.stack.backend_framework .claude/architecture.yaml)" != "null"
# ...repeat for web, mobile

# tasks.yaml status agreement:
node -e "
  const tasks = yaml.load(fs.readFileSync('docs/tasks.yaml','utf8'));
  const completed = tasks.features.filter(f => f.status === 'completed');
  for (const f of completed) {
    const mergeSha = execSync(\`git log --oneline main | grep 'Merge \${f.branch}:' | head -1\`).toString();
    if (!mergeSha) throw new Error(\`Feature \${f.id} is status:completed but has no merge commit on main\`);
  }
"

# Backend dev-server boot probe (bug-111 — when apps/api/ exists, the canonical
# spawn must produce an importable app module). Stack-specific probe; see the
# per-backend stack skill's §Review block for the exact command. For
# python-fastapi:
test -d apps/api && (cd apps/api && PYTHONPATH=src uv run python -c "import importlib; importlib.import_module('api.main')")
# ...expected: exit 0. Failure with ModuleNotFoundError: No module named
# 'api.main' → backend layout drift (e.g. main.py at wrong path); cascades to
# verifier + fix-loop blindspots. The PYTHONPATH=src prefix mirrors uvicorn's
# --app-dir src flag (without it the probe trips on every project).
```

### Pass threshold

- Every non-declined integration has ≥1 import in committed code
- Every non-null `tooling.stack.{tier}_framework` has a corresponding `apps/{tier}/` directory populated
- Every `features[].status === "completed"` has a corresponding `Merge {branch}:` commit on main
- For projects with `apps/api/`: the canonical dev-server spawn produces an importable app module per the per-stack §Review boot probe (bug-111). Non-booting backends cascade-skip Tiers 3+4+5 in `/build-to-spec-verify` and mask every downstream check.

### Known-gap (deferred)

- Stack-slug → concrete file-structure validator (e.g., NestJS canonical module layout per §Canonical layout): deferred to stack skills' own §Review blocks. Reviewer cites the stack skill's section when it fires; if the stack skill lacks §Review, reviewer flags `stack-review-block-missing` as a warning.

### Retry target

- Missing vendor import → `backend-builder` / `web-frontend-builder` / `mobile-frontend-builder` (whichever owns the file) with the specific task ID
- Missing `apps/{tier}/` dir when framework is non-null → `backend-builder` (usually caught by infra-scaffolding feature retry)
- Completed feature without merge → orchestrator wiring bug, not a retry target; flag as `blocked`
- Backend boot probe fails with `ModuleNotFoundError` / `Cannot find module` → `backend-builder` with the exact module path from the error message and a reference to the stack skill's canonical layout (bug-111)

---

## 2. Security

MVP checklist — 15 items. ASVS L1 full expansion is deferred to `post-mvp-scaffolding/security-checklist-grounding.md`.

### 2.1 SQL injection

**Invocation**: `grep -rnE "(SELECT|INSERT|UPDATE|DELETE)[^;]*\\\$\\{" apps/api/src/`
**Threshold**: zero hits (no string-interpolated SQL)
**Acceptable**: prepared statements, ORM parameterization (`prisma.user.findUnique`, SQLAlchemy query builder, etc.)
**Retry target**: backend-builder

### 2.2 XSS

**Invocation**: `grep -rn "dangerouslySetInnerHTML" apps/web/src/ apps/admin/src/`
**Threshold**: zero hits OR every hit is followed within 5 lines by a DOMPurify/sanitize call (grep context check)
**Retry target**: web-frontend-builder / mobile-frontend-builder

### 2.3 Auth bypass

**Invocation**: for each protected route in architecture.yaml, confirm its router file wires auth middleware:

```bash
grep -rn "authMiddleware\|requireAuth\|@UseGuards" apps/api/src/{auth,users,payments,...}/
```

**Threshold**: every non-public route has at least one auth-guard reference (grep match)
**Acceptable**: global guards (e.g., NestJS `APP_GUARD` provider with `AuthGuard`) count — confirm via `app.module.ts`
**Retry target**: backend-builder

### 2.4 CSRF

**Invocation**:

```bash
# Cookie SameSite=strict OR explicit CSRF token middleware:
grep -rnE "sameSite:\\s*['\"]strict|csrfToken|csurf" apps/api/src/ apps/web/src/
```

**Threshold**: state-changing POST routes have SameSite=strict cookies OR CSRF-token middleware
**Retry target**: backend-builder (middleware) / web-frontend-builder (form token)

### 2.5 Rate limiting

**Invocation**:

```bash
# Rate-limit middleware on auth + password-reset + payment endpoints:
grep -rnE "RateLimit|rate-limit|@Throttle" apps/api/src/{auth,payments}/
```

**Threshold**: login / password-reset / payment-webhook routes each have a rate-limit decorator or middleware
**Retry target**: backend-builder

### 2.6 Secret leakage

**Invocation**:

```bash
# No source file imports .env:
grep -rnE "require\\(['\"]\\.env['\"]|import.*from.*['\"]\\.env['\"]" apps/ packages/
# No hex-like strings that look like API keys (false-positive tolerable — human review):
grep -rnE "['\"][0-9a-fA-F]{32,}['\"]" apps/ packages/ | grep -vE "\\.test\\.|schema\\.prisma|migration\\.sql|\\.lock"
```

**Threshold**: zero `.env` imports in committed source; zero hardcoded hex strings ≥32 chars that look like keys
**Retry target**: backend-builder (main offender) / any builder

### 2.7 SSRF

**Invocation**:

```bash
# Any user-supplied URL passed to fetch/axios/got must go through an allow-list:
grep -rnE "fetch\\(req\\.|axios\\.(get|post)\\(req\\.|got\\.(get|post)\\(req\\." apps/api/src/
```

**Threshold**: zero hits OR every hit is preceded within 10 lines by a URL allow-list check (`new URL(...); if (ALLOWED_HOSTS.includes(parsed.host))`)
**Retry target**: backend-builder

### 2.8 CORS misconfig

**Invocation**:

```bash
grep -rnE "origin:\\s*['\"]\\*['\"]|Access-Control-Allow-Origin.*\\*" apps/api/src/
```

**Threshold**: zero `*` on credentialed endpoints (any route with `credentials: true` OR cookie-bearing routes). Public read-only GETs may allow `*`.
**Retry target**: backend-builder

### 2.9 Input validation

**Invocation**:

```bash
# Every endpoint's body/params/query validated via Zod/Pydantic/etc:
grep -rnE "(z\\.|Pydantic|BaseModel|Zod)" apps/api/src/ | wc -l
```

**Threshold**: ratio of validation-schema occurrences to route definitions ≥1.0 (each route validates). Stack skill's §Testing names the validator import.
**Retry target**: backend-builder

### 2.10 Output encoding

**Invocation**:

```bash
# No raw HTML concatenation in frontend:
grep -rnE "\\.innerHTML\\s*=|outerHTML\\s*=" apps/web/src/ apps/admin/src/
# No raw SQL string-interp (covered by 2.1 too, double-check):
grep -rnE "query\\([^,]*\\\$\\{" apps/api/src/
```

**Threshold**: zero hits
**Retry target**: web-frontend-builder / backend-builder

### 2.11 Crypto misuse

**Invocation**:

```bash
grep -rnE "createHash\\(['\"]md5['\"]\\)|createHash\\(['\"]sha1['\"]\\)|Math\\.random\\(\\)" apps/ packages/ | grep -vE "\\.test\\."
```

**Threshold**: zero hits in non-test source (MD5/SHA1 for new code is verboten; `Math.random()` for tokens/nonces is verboten — use `crypto.randomBytes` / `crypto.getRandomValues`)
**Retry target**: backend-builder (crypto)

### 2.12 Session fixation

**Invocation**: grep auth flow for session regeneration after successful login:

```bash
grep -rnE "regenerate|req\\.session\\.regenerate|session\\.id\\s*=\\s*uuid" apps/api/src/auth/
```

**Threshold**: ≥1 hit on the login handler OR the auth provider (Auth0/Cognito) is known to regenerate internally (documented in architecture.yaml integrations.auth)
**Retry target**: backend-builder

### 2.13 IDOR (Insecure Direct Object Reference)

**Invocation**: for every endpoint that reads a record by ID, grep for ownership check:

```bash
# Flag endpoints that take a user-supplied :id without filtering by req.user.id:
# Manual walk: grep -rn "findUnique.*where.*id" and confirm next 5 lines contain req.user.id OR role:"admin" check
```

**Threshold**: every record-by-ID endpoint either filters by requesting user OR has explicit admin-role check
**Retry target**: backend-builder

### 2.14 File-upload abuse

**Invocation**:

```bash
grep -rnE "multer|multipart|uploadStream" apps/api/src/
# ...for each match, confirm nearby code validates extension + MIME + size
```

**Threshold**: every upload endpoint validates extension (whitelist), MIME (via magic-bytes, not Content-Type), and size caps. Virus-scan optional (vendor choice per architecture.yaml; absence ≠ fail).
**Retry target**: backend-builder

### 2.15 Rate-limit bypass

**Invocation**: confirm rate-limit middleware keys on BOTH IP + user-id where applicable:

```bash
grep -rnE "rateLimit.*keyGenerator|rateLimit\\(.*req\\.user\\.id.*req\\.ip" apps/api/src/
```

**Threshold**: rate-limit middleware uses a composite key (user-id + IP) OR keys on user-id for authed endpoints and IP for unauth
**Retry target**: backend-builder

### Known-gap (deferred)

- Full ASVS L1 checklist (detailed 130+ controls) → `post-mvp-scaffolding/security-checklist-grounding.md`
- Automated SAST scan (semgrep, snyk, trivy) → deferred to CI layer; reviewer limits to grep-based patterns
- Dependency CVE scan → CI-layer concern

---

## 3. Compliance (per brief §14 + architecture.yaml.compliance)

### What it checks

Every compliance flag in `architecture.yaml.compliance` (and each brief §14 entry) has corresponding code shipped.

### Tool invocation

```bash
# GDPR consent:
if $(yq '.compliance.gdpr' .claude/architecture.yaml) = true; then
  grep -rnE "cookieConsent|consentBanner|ConsentProvider" apps/web/src/ apps/mobile/src/
  grep -rnE "gdpr-export|/api/users/me/export|/api/export-my-data" apps/api/src/
  grep -rnE "gdpr-delete|/api/users/me/delete|right-to-erasure" apps/api/src/
fi

# COPPA age-gate:
if $(yq '.compliance.coppa_under_13' .claude/architecture.yaml) = "excluded"; then
  grep -rnE "age.gate|ageVerification|dateOfBirth.*< 13|minAge" apps/web/src/ apps/mobile/src/
fi

# Privacy policy + terms URLs referenced:
grep -rnE "privacy.?policy|terms.?of.?service|privacyPolicyUrl|termsUrl" apps/
```

### Pass threshold

- GDPR (if flagged): cookie banner component + export endpoint + delete endpoint all present (≥1 grep match each)
- COPPA (if excluded): age-gate logic in signup flow (≥1 grep match)
- Privacy policy + terms URLs: referenced in footer / settings / signup flow (≥1 match)
- KYC/AML (if flagged): Stripe Identity (or equivalent) SDK imported (≥1 match in payments module)

### Known-gap (deferred)

- DPIA (Data Protection Impact Assessment) document generation → future; reviewer flags "DPIA not present" as warning, not fail, if `compliance.gdpr: true` + no `docs/dpia.md`
- Automated compliance test suite (simulating GDPR export flow end-to-end) → would belong in tester's integration tests; reviewer doesn't run simulations

### Retry target

- Missing consent/export/delete endpoint → backend-builder + web-frontend-builder / mobile-frontend-builder
- Missing age-gate UI → web-frontend-builder / mobile-frontend-builder
- Missing privacy/terms URLs → web-frontend-builder / mobile-frontend-builder (or architect if the URLs are expected from architecture.yaml.compliance.required_assets but never materialized)

---

## 4. Maintainability

### What it checks

Code quality signals the test suite doesn't cover: types, lint, docs, dead code.

### Tool invocation

```bash
# Typecheck across all packages:
pnpm -r typecheck
# Lint:
pnpm -r lint
# TODO / FIXME / XXX / HACK:
grep -rnE "^\\s*//\\s*(TODO|FIXME|XXX|HACK)|/\\*\\s*(TODO|FIXME|XXX|HACK)" apps/ packages/ | grep -v ".test."
# any type without justification comment:
grep -rnE ":\\s*any\\b" apps/ packages/ | grep -v ".test." | grep -v "// eslint-disable-next-line" | grep -v "// any OK because"
# Dead imports / unused exports (via knip OR tsc's noUnusedLocals already enabled):
pnpm dlx knip --reporter compact
```

### Pass threshold

- `pnpm -r typecheck` exit 0
- `pnpm -r lint` exit 0 (rules include `eslint-plugin/no-deep-imports`, `no-hex-in-className`, etc. per ui-kit contract)
- Zero TODO/FIXME/XXX/HACK in non-test source
- Zero `: any` without inline-comment justification in non-test source
- `knip` reports zero unused exports + zero dead dependencies (warnings OK)
- Public API (exports in `packages/types/`, `packages/api-client/`, service layer) has JSDoc — grep-threshold: ≥80% of exported symbols have a `/** */` block above (spot check)

### Known-gap (deferred)

- Complexity metrics (cyclomatic, cognitive) → future; reviewer doesn't measure
- Mutation testing (Stryker) → `post-mvp-scaffolding/mutation-testing-policy.md`

### Retry target

- Typecheck / lint failures → whoever wrote the file (grep `git blame` for the line)
- TODO in shipped code → that file's last-writing agent
- `any` without justification → same
- Missing JSDoc → builder who owns the exported symbol

---

## 5. A11y (MVP depth)

Full axe-core integration deferred to `post-mvp-scaffolding/a11y-deep-coverage.md`. This is the grep-level MVP.

### What it checks

Focus management, keyboard reachability, semantic landmarks, form labels — the ~80% of real a11y bugs caught at near-zero cost.

### Tool invocation

```bash
# :focus-visible exists on interactive CSS:
grep -rnE ":focus-visible" apps/web/ apps/mobile/ packages/ui-kit/
# Every onClick has onKeyDown OR is a <button>:
# Manual spot-check: grep for onClick and scan context for onKeyDown or <button>
grep -rn "onClick" apps/web/src/ apps/mobile/src/
# Semantic landmarks:
grep -rE "<main|<header|<nav|<footer|<aside" apps/web/src/
# Form labels:
grep -rnE "<input[^>]*(?:id=|name=)" apps/web/src/ | head -20
# ...for each match, confirm a <label> exists nearby with matching htmlFor / wrapping

# No redundant ARIA on native elements:
grep -rnE "role=['\"]button['\"]|aria-pressed" apps/web/src/ | grep -E "<button|<Button" && echo "FLAG: redundant ARIA on native <button>"
```

### Pass threshold

- `:focus-visible` present in kit + at least one screen's CSS (ui-kit owns most of this by default)
- Every `onClick` handler attached to a non-`<button>`/non-`<Button>` element also has `onKeyDown` OR a `role` + `tabIndex` (grep context)
- Every page has exactly one `<main>` landmark; no nested `<main>`s; `<header>`/`<nav>`/`<footer>` used appropriately
- Every form `<input>` has an associated `<label>` (via `htmlFor` matching `id` OR wrapping)
- No redundant ARIA on native semantic elements (e.g., `<button role="button">` is wrong)

### Known-gap (deferred)

- Axe-core automated scanning (runs 100+ rules) → `post-mvp-scaffolding/a11y-deep-coverage.md`
- VoiceOver / TalkBack flow testing → E2E scope, not reviewer's
- Color contrast — already covered at visual-review time (gate-4 rubric); reviewer doesn't re-check

### Retry target

- Focus / keyboard / landmarks / labels → web-frontend-builder (web-specific) / mobile-frontend-builder (RN variants: Pressable has implicit keyboard handling on web; native differs)

---

## 6. Performance signals

### What it checks

Coarse regressions that could ship by accident. Fine-grained optimization is out of scope (engineers should use flame graphs, not reviewers).

### Tool invocation

```bash
# Web bundle-size diff (if Next.js, vite, webpack):
pnpm --filter @repo/web build 2>&1 | grep -E "Size|chunks|kB|MB"
# Compare against baseline committed at packages/web/.bundle-size-baseline.json (stack-skill may seed this)

# LCP via Lighthouse (requires dev server + Chrome):
# Skip gracefully if Lighthouse CLI not installed: reviewer emits dimensions.performance.status: "skipped" with reason.
npx @lhci/cli autorun --collect.url=http://localhost:3000 --collect.numberOfRuns=1 2>&1 | grep "largest-contentful-paint"

# Mobile bundle size (Expo):
npx expo export 2>&1 | grep -E "bundle|Hermes"

# Backend p95 endpoint response time:
# Requires a running dev server + a fixture workload.
# npx artillery quick --count 20 --num 50 http://localhost:4000/health | grep "p95"
```

### Pass threshold

- Web bundle: ≤5% size growth vs baseline (if baseline exists)
- LCP: ≤2.5s on Lighthouse for home route (if Lighthouse available)
- Mobile bundle: no specific threshold for MVP; reviewer reports the measurement as warning-level
- Backend p95: ≤200ms on `/health` + 1-2 primary endpoints (if artillery + dev server available)

### Known-gap (deferred)

- **Most perf checks require a running dev server** which scratch-repos + first-run pipelines don't have. Reviewer SKIPS this dimension (`status: "skipped"` + `reason: "no dev-server available"`) when tooling is missing. Not a fail.
- CI-level perf regression (Lighthouse CI in GitHub Actions) → part of `post-mvp-scaffolding/ci-cd-deploy-automation.md` work
- Production monitoring (real-user metrics, Grafana Cloud dashboards) → architecture.yaml.integrations.monitoring scope; reviewer confirms the vendor is wired but not the dashboards

### Retry target

- Bundle-size regression → builder that wrote the regressing file (usually web-frontend-builder)
- LCP degradation → web-frontend-builder
- Backend p95 regression → backend-builder

---

## 7. Brief-delivery

### What it checks

Static cross-reference: `tasks.yaml.features[]` vs committed code vs brief §11 catalog. Does the code deliver what the plan promised? Runtime walkthrough (option B) is deferred to `post-mvp-scaffolding/brief-delivery-validation-depth.md`; this is option A (static analysis).

### Tool invocation

```bash
# For every feature.status === "completed":
#   - resolve each task's integration_ref to a real import in committed code
#   - confirm the task.summary appears in a commit message on the feature's merge chain
node scripts/audit-brief-delivery.mjs --feature=<feature-id>
# (This script doesn't exist yet — reviewer implements it inline OR uses existing grep workflow)

# Brief §11 catalog → tasks.yaml features[] coverage:
# Walk brief.md §11 entries; confirm each maps to a tasks.yaml features[].id OR appears in docs/deferrals.md
```

### Pass threshold

- Every completed feature's integration_ref paths resolve to at least one import in committed code
- Every completed feature's task.summary content appears in at least one commit on the feature's merge chain
- Every brief §11 catalog entry has either a features[] entry (even if status: pending) OR a documented deferral

### Known-gap (deferred)

- Runtime walkthrough of every P0 feature (hitting endpoints, clicking through UI) → `post-mvp-scaffolding/brief-delivery-validation-depth.md`
- Semantic equivalence check (LLM reading feature summary + the code + deciding whether they match) → would need a separate sub-agent; reviewer uses grep heuristics for MVP
- `scripts/audit-brief-delivery.mjs` as a first-class runner → future; reviewer does the grep inline OR in feat-010 Phase 3 we author the script

### Retry target

- Missing integration import → backend-builder / frontend-builder (the file the task targeted)
- Task summary doesn't match committed code (e.g., task says "Stripe webhook" but code only has Stripe checkout) → builder (implementation drift) OR pm (tasks.yaml features[] grouped wrongly; summary inaccurate)
- Brief §11 entry without a features[] mapping → pm (plan gap — PM should have produced a features[] entry) OR architect (integration missing from architecture.yaml)

---

## 8. Design conformance (feat-054)

Compare the built JSX tree against the matching mockup HTML. The mockup
at `docs/screens/webapp/<screen-id>.html` is the binding layout contract;
the built page MUST mirror its kit-component nesting at the layout
primitive level.

### Specific checks for any new file under `apps/web/app/**/page.tsx`

1. **Layout primitive present.** If the mockup's root has
   `data-kit-component="AppShell"` (or stack-equivalent), the JSX MUST
   import + use the matching primitive from `@repo/ui-kit` (typically
   `<AppShell sidebar={...} header={...}>`). **Empirical evidence**: 22
   shell-stripping P0 bugs surfaced on finance-track-01 (2026-05-05) because
   every page skipped this wrap. PM mandate (feat-051) is the primary
   prevention; per-feature parity-smoke (feat-052) is the secondary
   catch; THIS dimension is the tertiary defense-in-depth.

2. **Primary nav consistency.** If the mockup's `<aside data-kit-component="Sidebar">`
   contains nav links to other routes, the JSX MUST render the same
   sidebar via either the AppShell's `sidebar` slot OR a direct
   `<Sidebar>` import.

3. **Topbar consistency.** Same shape: if mockup has
   `<header data-kit-component="TopBar">` containing global actions
   (display-currency switcher, refresh, etc.), JSX MUST surface them
   via the AppShell `header` slot OR equivalent.

### Output (when divergence found)

```json
{
  "dimension": "design-conformance",
  "severity": "P0",
  "screen": "<screen-id>",
  "missing": ["AppShell"],
  "remediation": "wrap rendered content in <AppShell sidebar={...} header={...}> per docs/screens/webapp/<screen-id>.html"
}
```

### Cross-reference

The matching primitive's import surface lives in
`packages/ui-kit/src/layouts/app-shell/`. The stack-skill at
`.claude/skills/agents/front-end/react-next/SKILL.md` §AppShell wrapping
documents the canonical composition. Reviewer flags = web-frontend-builder
retry per the genuine-bugs ladder.

### Defense-in-depth posture

This dimension is **defense-in-depth**. The PRIMARY enforcement point is
feat-051's PM-mandate task template (catches at PM-emit time); feat-052's
per-feature parity-smoke catches at close-feature time; this reviewer
dimension catches at reviewer dispatch time. All 3 layers together
target ~99% pre-merge catch rate for the shell-stripping class.

### Retry target

- Missing AppShell wrap on `apps/web/app/**/page.tsx` → web-frontend-builder
  (the page that owns the route)
- Sidebar/TopBar surface mismatch → web-frontend-builder
- Mockup's data-kit-component attribute doesn't appear in built tree →
  web-frontend-builder

---

## Cross-reference index

| Dimension                    | Post-MVP deferral file                                    |
| ---------------------------- | --------------------------------------------------------- |
| 2 Security                   | `post-mvp-scaffolding/security-checklist-grounding.md`    |
| 4 Maintainability (mutation) | `post-mvp-scaffolding/mutation-testing-policy.md`         |
| 5 A11y (deep)                | `post-mvp-scaffolding/a11y-deep-coverage.md`              |
| 6 Performance (CI/CD)        | `post-mvp-scaffolding/ci-cd-deploy-automation.md`         |
| 7 Brief-delivery (runtime)   | `post-mvp-scaffolding/brief-delivery-validation-depth.md` |

## Versioning

This playbook's shape is the operational contract reviewer depends on. Changes to the 7 dimensions go through a named refactor-NNN plan (e.g., refactor-005 authored this playbook). Minor additions to an individual dimension's criteria list are in-file edits; structural changes (adding/removing dimensions) need a plan.

Current version: **1.0** (authored by refactor-005-reviewer-alignment, 2026-04-23).
