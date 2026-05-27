---
name: svelte-kit
description: Prompt pack for the web-frontend-builder when architecture.yaml.tooling.stack.web_framework=svelte-kit. SvelteKit 2 + Svelte 5 runes + TypeScript + Tailwind, consuming @repo/ui-kit as CSS + token shelf.
stack_tier: front-end
stack_slug: svelte-kit
maturity: shipped
authoredAt: 2026-04-22
dependencyPinsRefreshedAt: 2026-04-22
---

# svelte-kit — SvelteKit 2 + Svelte 5 runes + Tailwind 4

Stack-skill prompt pack for the web-frontend-builder. Loaded when `architecture.yaml.tooling.stack.web_framework === "svelte-kit"`.

**Special note on @repo/ui-kit**: the kit ships React components, but its TOKENS + GLOBALS + PATTERNS are framework-agnostic CSS. SvelteKit consumes the CSS surface (`@repo/ui-kit/globals.css`, `@repo/ui-kit/tokens.css`, `data-kit-*` attributes) + authors its own Svelte primitives that match the kit's visual contract. This is explicit in `packages/ui-kit/CONTRACT.md` — the kit's JS exports are React-only, but the CSS + spacing + dials apply universally.

## 1. Canonical layout

```
apps/web/
├── src/
│   ├── routes/
│   │   ├── (marketing)/+layout.svelte
│   │   ├── (marketing)/+page.svelte
│   │   ├── (marketing)/pricing/+page.svelte
│   │   ├── (auth)/login/+page.svelte
│   │   ├── (auth)/login/+page.server.ts    # form action handler
│   │   ├── (auth)/signup/+page.svelte
│   │   ├── (app)/+layout.svelte
│   │   ├── (app)/+layout.server.ts          # auth gate
│   │   ├── (app)/dashboard/+page.svelte
│   │   ├── (app)/dashboard/+page.server.ts  # load() fetches data server-side
│   │   └── api/trpc/[...trpc]/+server.ts    # tRPC route handler
│   ├── lib/
│   │   ├── components/                       # Svelte primitives matching kit contract
│   │   │   ├── Button.svelte
│   │   │   ├── Input.svelte
│   │   │   └── Card.svelte
│   │   ├── trpc.ts                          # tRPC client (typed from @repo/api-client)
│   │   └── cn.ts                            # re-exports @repo/ui-kit cn helper
│   ├── app.css                              # imports @repo/ui-kit/globals.css
│   ├── app.html                             # shell HTML
│   └── hooks.server.ts                      # auth cookies + tRPC context
├── svelte.config.js
├── vite.config.ts                           # aliases @repo/* workspace packages
├── tailwind.config.ts                       # extends @repo/ui-kit/tokens.css
├── tsconfig.json                            # extends @repo/ui-kit/tsconfig.consumer.json
└── package.json
```

### 1b. Feature-sliced state convention (bug-015 Phase 3)

**Cross-component shared state MUST be feature-sliced.** Each feature owns ONE store file at `apps/web/src/lib/stores/{feature-slug}.svelte.ts` (rune-based) or `apps/web/src/lib/stores/{feature-slug}.ts` (writable-based). A thin barrel at `apps/web/src/lib/stores/index.ts` re-exports.

```
apps/web/src/lib/stores/
├── index.ts                  # re-exports — thin composition only
├── board.svelte.ts           # feat-board-core owns this file
├── settings.svelte.ts        # feat-settings-data owns this file
├── theme.svelte.ts           # feat-theme owns this file
└── filter.svelte.ts          # feat-filter owns this file
```

**Why**: parallel-feature builders writing to the SAME store file produce merge conflicts at close-feature time (kanban-webapp-08 burned $20+ on this). Feature slices = each builder touches only its own file = no contention.

**Rules:**

- A slice file is owned by exactly ONE feature. PM enforces via `feature.affects_files: ["apps/web/src/lib/stores/{feature-slug}.svelte.ts"]`.
- `stores/index.ts` is a SHARED touch-point. Only modified during architect scaffold OR a structural change request. Builders NEVER add new state to `index.ts`.
- Cross-slice composition via re-exported derived runes (`$derived(boardStore.active && filterStore.search)`).
- For tiny single-screen apps with no cross-feature state, a single `stores/app.svelte.ts` is fine. The slice convention kicks in the moment a SECOND feature needs shared state.

