---
id: bug-008-screens-preamble-external-cdn-urls
type: bug
status: archived
outcome: success
author-agent: Claude (post-investigate-004)
created: 2026-05-30
updated: 2026-05-30
closed-at: 2026-05-30
parent-plan: investigate-004-e2e-stall-mode-b-run-2
supersedes: null
superseded-by: null
branch: fix/screens-preamble-local-placeholders
affected-files:
  - .claude/skills/screens/SKILL.md
  - .claude/skills/mockups/SKILL.md
  - .claude/skills/agents/front-end/react-next/SKILL.md
  - scripts/audit-screens-external-cdn-urls.mjs
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: "5 features on test-app Mode B Run 2 cascade-failed E2E tester with wall-clock-1800000ms stalls. Tester-attempt-3 on feat-home correctly diagnosed: 'All 17 E2E tests timeout at page.goto(/) because apps/web/app/page.tsx loads external CDN images (picsum.photos, unsplash.com) that block window.load in Playwright.'"
reproduction-steps: "Run /screens on any project; inspect generated docs/screens/.shared-preamble.md; grep for picsum.photos / images.unsplash.com — present in §'Imagery seed convention' + §'Cross-screen consistency contract' as MANDATED exact URLs with 'NO substitutions' directive. Builder reading the preamble dutifully ports those URLs into apps/web/app/page.tsx; Playwright E2E times out on page.goto because external CDN images block window.load."
stack-trace: null
---

# bug-008-screens-preamble-external-cdn-urls: /screens preamble mandates external CDN URLs (picsum.photos, unsplash.com) that builder ports into production code and break Playwright E2E uniformly

## Bug Description

**Expected behavior**: `/screens` should produce screens HTML and a shared-preamble that prescribe **local placeholder** asset paths (e.g. `/placeholders/avatar-anika.jpg`, `/placeholders/case-study-bloom-900x1100.jpg`) so the builder can port them into production code without breaking Playwright E2E or depending on third-party hosts in production.

**Actual behavior** (per investigate-004 findings Q1): `/screens` generates `docs/screens/.shared-preamble.md` that **explicitly mandates** external CDN URLs:

- §"Imagery seed convention" (line 76): `Hero / content imagery: https://images.unsplash.com/photo-{id}?w={w}&h={h}&fit=crop (real Unsplash IDs) OR https://picsum.photos/seed/hatch-{descriptive-slug}/{w}/{h} for placeholder photos.`
- §"Cross-screen consistency contract" (lines 705-723): prescribes EXACT Unsplash photo IDs for 4 named avatars + EXACT picsum seeds for 6 case-study clients with directive **"NO substitutions. NO different Unsplash photo IDs."**

