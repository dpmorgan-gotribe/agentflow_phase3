---
id: kit-change-request-{id}
type: refactor
status: draft
created: YYYY-MM-DD
updated: YYYY-MM-DD
branch: design/kit-bump-{id}
affected-files:
  - packages/ui-kit/CHANGELOG.md
  - packages/ui-kit/src/primitives/{NewComponent}.tsx # or patterns/ or layouts/
  - packages/ui-kit/src/primitives/{NewComponent}.variants.ts
  - packages/ui-kit/src/primitives/{NewComponent}.stories.tsx
  - packages/ui-kit/src/primitives/index.ts
  - packages/ui-kit/src/index.ts # public barrel
feature-area: ui-kit
priority: P1
attempt-count: 0
max-attempts: 3
---

<!-- Kit-change-request mini-plan authored by /pm --mode=kit-change-request.
Scoped to exactly ONE delta — one primitive, one pattern, or one layout.
Multi-primitive bundling is rejected by /pm as a design-cycle issue. -->

# Kit Change Request — {one-line summary}

## Requesting agent

{/screens | web-frontend-builder | mobile-frontend-builder}

## Emitting screen

{platform/screen-id} — e.g., `mobile/wallet`

## Missing primitive / pattern / layout

<!-- Quoted from docs/screens/kit-change-requests/{id}.md — the file the emitting
agent wrote. Describes what the current @repo/ui-kit doesn't provide. -->

{what the kit is missing, quoted from the request file}

## Proposed addition

<!-- EXACTLY ONE component / pattern / layout. If the request implies more
than one, /pm rejects it as a design-cycle issue that must escalate back
to /stylesheet. -->

{minimal delta to the kit — name, responsibilities, variants, accessibility
contract, stories coverage}

## Kit version bump

`{current-semver}` → `{proposed-semver}` (minor bump)

Reason: additive primitive/pattern/layout — no API break to existing consumers.

## Consumers requiring regeneration

<!-- Scan docs/screens-manifest.json for other screens that would benefit from
this component once it ships. List explicitly so the orchestrator's detour
can re-run /screens for each. -->

- `{platform/emitting-screen-id}` (emitted this request)
- `{optional — other screens the PM spotted}`

## Validation criteria

- [ ] New component has `.tsx` + `.variants.ts` + `.stories.tsx` + `index.ts` per kit convention
- [ ] Public barrel re-exports the new component
- [ ] Storybook entry builds
- [ ] Consumer-contract validator (`validate-consumer.ts`) passes against the regenerated kit
- [ ] Kit package.json version is the proposed semver
- [ ] CHANGELOG.md entry describes the addition + references this plan ID

## Attempt Log

<!-- Populated by /stylesheet when it executes this mini-plan during the
kit-change-request detour. -->
