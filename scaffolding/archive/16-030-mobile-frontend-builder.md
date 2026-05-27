---
task-id: "030"
title: "Mobile Frontend Builder Agent"
status: pending
priority: P2
tier: 7 — Build Pipeline
depends-on: ["020", "027", "022b", "024", "025", "028"]
estimated-scope: medium
---

# 030: Mobile Frontend Builder Agent

## What This Task Produces

1. Agent definition at `.claude/agents/mobile-frontend-builder.md`
2. Skill at `.claude/skills/build-mobile-frontend/SKILL.md`

Both are locked to the **UI Kit consumption contract** (task 022b). The builder translates signed-off HTML screens under `docs/screens/mobile/` into an Expo React Native app that imports exclusively from `@repo/ui-kit` — resolving platform-specific primitives via Metro's `.native.tsx` extension resolution.

## Why This Scope (per refactor-001 + feat-002)

1. **Stack-agnostic dispatcher (feat-002).** Builder reads `architecture.yaml.tooling.stack.mobile_framework` and loads `.claude/skills/agents/mobile/{stack-slug}/SKILL.md` verbatim. Initial shipped: `expo-rn`. Draft candidates for future shelf growth: `flutter`, `bare-rn`, `native-kotlin`, `native-swift`.
2. **Kit-only imports enforced** — same contract as 029, with kit consumption varying by stack (see §System Prompt below).
3. **Shared tokens across every mobile stack.** `@repo/ui-kit/tokens/tokens.ts` (or its generated Dart / JSON mirror for non-JS stacks) consumed by the mobile framework's styling layer.
4. **Kit version pinned** — same sign-off binding as 029.
5. **Mobile-tier skip**: if `architecture.yaml.tooling.stack.mobile_framework` is `null` OR the feature's `skip[]` includes `mobile`, this builder is not invoked for those features (orchestrator marks tasks `skipped`).

## Scope

### Agent Definition

```yaml
---
name: mobile-frontend-builder
description: Stack-agnostic mobile builder. Dispatches to the stack skill named in architecture.yaml.tooling.stack.mobile_framework. Translates docs/screens/mobile/**/*.html into platform-native code per the loaded stack pack. Runs ui-kit:validate-consumer post-generation where applicable; fails on kit-contract violation.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
permissionMode: acceptEdits
maxTurns: 40
skills: []
---
```

Note: `skills` frontmatter is empty — stack-specific knowledge (`expo-patterns`, `flutter-widgets`, native-iOS `SwiftUI` idioms, etc.) lives in the dispatched stack skill, not in agent frontmatter.

### System Prompt — Stack Dispatch + UI Kit Contract

**Dispatch FIRST**: read `architecture.yaml.tooling.stack.mobile_framework`. If `null`, abort cleanly (no mobile tier; orchestrator marks assigned tasks `skipped`). Otherwise load `.claude/skills/agents/mobile/{stack-slug}/SKILL.md` verbatim — it provides canonical layout, idioms, testing recipe, commands, gotchas for the target framework.

**Then embed the UI Kit Contract**: `packages/ui-kit/CONTRACT.md` verbatim. Six rules apply identically on mobile. Kit consumption varies by stack:

- **`expo-rn`**: React kit imports resolve via Metro's `.native.tsx` extension; primitives ship both `Button.tsx` + `Button.native.tsx` under `apps/mobile/components/ui/` (or kit's own `.native.tsx` overrides). NativeWind 4 consumes `@repo/ui-kit/tokens/tokens.ts`.
- **Non-JS stacks (future: flutter, native-kotlin, native-swift)**: stack skill spells out how to consume kit tokens via generated mirrors (Dart file, JSON asset bundle, Swift Colors.xcassets). `data-kit-*` HTML attributes translate to `testID` / accessibility identifiers per stack.

Framework-specific prose (Metro monorepo config, Expo Router file-based routing, safe-area patterns, gesture handlers, `.native.tsx` resolution) comes EXCLUSIVELY from the dispatched stack skill.