This convention is also enforced by the architect agent at scaffold time — see `.claude/agents/architect.md` §State module structure.

### 1c. `data-screen-id` on every page-root render (feat-022)

**Every `+page.svelte` MUST render its mockup's `data-screen-id` on the page-root element so the post-build `/build-to-spec-verify` synthesizer can assert "after click → on screen Y" without URL-pattern guesswork.** The value is the kebab-case mockup screen id (`docs/screens/webapp/{screen-id}.html` → `data-screen-id="{screen-id}"`).

```svelte
<!-- src/routes/(app)/dashboard/+page.svelte -->
<script lang="ts">
  /* ... */
</script>

<div data-screen-id="dashboard">
  <!-- page content -->
</div>

<!-- src/routes/settings/+page.svelte -->
<main data-screen-id="settings">...</main>
```

Place the attribute on the topmost element the page returns (the route's render root). For modal-style screens that render inside a Dialog component, set `data-screen-id` on the dialog's outer `<div role="dialog">` so it becomes the active screen-id when the modal mounts. The synthesizer reads `document.querySelector('[data-screen-id]')` — it accepts ANY element, just needs one match.

The mockup's `<body data-screen-id="...">` (see screens skill §4e.1) is the source of truth — match it exactly. Mismatched IDs surface as flow-failure violations in `/build-to-spec-verify`.

## 2. Idioms

- **Svelte 5 runes only.** `$state()`, `$derived()`, `$effect()` — no `let`-based reactivity, no `writable()` stores unless wrapping external reactive sources. Stores are fine for cross-component shared state, but rune-based `$state()` on a module-level `const` is preferred for simple cases.
- **Route files colocate.** Every route directory has `+page.svelte` (UI) + `+page.server.ts` (server-only loader + form actions) + optionally `+layout.svelte`. Server-only files run only on the server — put DB / tRPC caller / secrets access here.
- **`load()` functions for data.** Server `load()` returns typed data via `satisfies PageServerLoad`; the `+page.svelte` consumes via `export let data: PageData`.
- **Form actions for mutations.** Progressive-enhanced by default — no JS → form posts through; with JS → intercepted client-side, handled without navigation.
- **Native `<a href="/path">` for navigation.** SvelteKit handles client-side routing automatically; no `<Link>` component needed.
- **`goto()` from `$app/navigation`** for imperative nav inside handlers.
- **Kit tokens via CSS variables.** Import `@repo/ui-kit/globals.css` once in `src/app.css`; reference tokens via `var(--color-accent-500)` or Tailwind arbitrary values like `bg-[var(--color-surface-raised)]`.
- **Forms with `zod` + superforms.** sveltekit-superforms gives the same ergonomics as React Hook Form + Zod. Import Zod schema from `@repo/types`.
- **Loading skeletons** via the kit's `data-kit-component="Skeleton"` CSS + Svelte's `#await` block for promise resolution.
- **data-kit-\* attrs preserved.** Svelte primitives match the kit's React contract: every Svelte `<Button>` emits `data-kit-component="Button"` + `data-kit-variant="primary|..."` for HTML-structure parity with React builds.

### 2.5. Routing Contract (bug-025) — read screens.json before authoring nav code

Before writing ANY navigation code (`<a href>`, `goto()` from `$app/navigation`, `redirect()` from `@sveltejs/kit`), read `docs/screens-manifest.json` to find the **canonical `routePattern`** for the target screen. Use it verbatim — don't invent a "cleaner" URL.

If you're authoring a NEW screen (route owner), the SvelteKit file location MUST match its `routePattern`:

```
screens.json routePattern:  /report/:owner/:repo
SvelteKit file location:     src/routes/report/[owner]/[repo]/+page.svelte
```

screens.json wins when two builders disagree. File a kit-change-request via `docs/screens/kit-change-requests/` if you believe screens.json is wrong — don't silently re-invent.

Empirical motivation: see `plans/active/bug-025-cross-feature-url-contract.md` (repo-health-dashboard-01 2026-04-29 — feat-home + feat-report disagreed on `/r/...` vs `/report/...` and produced a 404 on form submit).

### 2a. HTML → Svelte translation: `data-kit-*` pass-through (feat-028 visual-parity contract)

When translating a screen mockup at `docs/screens/webapp/{screen-id}.html` into a Svelte page (`src/routes/.../+page.svelte` + supporting `src/lib/components/**`), every `data-kit-*` attribute on the source HTML element MUST survive translation.

The mapping is mechanical:

```html
<!-- Mockup source -->
<button
  data-kit-component="Button"
  data-kit-variant="primary"
  data-kit-size="md"
>
  Save
</button>
```

```svelte
<!-- Translated Svelte — primitive forwards the attrs back via Phase 0 retrofit -->
<script>
  import Button from "$lib/components/Button.svelte";
</script>

<Button variant="primary" size="md">Save</Button>
```

The locally-authored `<Button>` Svelte primitive (kit's React exports aren't usable in Svelte; per §1's "Special note on @repo/ui-kit") emits `data-kit-component="Button" data-kit-variant="primary" data-kit-size="md"` on its rendered root, restoring the contract.

**Critical: do NOT strip the AppShell wrapper.** When the mockup wraps page content in `<div data-kit-component="AppShell">…<aside data-kit-component="Sidebar">…</aside>…</div>`, the Svelte render MUST emit the same wrapper hierarchy via Svelte primitives + slot props. Stripping the shell is the dominant divergence pattern investigate-009 catalogued — the post-build `/build-to-spec-verify` parity stage (feat-028) flags it as `shell-stripping` (P0) + auto-files a bug plan with a per-pattern fix template.

### 2b. Self-verify: kit-attribute presence

Before returning `taskStatus: "completed"`, run a quick presence check on the feature's authored components:

```bash
# From the worktree root, after authoring:
grep -rE "data-kit-component" apps/web/src 2>/dev/null | wc -l
```

A count of 0 in a feature whose mockups DO use kit primitives is a strong signal that the translation pass dropped the attributes — re-check each `+page.svelte` against its mockup. The actual contract enforcement happens in `/build-to-spec-verify`'s parity stage which renders the built page + diffs against the mockup HTML; this self-verify only catches the most-egregious omissions before the orchestrator gets there.

### 2c. Dev-only `__seedFromUrl` helper (feat-029 fixture seed contract)

The post-build parity verifier (feat-028 + feat-029) navigates to `/?_seed=<screenId>` to populate the app with the same data shape the mockup depicts BEFORE diffing the rendered DOM. Without this, the built app renders empty (no boards, no cards, no settings) while the mockup shows populated state — every parity check fails for the wrong reason ("everything missing").

Every project MUST ship a dev-only `__seedFromUrl` helper that:

1. Reads `?_seed=<id>` from `$page.url.searchParams` (or `window.location.search`)
2. Fetches `/docs/screens/webapp/fixtures/<id>.fixture.json`
3. Applies the fixture's `storeState` to `localStorage` (or whichever persistence layer the rune-store reads from on hydration)
4. Strips the query param + reloads the page so the store rehydrates from seeded state
5. Is a NO-OP in production builds (guarded by `import.meta.env.DEV` — Vite inlines this at build time + dead-code-eliminates the false branch)

Canonical implementation lives at `apps/web/src/lib/dev-seed.ts`:

```ts
// apps/web/src/lib/dev-seed.ts
// Dev-only fixture seeder for the post-build parity verifier (feat-029).
// In production this whole module compiles to a no-op via the import.meta.env.DEV guard.

const STORAGE_KEY = "app-store"; // match your rune-store persistence key

export function applyDevSeedFromUrl(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const seedId = params.get("_seed");
  if (!seedId) return;
  void (async () => {
    try {
      const res = await fetch(
        `/docs/screens/webapp/fixtures/${seedId}.fixture.json`,
      );
      if (!res.ok) {
        console.warn(`[dev-seed] fixture ${seedId} not found (${res.status})`);
        return;
      }
      const fixture = await res.json();
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(fixture.storeState),
      );
      const url = new URL(window.location.href);
      url.searchParams.delete("_seed");
      window.location.replace(url.toString());
    } catch (err) {
      console.warn("[dev-seed] failed to apply fixture:", err);
    }
  })();
}
```

Wire into the root layout so it fires on every navigation:

```svelte
<!-- apps/web/src/routes/+layout.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { applyDevSeedFromUrl } from "$lib/dev-seed";
  onMount(() => {
    applyDevSeedFromUrl(); // no-op in production
  });
</script>

<slot />
```

**Production-build exclusion contract:** the `import.meta.env.DEV` guard is the FIRST statement inside the function. Vite inlines `import.meta.env.DEV` at build time, so the production bundle compiles the entire fetch+localStorage block away as dead code. Verify with:

```bash
pnpm --filter @repo/web build
grep -r "applyDevSeedFromUrl" apps/web/.svelte-kit/output/client/_app/immutable/ 2>/dev/null | wc -l
# Expect: 0 (dead-code-eliminated; the export name itself may appear in bundle's symbol table —
#  the test is whether the FETCH + LOCALSTORAGE bodies survive)
```

**Self-verify command** (run before reporting `taskStatus: "completed"` for ANY feature that touches `apps/web/src/routes/+layout.svelte`):

```bash
test -f apps/web/src/lib/dev-seed.ts && echo "ok: dev-seed.ts present"
grep -c "applyDevSeedFromUrl" apps/web/src/routes/+layout.svelte
# Expect: ≥1
grep -c "import.meta.env.DEV" apps/web/src/lib/dev-seed.ts
# Expect: ≥1 (production guard required)
```

A count of 0 on either grep is a feature-failing condition — the parity verifier downstream will produce no useful signal without the seed handler in place.

**Storage-key alignment:** the `STORAGE_KEY` constant MUST match the key your rune-based persisted store uses (whatever `localStorage.setItem(...)` call your `apps/web/src/lib/stores/index.ts` makes during hydration). Mismatch = seeded data sits in localStorage but the store reads from a different key + ignores it. Hardcode the key as a re-exportable constant from `apps/web/src/lib/stores/index.ts` so dev-seed.ts and the store agree on a single source of truth.

## 2c. AppShell layout invariants (bug-105 — preventive)

The same AppShell layout-invariant set defined in `.claude/skills/agents/front-end/react-next/SKILL.md` §2c applies VERBATIM to Svelte projects shipping an AppShell-class layout. Tailwind class names (`min-h-dvh`, `w-full`, `flex-1`, `mt-auto`) are framework-agnostic; only the JSX→Svelte syntax differs.

Key invariants (full rationale + empirical motivator in the react-next skill):

- **Sidebar fills viewport height** (`min-h-dvh` or `h-dvh` on AppShellSidebar root).
- **Main content owns the scroll** (`overflow-y-auto` on AppShellMain).
- **Topbar spans full viewport width** (`w-full`; NOT constrained by sidebar column).
- **Topbar slot allocation**: LEFT = brand wordmark (when project has one), CENTER = primary search (`flex-1 flex justify-center`), RIGHT = CTA cluster (`flex items-center gap-2 shrink-0`).
- **Sidebar width 240-280px** (explicit `w-60` / `w-64` / `w-72`).
- **Sidenav bottom-slot** uses `mt-auto` for utility content (stats footer, version, support link).

Self-verify checks (run BEFORE reporting AppShell-class task complete): sidebar full-height, topbar full-width, brand presence when brief specifies one, sidenav bottom-slot when screen template emits one, center-slot search centered. ANY invariant failure = re-author the markup; don't ship default-kit layout for AppShell-class projects.

See react-next §2c for the full check list + DOM-query snippets.

## 3. Testing

- **Test-file naming**: `src/lib/foo.ts` → `src/lib/foo.test.ts`; component `src/lib/components/Button.svelte` → `src/lib/components/Button.test.ts`.
- **Test runner**: `pnpm vitest run <file>` (single); `pnpm vitest` (watch); `pnpm vitest run --coverage` (coverage).
- **Component rendering via `@testing-library/svelte`**:

  ```ts
  import { render, screen } from "@testing-library/svelte";
  import userEvent from "@testing-library/user-event";
  import Button from "./Button.svelte";

  test("renders primary variant", async () => {
    render(Button, { variant: "primary", label: "Save" });
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "data-kit-variant",
      "primary",
    );
  });
  ```

- **Mocking patterns**:
  - Mock `$app/navigation` via `vi.mock('$app/navigation', () => ({ goto: vi.fn() }))`.
  - Mock `$page` store via `vi.mock('$app/stores', () => ({ page: { subscribe: (fn) => { fn({ url: new URL('http://localhost/') }); return () => {}; } } }))`.
  - Mock tRPC via the `@repo/api-client/test-utils` `mockTrpcClient()` helper.
- **Load function tests** — test the plain function, not the SvelteKit invocation. Import the `load` export from `+page.server.ts` and call it with a mock event.
- **Coverage expectation**: 60% builder / 80% total (same as react-next).
- **Playwright E2E** (tester-owned): `apps/web/e2e/*.spec.ts`; runner `pnpm playwright test`.

### 3a. Playwright runtime self-verify (feat-025 install-discipline)

Authoring `*.spec.ts` files without the runtime installed produces **unrunnable specs that silently fool downstream verification** (the post-Mode-B `/build-to-spec-verify` flow-execution stage will skip them, no failures surface, the builder thinks it's green). Discovery: kanban-webapp-10 shipped with multiple `e2e/*.spec.ts` files but no `@playwright/test` in devDependencies — the project literally couldn't run any of them.

Before any agent commits a Playwright spec, the runtime MUST be installed + configured. The tester is the canonical owner per `.claude/agents/tester.md` §Self-verify discipline.

**Required artifacts:**

1. `apps/web/package.json` devDependencies includes `@playwright/test` (^1.48.0 or newer)
2. `apps/web/playwright.config.ts` exists with the **MANDATORY `webServer:` block** documented in §3a.1 below (bug-041 Phase B 2026-05-03 — making this section's mandate explicit + machine-checkable per the synthesizer's bug-041 Phase A enforcement).
3. `apps/web/package.json` scripts includes `"test:e2e": "playwright test"`

#### 3a.1. Required `playwright.config.ts` template — COPY VERBATIM

Builder MUST emit this exact structure. Inline edits or omissions are bug-041 root causes — every flag below has a documented reason; deletion silently breaks the post-Mode-B verifier flow-execution stage.

**Decision table — `webServer.command` resolution (the only variable):**

| `architecture.yaml.tooling.stack.persistence_layer` | Strategy | `webServer.command`            | Why                                                                                 |
| --------------------------------------------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `localStorage`                                      | A        | `"pnpm exec vite dev"`         | Single-tier project; only the frontend boots; localStorage-only state               |
| `external-api-only`                                 | D        | `"node ../../scripts/dev.mjs"` | Multi-tier; dev.mjs propagates `.env.local` per bug-033 + handles port coordination |
| `real-db`                                           | C        | `"node ../../scripts/dev.mjs"` | Multi-tier + DB; same boot path as Strategy D                                       |
| (absent / unknown)                                  | -        | `"node ../../scripts/dev.mjs"` | Safe default — dev.mjs degrades gracefully when no apps/api/ exists                 |

(SvelteKit's Vite dev server defaults to port 5173 — override `url:` only if `vite.config.ts` does.)

**Template:**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Bumped local from 0 → 1 for live-backend specs.
  // Strategy A (localStorage) projects can keep retries: 0 — deterministic.
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "list" : "html",
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // ⚠️ MANDATORY — without webServer, playwright doesn't auto-boot the dev
  // server during tests; specs run against a down/empty backend → false-
  // positive flow failures (bug-041 empirical case: 2026-05-02 finance-track-01
  // where 9/9 synthesized E2E flows landed on "No accounts yet" because no
  // backend was running). The synthesizer's bug-041 Phase A check enforces
  // the block's presence at post-flight; absent → hard error in errors[].
  webServer: {
    command: "node ../../scripts/dev.mjs", // ← per decision table above
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
```

For Strategy A projects, replace `webServer.command` with `"pnpm exec vite dev"` and drop the `timeout`/`stdout`/`stderr` extras (single-tier doesn't need them). For all other strategies (or unknown/absent persistence_layer), use the multi-tier form above verbatim — `scripts/dev.mjs` falls back gracefully when no `apps/api/` exists, so the multi-tier form is the safe default.

**Self-verify before reporting task complete:** after writing playwright.config.ts, read it back + grep for `webServer:` substring. If absent (or partially typed), edit to add the block per the decision table. Bug-041 root cause was builder omitting the block silently; this self-verify closes the gap.

**Install command** (run from project root): `pnpm -C apps/web add -D @playwright/test && pnpm -C apps/web exec playwright install chromium`. The orchestrator's `scripts/run-synthesized-flows.mjs` pre-flight checks the three artifacts above and gracefully degrades (warning, not failure) if any are missing — but the project still ships unrunnable specs, so the tester must close the gap.

## 4. Commands

```
lint:      pnpm --filter @repo/web lint
typecheck: pnpm --filter @repo/web check       # SvelteKit uses svelte-check
test:      pnpm --filter @repo/web test
build:     pnpm --filter @repo/web build
dev:       pnpm --filter @repo/web dev
```

`svelte-check` replaces `tsc --noEmit` for typechecking — it understands `.svelte` files natively.

## 5. Gotchas

- **Svelte 5 vs 4 syntax.** Runes (`$state`, `$derived`, `$effect`) require Svelte 5; legacy reactive statements (`$:`) still work but mixing styles in one component is confusing. Stick to runes for new code.
- **`+page.server.ts` vs `+page.ts`.** The `.server.ts` variant runs ONLY on the server; `.ts` (no `.server`) runs on both sides and ships to the client. Database access MUST use `.server.ts`.
- **Form actions return types.** `return fail(400, { message: '...' })` for validation errors (form-bound); `redirect(302, '/path')` (thrown, not returned) for post-success navigation. These aren't interchangeable.
- **Global styles scoping.** `:global(...)` in a Svelte component's `<style>` block leaks out. Prefer extending the kit's `globals.css` at the app root over scattered global overrides.
- **Cookie access in load functions.** Use `event.cookies.get('name')` — do NOT reach for `document.cookie` (it's SSR-first; DOM cookies don't exist server-side).
- **Vite aliases need both `svelte.config.js` + `tsconfig.json`.** Add workspace package aliases in BOTH files — SvelteKit's preprocessor reads svelte.config, but TypeScript reads tsconfig.
- **Hydration + `$state` initial value mismatch.** If the server renders with one `$state` initial value and the client hydrates with another, you get the same mismatch warning as React. Use the same `load()` data source on both sides.
- **`use:enhance` required for progressive form behavior.** Without it, form actions full-page-reload on submit; with it, the client intercepts + updates without navigation. Always add `use:enhance` to forms that the user interacts with frequently.

## Review

Stack-specific checks the reviewer agent runs IN ADDITION to `docs/reviewer-playbook.md`'s generic 7 dimensions. Scope: files in the feature's diff under `apps/web/`.

#### security — secrets in `+page.svelte`

- **Invocation**: `grep -rnE "process\.env\.|import\.meta\.env\." apps/web/src/routes/**/+page.svelte`
- **Threshold**: zero hits inside `+page.svelte` files — server-only secrets belong in `+page.server.ts`; exposed env vars must be prefixed `PUBLIC_` (Vite convention) AND only touched in the client-side `<script>` of a page
- **Retry target**: web-frontend-builder
- **Playbook §**: augments §2 security (secret-leak sub-check)

#### architecture — DB / auth access only in `+page.server.ts` / `+server.ts`

- **Invocation**: `grep -rnE "(prisma|drizzle|supabaseClient|auth\(\))" apps/web/src/routes/**/+page.svelte apps/web/src/lib/**/*.svelte`
- **Threshold**: zero hits — DB clients + server-side auth flows run only in `+page.server.ts` / `+server.ts` endpoints. A DB client imported into a `.svelte` component ships to the client bundle
- **Retry target**: web-frontend-builder
- **Playbook §**: augments §1 architecture (SvelteKit server boundary) + §2 security

#### performance — parallel promises in load()

- **Invocation**: `grep -rnB2 -A10 "export const load\s*=" apps/web/src/routes/` filter for sequential `await`s: look for `const a = await ...; const b = await ...` patterns with no inter-dependency
- **Threshold**: sequential `await`s that could run in parallel are a fail; use `const [a, b] = await Promise.all([fetchA, fetchB])` — LCP penalty scales with the number of sequential awaits
- **Retry target**: web-frontend-builder
- **Playbook §**: augments §6 performance (LCP sub-check)

#### security — form actions + CSRF

- **Invocation**: in `svelte.config.js`: `grep -nE "csrf\s*:" svelte.config.js`. For each form-action file: `grep -rnE "export const actions\s*=" apps/web/src/routes/**/+page.server.ts` cross-referenced with `use:enhance` in the matching `+page.svelte`
- **Threshold**: `csrf.checkOrigin` is NOT set to `false` in svelte.config.js; every form action's matching `+page.svelte` uses `<form method="post" use:enhance>` (or explicit `action="?/name"` with kit CSRF defaults)
- **Retry target**: web-frontend-builder
- **Playbook §**: augments §2 security (CSRF sub-check)

#### a11y — click handlers on non-interactive elements

- **Invocation**: `grep -rnE "on:click=" apps/web/src/` → cross-reference with the enclosing element tag (skip `<button>`, `<a href>`, `<input>`, `<select>`, `<textarea>`)
- **Threshold**: zero hits on `<div>` / `<span>` / `<p>` / `<li>` without `role="button"` + `tabindex="0"` + keyboard handler (`on:keydown` filtering `Enter` / `Space`)
- **Retry target**: web-frontend-builder
- **Playbook §**: augments §5 a11y

## 6. Dependency pins

```
svelte               5.1.x
@sveltejs/kit        2.8.x
@sveltejs/adapter-auto 3.3.x        # switch to adapter-node/vercel/cloudflare per deploy target
vite                 5.4.x
typescript           5.6.x
svelte-check         4.0.x
tailwindcss          4.0.0-beta.7
@tailwindcss/vite    4.0.0-beta.7
postcss              8.4.x
vitest               2.1.x
@testing-library/svelte     5.2.x
@testing-library/user-event 14.5.x
sveltekit-superforms 2.20.x
zod                  3.23.x
@trpc/client         11.0.x
@trpc/server         11.0.x
```

Workspace packages:

```
@repo/ui-kit           workspace:*    # consumed as CSS + tokens, NOT as component library
@repo/types            workspace:*
@repo/api-client       workspace:*
@repo/utils            workspace:*
```

## 6.5. Files NOT to modify (bug-023 + bug-024)

These files are **scaffold-owned**: configured at scaffold time and intentionally NOT edited per feature. If you believe one MUST change, emit a kit-change-request via `docs/screens/kit-change-requests/` instead of modifying inline.

- `apps/web/vitest.config.ts` — test discovery is glob-based; new test files match automatically
- `apps/web/vitest.setup.ts` — global test setup
- `apps/web/svelte.config.js` — kit-bump only
- `apps/web/tailwind.config.ts` — kit-bump only
- `apps/web/tsconfig.json` — paths are architect-owned

Same merge-conflict cost rationale as react-next §6.5 (parallel features each modifying `vitest.config.ts` produce close-feature conflicts).

## 7. Anti-patterns

- **Never import `@repo/ui-kit` component exports in Svelte code.** They are React-only. Use `@repo/ui-kit/globals.css` + `@repo/ui-kit/tokens.css` for the CSS surface; author Svelte primitives locally under `src/lib/components/` that match the kit's visual + `data-kit-*` contract.
- **Never mix Svelte 4 reactive statements (`$:`) with Svelte 5 runes in the same component.** Pick one.
- **Never use `getStores()` or `getContext()` at module top-level.** Only inside component functions.
- **Never suppress ESLint on `onMount` fetches.** If you need server data, use `load()` — `onMount` runs only client-side and misses SSR.
- **Never ship secrets via `PUBLIC_*` env vars.** The `$env/static/public` + `$env/static/private` split is strict — public vars are baked into the client bundle, private vars are server-only.

## 8. References

- [SvelteKit 2 docs](https://svelte.dev/docs/kit) — routing, load functions, form actions
- [Svelte 5 runes migration](https://svelte.dev/docs/svelte/v5-migration-guide)
- [sveltekit-superforms](https://superforms.rocks/) — form + Zod integration
- [Tailwind CSS v4 for Vite](https://tailwindcss.com/docs/v4-beta)
- Blueprint §17 / Appendix E — stack-skill shelf policy
- `packages/ui-kit/CONTRACT.md` — consumer contract (CSS-only surface for non-React stacks)