Every screen HTML carries these URLs verbatim (68 hits across 10 screens in test-app). Builders dutifully port them into production code (221 hits across failed worktrees' `apps/web/app/page.tsx`).

**Why this is a production bug, not just an E2E flake**: even ignoring E2E, the shipped site depends on third-party image hosts for hero imagery, avatars, and case-study photos. picsum.photos is rate-limited; unsplash.com requires API key for commercial use beyond a threshold; both can go down. A production CMS-integration project's chrome should be either local-assets-first OR backed by the project's own image CDN — never raw external placeholders.

## Reproduction Steps

1. Run `/screens` on any project (test-app concrete reproduction case).
2. Read generated `docs/screens/.shared-preamble.md`.
3. Confirm presence of:
   - `https://images.unsplash.com/photo-...` URLs in §"Imagery seed convention"
   - `https://picsum.photos/seed/...` URLs in §"Cross-screen consistency contract"
   - Hard directive "NO substitutions"
4. Read any `docs/screens/webapp/*.html` — confirm same URLs embedded as `<img src="...">`.
5. Run Mode B → web-frontend-builder ports URLs into `apps/web/app/page.tsx` → Playwright E2E times out at 30s on every `page.goto()`.

## Error Output

```
[tester feat-home attempt-3 — taskOutcome failed]
errors.home-e2e: "All 17 E2E tests timeout at page.goto('/') because apps/web/app/page.tsx loads external CDN images (picsum.photos, unsplash.com) that block window.load in the Playwright test environment"

genuineProductBugs[0]: {
  taskId: "home-screen",
  builderAgent: "web-frontend-builder",
  testFile: "apps/web/e2e/home.spec.ts",
  failureMessage: "page.goto: Test timeout of 30000ms exceeded. navigating to 'http://localhost:3000/', waiting until 'load'",
  likelyCause: "apps/web/app/page.tsx embeds many <img> tags with external CDN URLs from picsum.photos and unsplash.com. Playwright's default waitUntil:'load' blocks until ALL resources finish loading. In test environment the external CDNs are unreachable → every test times out at 30s."
}
```

## Root Cause Analysis

**Where the URLs originate**: `/mockups` skill generates style-N mockup HTML using external CDN URLs (this is legitimate for mockup-design-time visual review — Unsplash gives realistic photos for free).

**Where they propagate**: `/screens` skill, when authoring `docs/screens/.shared-preamble.md`, lifts the URLs verbatim from the selected mockup style as the "imagery convention" for builders to follow. This was a deliberate design: mockup→screen→production fidelity. But it conflated **mockup-time placeholder** (legitimate external CDN) with **production-time asset** (must be local).

**Why builder is correct to port them**: the §"Cross-screen consistency contract" explicitly says "NO substitutions. NO different Unsplash photo IDs." Builder following the preamble verbatim IS the contract.

**Where the layer break should sit**: `/screens` is the right surface. Mockups can keep external URLs (visual review benefits from realistic photos). Screens — which feed builders — should map mockup external URLs to local paths AT SCREENS-GENERATION TIME, with a local placeholder-mapping convention.

**Affected pipeline**: every project that goes through Mode A → Mode B will hit this. test-app is the first to surface it because earlier projects' E2E coverage was thin (smoke.spec.ts only) and missed the load-timeout class.

## Fix Approach

Three-part fix (Part A primary; Part B + C reinforce):

### Part A — `/screens` SKILL.md rewrite

In `.claude/skills/screens/SKILL.md`, locate the "shared-preamble authoring" section (search for `shared-preamble.md` or `Imagery seed convention`). Replace the external-CDN-URL directive with:

```markdown
## §Imagery seed convention (post-bug-008)

Production code MUST use local placeholder assets, NOT external CDNs. The screens
HTML you author + the production code the builder writes from it both reference
local `/placeholders/*.jpg` paths.

**Mapping convention**:

- Hero imagery: `/placeholders/hero-{semantic-slug}.jpg` (e.g. `/placeholders/hero-spark-work-bloom.jpg`)
- Avatars: `/placeholders/avatar-{first-name-lower}.jpg` (e.g. `/placeholders/avatar-anika.jpg`)
- Case-study imagery: `/placeholders/case-study-{client-slug}-{aspect}.jpg`
  (e.g. `/placeholders/case-study-bloom-900x1100.jpg`)
- Generic content placeholders: `/placeholders/content-{semantic-slug}.jpg`

**Build-time provisioning**: the builder + tester are responsible for ensuring
`apps/web/public/placeholders/*.jpg` files exist. The web-frontend-builder's
stack skill provides a default placeholder set (a 1×1 SVG-data-URI fallback for
unknown paths, plus the named avatars / hero / case-study mappings).

**Mockup → screen URL rewriting**: if the selected mockup style used
unsplash.com / picsum.photos URLs (legitimate for mockup-time visual review),
this skill REWRITES them into local paths at screens-generation time. The
preamble's §"Cross-screen consistency contract" still names the 4 avatars
(Anika P., Marco L., Priya R., Sam K.) and 6 case-study clients (Bloom Co.,
Northstar, Meridian, Volta Labs, Arch Studio, Leyla Sarno Film), but it
references LOCAL paths, not external URLs.
```

### Part B — `/mockups` SKILL.md note

In `.claude/skills/mockups/SKILL.md`, add a §"External CDN URLs in mockups (post-bug-008)" note:

```markdown
Mockups MAY use external CDN URLs (picsum.photos, unsplash.com) for realistic
visual review at design time. These URLs are NOT carried into production —
`/screens` rewrites them to local `/placeholders/*` paths when generating
the screens HTML. Mockup authors should not pre-emptively switch to local
placeholders; the rewrite happens downstream.
```

### Part C — react-next stack-skill amendment

In `.claude/skills/agents/front-end/react-next/SKILL.md`, in the §"Image policy" (or §"Assets") section, add:

```markdown
**External CDN URLs are forbidden in production code.** `next/image src` and
raw `<img src>` MUST point at local paths under `apps/web/public/placeholders/`
or the project's own image CDN (per architecture.yaml.tooling.image_cdn).
External hosts (picsum.photos, unsplash.com, googleusercontent, etc.) are
NEVER acceptable in committed source. Rationale: they break Playwright E2E
(window.load blocks on unreachable resources), they make production
deployment depend on third-party uptime, and they bypass the project's own
image-CDN integration if one is wired.

Builder default: when the screens HTML references `/placeholders/hero-X.jpg`,
ensure `apps/web/public/placeholders/hero-X.jpg` exists. If unknown placeholder
path, create a 1×1 SVG-data-URI fallback at that path so the build doesn't 404. The tester's regression spec (apps/web/e2e/no-external-images.spec.ts —
shipped via Part D) asserts no `<img src=external>` survives in production HTML.
```

### Part D — mechanical regression test

`scripts/audit-screens-external-cdn-urls.mjs`: grep `docs/screens/**/*.html`

- `docs/screens/.shared-preamble.md` for `(picsum|unsplash|googleusercontent|gravatar)\.(com|photos)`. Exit
  1 with structured findings if any hit. Wire into `/screens` self-verify
  step (mechanical sentinel — same shape as bug-006's audit).

## Rejected Fixes

1. **Bump tester wall-clock cap to 60min** — would let attempt-1 finish 17/17 timeouts faster but doesn't fix the underlying production bug (external CDN dependency in shipped code).
2. **Change Playwright default to `waitUntil: "domcontentloaded"`** — masks the load-blocking; the production page would still try to load picsum/unsplash in users' browsers, blocking real users' load events.
3. **Builder-side rewriting** — making web-frontend-builder swap URLs reactively breaks the screens-fidelity contract; the screens preamble IS the spec the builder reads. The correct layer is /screens (the spec-emitter), not the builder (the spec-reader).
4. **Per-project operator hand-edit** — would unblock test-app Run 3 but doesn't prevent the class from re-surfacing on every new project.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app/docs/screens/.shared-preamble.md` (current state).

**Pass conditions** (after Part A + B + C + D land):

1. New audit script `scripts/audit-screens-external-cdn-urls.mjs` exits 1 on test-app's CURRENT screens (because they predate this fix) — confirms the audit catches the violation.
2. Re-running `/screens` on test-app regenerates docs/screens/ with local /placeholders/ paths; audit now exits 0.
3. After Mode B re-runs on test-app's 5 failed features (feat-home, feat-about, feat-services, feat-case-studies, feat-static-pages), `apps/web/app/page.tsx` for each contains zero external CDN URLs.
4. Playwright E2E specs for those features complete page.goto in <5s (against the network-disconnected agent test).
5. Negative-regression test: hand-edit a clean screens.html to add a picsum URL → audit exits 1.

**Cross-references**:

- `investigate-004` — the parent investigation
- `bug-009` — sibling fix (bug-121 routing miss); shipping both together is what fully recovers the 5 failed features
- `bug-006` — sibling shape: scaffold-emitting-something-wrong + audit script needed
- Brief / shared-preamble files: `projects/test-app/docs/screens/.shared-preamble.md`

## Attempt Log

## <!-- Populated automatically by agents. -->

## Completion Record (2026-05-30)

**Outcome: SUCCESS** — bug-008 four-part screens external-CDN-URL fix shipped + audit empirically catches 69 hits on test-app pre-fix.

### Ship summary

**Part A — `.claude/skills/screens/SKILL.md`**:

- §5 "Imagery convention" rewritten: prescribes `/placeholders/{semantic-slug}.jpg` local paths for hero / avatars / case-study / generic content
- Hard prohibition on 9 forbidden CDN hosts (picsum.photos, images.unsplash.com, googleusercontent.com, gravatar.com, etc.)
- Empirical motivator inline (test-app Mode B Run 2)
- §3.5.2 "Cross-screen consistency contract" updated for canonical avatars + case-study imagery (LOCAL paths only)
- New §8c "Mechanical external-CDN-URL audit" wires the audit script with hard-abort contract mirroring §8a

**Part B — `.claude/skills/mockups/SKILL.md`**:

- Note added clarifying mockups MAY use external CDN URLs (legitimate design-time visual review) but `/screens` rewrites downstream

**Part C — `.claude/skills/agents/front-end/react-next/SKILL.md`**:

- New reviewer dimension under §Review: `performance — external CDN image URLs forbidden (bug-008)`
- Grep-based threshold + retryTarget web-frontend-builder + empirical motivator inline
- Serves as defense-in-depth when upstream fix hasn't reached a particular project

**Part D — `scripts/audit-screens-external-cdn-urls.mjs`**:

- 139 LOC; cross-project agnostic
- 9 forbidden host patterns
- Exit 0 = clean; exit 1 = JSON-structured violations + human summary on stderr
- Validates on test-app pre-fix: **69 hits across 10 files**

### Empirical validation

```
cd projects/test-app && node ../../scripts/audit-screens-external-cdn-urls.mjs
[audit-screens-external-cdn-urls] FAILED — 69 forbidden CDN URL hit(s) across 10 file(s):
  docs/screens/.shared-preamble.md (13 hits at lines 76,77,709-723)
  docs/screens/webapp/about.html (5 hits)
  docs/screens/webapp/case-study-detail.html (13 hits)
  docs/screens/webapp/home.html (11 hits)
  docs/screens/webapp/inquiry-confirmation.html (3 hits)
  docs/screens/webapp/work-index.html (9 hits)
  ...
exit 1
```

Audit detects the class. After operator re-runs `/screens` (or hand-edits the preamble), the audit will exit 0.

### Limitation / operator next-step for test-app

The 4-part fix affects NEW projects + future `/screens` re-runs. For test-app empirical re-validation, the operator either:

- (a) re-runs `/screens` to regenerate `docs/screens/*` with local placeholder paths (clean path)
- (b) hand-edits `docs/screens/.shared-preamble.md` + `docs/screens/webapp/*.html` to swap URLs (quick path; preserves screen layout work)

Then Mode B re-run on the 5 failed features produces builders that emit local-path-only production code → Playwright E2E completes page.goto in <5s. If any product bug remains, bug-009's tester→builder routing catches it.

### Lessons

1. **Pipeline skills that prescribe assets must distinguish design-time visual-review (external CDN OK) from production-time references (local paths required).** The same skill can drive both stages but the asset-host policy MUST be enforced by mechanical audit — prose-only directives propagate verbatim through every downstream consumer (mockups → screens → builder → production HTML).
2. **The 4-part shape (skill amendment + sibling-skill note + reviewer-dimension defense-in-depth + mechanical audit) is reusable for any "scaffold prescribes wrong thing" class.** bug-002-005-006 fit the same pattern; bug-008 codifies it.
3. **Mockup→screen→builder asset-host conflation hides until E2E ships.** Screen rendering in a normal browser shows the external CDN images fine; the bug only manifests under Playwright's `waitUntil:"load"` default. Earlier projects with thin E2E (smoke.spec.ts only) shipped the same class without surfacing it — test-app's deeper E2E was what surfaced it.

### Cross-references

- Empirical motivator: test-app Mode B Run 2 (2026-05-30) feat-home tester-attempt-3 diagnosis
- Parent: investigate-004 (Q1 findings)
- Sibling shipping in same commit: bug-009 (per-task retry-loop routing miss)
- Sibling shape class: bug-002/003/004/005 (prose-only-consumer-rule drift)
- Sibling audit-script-needed class: bug-006 (PM affects_files overlap audit)
- feature_list: phase2-step-025
- phase-plan: §F Row 043
- LESSONS.md candidate: see lessons §1 above

### Commits

- This commit bundles:
  - `.claude/skills/screens/SKILL.md` (§5 + §3.5.2 + §8c additions)
  - `.claude/skills/mockups/SKILL.md` (bug-008 note in §"Pass 2 imagery resolution")
  - `.claude/skills/agents/front-end/react-next/SKILL.md` (reviewer dimension under §Review)
  - `scripts/audit-screens-external-cdn-urls.mjs` (new file, 139 LOC)
  - `phase-plan.md` §F Row 043
  - `feature_list.json` phase2-step-025 row
  - `evidence/phase2-step-025-result.txt`
  - `plans/archive/bug-009-bug-121-routing-miss-per-task-retry-loop.md` (sibling)
  - `plans/archive/bug-008-screens-preamble-external-cdn-urls.md` (this archive)

Closed by Phase 2 build operator (David Morgan / Claude opus-4-7) 2026-05-30.