```
You are a Senior mobile engineer. You translate signed-off HTML screens
into production mobile code using the stack the architect picked. You
consume the project's UI Kit (via the pattern the stack skill prescribes)
and nothing else for UI.

## Stack dispatch (feat-002)

LOCKED by `architecture.yaml.tooling.stack.mobile_framework`. Load the
matching `.claude/skills/agents/mobile/{stack-slug}/SKILL.md` at the start
of your run. The stack skill IS your framework guide. Do not hardcode
Expo / RN / NativeWind assumptions below if the stack skill differs.

## Common inputs (all stacks)

- @repo/types for shared Zod schemas (or generated mirror for non-JS stacks)
- @repo/api-client for tRPC client hooks (React stacks) OR a matching codegen (Dart/Swift)
- TypeScript strict mode (for JS-based mobile stacks) OR the stack's language mode

## Platform variant resolution

The kit ships two files per platform-sensitive primitive:
  packages/ui-kit/src/primitives/button/Button.tsx        (web — React DOM)
  packages/ui-kit/src/primitives/button/Button.native.tsx (RN)

Metro (the RN bundler) automatically resolves .native.tsx when the
consumer imports from @repo/ui-kit on a native target. Your JSX is
identical to what the web builder writes:
  import { Button, Card } from '@repo/ui-kit'
  <Button variant="primary">Save</Button>

You do NOT reference the .native.tsx files directly. You do NOT write
Platform.OS checks for primitive usage. Trust the resolver.

## Your inputs

1. `docs/signoff-{latest}.json` — pin the uiKitVersion; abort if the
   kit's current version differs.
2. `docs/screens/mobile/**/*.html` — HTML previews to translate.
   (Yes, the preview is HTML even though the final target is RN.
   HTML is the fast-iteration spec; RN JSX is the production output.)
3. `docs/selected-style.json` — approved style.
4. `architecture.yaml.apps.mobile` — routing, auth, deep linking,
   permissions, bundle ID.

--- BEGIN UI KIT CONTRACT (from packages/ui-kit/CONTRACT.md) ---
[verbatim inclusion of the six rules + escape hatches + enforcement]
--- END UI KIT CONTRACT ---

## Translation rules (HTML → RN JSX)

Use the SAME `data-kit-*` attribute translation key as web (see 029). `/screens`
emits `data-kit-component`, `data-kit-variant`, `data-kit-size`, `data-kit-props`,
and `data-kit-layout` attributes; you read them and convert to kit component JSX.
Do NOT pattern-match on Tailwind classes.

  <button data-kit-component="Button" data-kit-variant="primary" data-kit-size="md" class="...">
    Save
  </button>

Translates identically to:

  <Button variant="primary" size="md">Save</Button>

…because Metro resolves `Button.native.tsx` for the native target. Consumer code is
identical to web.

Additional RN-specific rules:

- Kit layouts, primitives, and patterns map 1:1 between web and mobile because
  they share the public barrel. `<AppShell>` on mobile may render a bottom-tab
  shell while on web it's a sidebar; that's the kit's job, not yours. Trust the
  component.
- HTML `<div>` / `<span>` / `<p>` WITHOUT `data-kit-*` attributes (pure layout
  wrappers) → React Native `<View>` / `<Text>`. Inside a kit component, pass
  children as-is; the component handles text vs view internally.
- Images: `<img>` → `<Image>` from `expo-image` (NOT RN's built-in Image).
- Navigation: Expo Router file-based; each `docs/screens/mobile/{id}.html` →
  `apps/mobile/app/{route}.tsx`.
- Gestures / platform-specific interactions: use react-native-gesture-handler
  or Expo modules; do NOT style around them.
- Remove all Tailwind class strings during translation — the kit component
  applies its own styling via `.native.tsx` at runtime.

## app.json configuration

Generate from architecture.yaml.apps.mobile:
  - expo.name, expo.slug
  - expo.ios.bundleIdentifier (unique per project)
  - expo.android.package
  - expo.scheme (deep linking)
  - expo.plugins (expo-router, expo-font, expo-image, etc.)
  - expo.permissions (camera, location — only what the brief declares)

## Post-generation enforcement

After writing, run:
  pnpm ui-kit:validate-consumer 'apps/mobile/{app,src}/**/*.{ts,tsx}'
  pnpm --filter mobile typecheck
  pnpm --filter mobile lint

If any fail, fix and re-run. Max 3 retries; then escalate.
```

### /build-mobile-frontend Skill

```yaml
---
name: build-mobile-frontend
description: Translate docs/screens/mobile/**/*.html into an Expo / React Native app at apps/mobile. Enforces UI Kit contract via validate-consumer + typecheck + lint. Runs in parallel with /build-web-frontend.
allowed-tools: Read Write Edit Bash Grep Glob
model: inherit
---
```

### Prerequisites

- Sign-off received (`docs/signoff-{timestamp}.json` with `approved: true`)
- `packages/ui-kit/` populated; `.native.tsx` variants present for every platform-sensitive primitive
- `docs/screens/mobile/*.html` exists
- `architecture.yaml.apps.mobile` block filled (produced by `/architect` post-signoff per refactor-003)
- **`.env` populated by user at gate 5** — refactor-003. Mobile has two distinct `.env` consumption paths:
  - **`EXPO_PUBLIC_*` prefixed keys** (e.g., `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_MAPBOX_TOKEN`) → baked into the bundle at `expo build` / EAS Build time. Read by the app at runtime via `process.env.EXPO_PUBLIC_*`.
  - **EAS Build-secrets** (non-prefixed keys like `SENTRY_AUTH_TOKEN`, `APPLE_SHARED_SECRET`) → NOT bundled; supplied to EAS Build jobs at build time only via `eas.json` → `build.production.env` or `eas secret:create`. The builder emits an `eas-secrets-setup.sh` helper into `apps/mobile/` documenting which secrets the user needs to register with `eas secret:create` — reading each secret name from `.env.example`. The builder NEVER reads or embeds the secret values; it only documents the names.
  - Reviewer (task 032) scans the mobile bundle for leaked non-prefixed secret-prefixed keys per "no secrets in code" criterion. Missing required public keys surface at `expo build` as loud failures.

### Steps

1. **Pin the kit version** — same as 029. Abort on mismatch.
2. **Read architecture.yaml.apps.mobile** for Expo config inputs
3. **Read the UI Kit barrel** `packages/ui-kit/src/index.ts`; build the translation map from each primitive's `.variants.ts`. Verify every platform-sensitive primitive has a `.native.tsx` sibling — abort with a clear error listing any missing ones. (Task 024 is responsible for producing these; if any are missing, the kit is incomplete and should be re-run.)
4. **Translate each HTML screen** at `docs/screens/mobile/*.html` into `apps/mobile/app/{route}.tsx` (Expo Router convention)
5. **Configure Expo + NativeWind**:
   - `app.json` — see "app.json configuration" below
   - `babel.config.js` with `nativewind/babel` preset
   - `metro.config.js` wired with `withNativeWind(config, { input: '../../packages/ui-kit/src/styles/globals.css' })` — this is how NativeWind 4 consumes the kit's CSS + Tailwind directives at build time. The file is NOT loaded at runtime; NativeWind's metro transformer reads it during bundling and emits RN style objects.
   - `tailwind.config.js` pointing at the kit's preset (`presets: [require('@repo/ui-kit/src/styles/tailwind.config.ts')]`) so Tailwind's content scan resolves kit classes consistently
6. **Wire tRPC client** from `@repo/api-client` — the 028 backend builder has already produced the router types; wire them here with `@tanstack/react-query` + `@trpc/react-query`. `superjson` transformer is separately optional (used if the brief declares complex serialization needs like Date/BigInt).
7. **Root layout** (`apps/mobile/app/_layout.tsx`): set up providers (tRPC, NavigationContainer via Expo Router, theme). The globals.css does NOT need to be imported at runtime here — NativeWind already processed it via metro config in step 5.
8. **Generate kit-change-requests** and halt on unmappable HTML (same flow as 029)
9. **Run enforcement gate**:
   - `pnpm ui-kit:validate-consumer 'apps/mobile/{app,src}/**/*.{ts,tsx}'`
   - `pnpm --filter mobile typecheck`
   - `pnpm --filter mobile lint`
   - Retry-with-feedback on failure (max 3)
10. **Report** — return JSON per `BuildMobileFrontendOutput` (task 034b)

### NativeWind + tokens bridge

NativeWind 4 consumes a Tailwind config. Point `apps/mobile/tailwind.config.js` at `packages/ui-kit/src/styles/tailwind.config.ts` (same preset web uses) so:

- Tokens flow: `@repo/ui-kit/src/tokens/tokens.ts` → Tailwind preset → NativeWind at build → RN StyleSheet at runtime
- Dark mode works via the same tokens.css `.dark` class toggle the kit generates; NativeWind's `darkMode: 'class'` handles the switch
- No separate token file for mobile; no per-platform drift

### What NOT to do

- Do NOT install `react-native-reusables`, `native-base`, `tamagui`, `nativewind/components`, or any other RN component library — `@repo/ui-kit` is the library.
- Do NOT author a `components/` directory inside `apps/mobile/` for UI.
- Do NOT write `Platform.OS === 'ios' ? <A/> : <B/>` for primitives; the kit handles that via `.native.tsx`.
- Do NOT inline StyleSheet color / spacing tokens; use NativeWind classes that resolve via the kit's Tailwind config.
- Do NOT deep-import `@repo/ui-kit/primitives/button/Button.native`; import `{ Button }` from `@repo/ui-kit` and trust Metro.

### Return JSON

```json
{
  "success": true,
  "uiKitVersion": "1.0.0",
  "screensGenerated": 32,
  "kitChangeRequests": [],
  "validateConsumerResult": "clean",
  "typecheckResult": "pass",
  "lintResult": "pass",
  "nativePrimitivesVerified": 14,
  "retriesTriggered": 0,
  "warnings": []
}
```

### Runs in Parallel with Web

`/build-mobile-frontend` runs concurrently with `/build-web-frontend` after sign-off. Both pin the same kit version. Shared `@repo/ui-kit` means bugs fixed in one platform's `.native.tsx` can cascade to the other platform's `.tsx` via shared variants.ts.

## Integration Points

- **Task 020** (Architect): produces `architecture.yaml.apps.mobile` with bundle ID, permissions, plugins
- **Task 021** (PM agent): handles kit-change-requests (especially when a mobile primitive needs a `.native.tsx` variant added)
- **Task 022b** (UI Kit contract): CONTRACT.md embedded verbatim; `validate-consumer.ts` runs post-generation
- **Task 024** (/stylesheet): must produce `.native.tsx` siblings for every platform-sensitive primitive; this builder verifies their presence
- **Task 025** (/screens): produces mobile HTML previews
- **Task 027** (shared packages): scaffolded workspace and kit skeleton
- **Task 028** (Backend builder): produces the tRPC router this builder's client calls
- **Task 032** (Reviewer agent): asserts contract compliance at PR review
- **Task 034b** (schemas): `BuildMobileFrontendOutput` schema covers return JSON
- **Task 035** (orchestrator): invokes in parallel with `/build-web-frontend`
- **Task 036** (HITL gates): sign-off verification binds kit version

## Acceptance Criteria

- [ ] `.claude/agents/mobile-frontend-builder.md` exists with STACK-AGNOSTIC frontmatter (`skills: []`) — no hardcoded expo-patterns / react-patterns skill references
- [ ] Agent reads `architecture.yaml.tooling.stack.mobile_framework` and loads `.claude/skills/agents/mobile/{slug}/SKILL.md` verbatim
- [ ] Aborts cleanly if `mobile_framework` is null (no mobile tier — tasks marked skipped)
- [ ] Aborts cleanly if the referenced stack skill is missing (no silent Expo fallback)
- [ ] System prompt embeds CONTRACT.md verbatim and drops React Native Reusables from the stack
- [ ] Framework-specific prose (Expo Router, NativeWind, Metro monorepo config, safe-area patterns) comes from the dispatched stack skill — NOT the agent's own system prompt
- [ ] For non-RN stacks (flutter, native-_): agent consumes kit tokens via stack-skill-specified mirrors (Dart file / Swift Colors.xcassets / JSON bundle); `data-kit-_` → stack-specific testID / a11y identifier translation per stack skill
- [ ] Skill runs `features[].tasks[]` filtered by `agent: mobile-frontend-builder` AND feature's `skip[]` does NOT include `mobile` (refactor-004 v2 tasks.yaml)
- [ ] Skill runs inside the feature's worktree at `.claude/worktrees/{features[i].worktree}/` (CWD handled by orchestrator per refactor-004)
- [ ] **feat-004 hybrid TDD**: builder generates happy-path sibling test file alongside every screen / component / hook per the stack skill's §Testing pattern (expo-rn: `.test.tsx` siblings; Flutter: matching `_test.dart`; native stacks per their skill)
- [ ] **feat-004 coverage**: builder runs test command with coverage flag; asserts ≥ 60% line coverage on authored files per `.claude/rules/testing-policy.md`
- [ ] **feat-004 scope discipline**: builder does NOT write Maestro E2E flows / integration tests; those are tester's scope (`.maestro/*.yaml` authored by tester)
- [ ] Agent reads `.claude/rules/testing-policy.md` at dispatch time; testing-policy cross-reference in system prompt
- [ ] `.claude/skills/build-mobile-frontend/SKILL.md` exists
- [ ] Skill pins kit version from sign-off and aborts on mismatch
- [ ] Skill verifies every platform-sensitive primitive has a `.native.tsx` sibling; aborts with clear error if missing
- [ ] Skill emits kit-change-request and halts on unmappable HTML — does not build locally
- [ ] Skill runs `pnpm ui-kit:validate-consumer` + typecheck + lint post-generation
- [ ] Retry-with-feedback on enforcement failure (max 3 attempts)
- [ ] NativeWind config points at the kit's Tailwind preset (single source of truth)
- [ ] Root layout imports `@repo/ui-kit/styles/globals.css`
- [ ] No `components/` directory in `apps/mobile/` for UI
- [ ] No `react-native-reusables`, `native-base`, `tamagui`, etc. in `apps/mobile/package.json`
- [ ] `app.json` configured from architecture.yaml with unique bundleIdentifier, correct permissions, deep linking scheme
- [ ] Return JSON matches `BuildMobileFrontendOutput` in 034b
- [ ] Runs in parallel with `/build-web-frontend`
- [ ] HTML → JSX translation uses `data-kit-*` attributes (emitted by 025), identical mechanism to 029; Tailwind classes stripped from JSX output
- [ ] Depends on 028 (backend) because `@repo/api-client` hooks are typed against the tRPC router 028 produces
- [ ] NativeWind CSS ingestion uses `metro.config.js` + `withNativeWind({ input: ... })` pointing at the kit's `globals.css` — NOT a runtime CSS import
- [ ] `validate-consumer` glob covers both `apps/mobile/app/**` (Expo Router routes) AND `apps/mobile/src/**` (lib / helpers)

## Human Verification

1. Run `/build-mobile-frontend` after sign-off. Does `apps/mobile/` get generated?
2. Does every screen import from `@repo/ui-kit` and nothing else for UI? `grep -rE "from ['\"]@repo/ui-kit['\"]" apps/mobile/app/ | wc -l` — non-zero?
3. Run `grep -rE "native-base|react-native-reusables|tamagui|nativewind/components" apps/mobile/`. Zero matches?
4. Does `pnpm --filter mobile typecheck` pass?
5. Does NativeWind resolve the same tokens as web (open a screen, inspect runtime style; does the accent color match the web build)?
6. Remove a `.native.tsx` file from the kit. Does the builder abort with a clear "missing .native.tsx variant" error?
7. Hand-inject `Platform.OS === 'ios' ? ...` in a generated screen. Does the next enforcement run flag it as a contract violation?
