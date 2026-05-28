---
id: feat-001-stylesheet-component-shapes
type: feature
status: draft
author-agent: Claude (Phase 3 build)
created: 2026-05-28
updated: 2026-05-28
parent-plan: investigate-001-phase3-stylesheet-screens-quality-regression-vs-phase2
supersedes: null
superseded-by: null
branch: feat/stylesheet-component-shapes
affected-files:
  - .claude/skills/stylesheet/SKILL.md
  - .claude/skills/screens/SKILL.md
  - .claude/agents/ui-designer.md
  - packages/orchestrator-contracts/src/stylesheet.ts
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
---

# feat-001-stylesheet-component-shapes: /stylesheet extracts component default-shapes + named patterns from the selected mockup, not just tokens

## Problem Statement

`/stylesheet` today extracts only the **token layer** from the selected mockup — colors, font families, radius/spacing/shadow VALUES, motion timings. It does NOT extract the **component default-shape layer** (Button's default `rounded-*`, padding, weight, hover treatment) or the **named-pattern layer** (logo+brand-mark wordmark, floating hero stat cards, trust-bar strip, section-tag eyebrow, header/nav composition).

Result, empirically observed in investigate-001 on `projects/test-app` running the gulia-captured "Spark Studio" mockup:

- The gulia mockup uses **pill-shaped buttons** (`border-radius: var(--radius-pill)` = 999px). The kit's Button primitive defaults to `rounded-md` (12px). Every Button variant in `design-system-preview.html` lines 1551/1570/1578 renders flat-cornered. /screens then composes `rounded-md` buttons on every screen.
- The gulia mockup has a distinctive header: 68px tall, fixed, `backdrop-filter: blur(16px)`, `rgba(250,250,248,0.92)` background, pill-shaped link buttons (`padding: 6px 14px`), with a custom `.nav-logo` + `.logo-spark` (28×28 orange brand mark) wordmark composition. **No Nav / Header / Logo primitive exists in `design-system-preview.html` at all** — the section list jumps from "Hero composition" to "Service overview". /screens then invents a generic header per screen.
- The gulia mockup uses **floating overlay cards** on the hero image (`.hero-card-float` with warm shadow, lucide icon + value + label — the "48hrs / 3.2× client growth" stat tiles). Not captured as a kit primitive or pattern.
- The gulia mockup uses a **trust-bar strip** (named-brand logos in mono uppercase under the hero). Not captured.
- The gulia mockup uses a consistent **section-tag eyebrow** above each section heading (small mono uppercase label). Not captured as a pattern.
- The gulia mockup uses a **spark-mark-on-wordmark logo treatment** (orange square brand mark + wordmark text). Not captured as a kit asset.

Parent investigation `investigate-001` walked the regression and pinpointed `/stylesheet`'s token-only extraction as the upstream cause of the downstream `/screens` quality drop the operator scored at 1/10 vs Phase 2's same-brief output. Until the kit's component layer matches the mockup, no amount of `/screens` work can produce a great product — `/screens` reaches for the kit's Button and gets the wrong shape, reaches for the kit's Nav and finds nothing.

**Brief reference:** factory-level work, no project `brief.md` applies. Empirical motivator lives in `plans/active/investigate-001-…`.

## Approach

Three-pass extraction inside `/stylesheet`, in order. The token-extraction pass that already works is unchanged; the two new passes run after it on the same selected-mockup HTML inputs.

### Pass 1 — Token extraction (UNCHANGED)

`/stylesheet` already does this correctly. Reads colors, fonts, radius/spacing/shadow values, motion timings from the mockup's `<style>` block + inline values, writes `packages/ui-kit/src/tokens/{tokens.css,tokens.json,tokens.ts}`, `packages/ui-kit/src/styles/{fonts.css,globals.css}`, `packages/ui-kit/tailwind.config.cjs`. No change.

### Pass 2 — Component default-shape extraction (NEW)

For each primitive in the kit's components plan (`Button`, `Link`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`, `Tabs`, `Avatar`, `Tooltip`, `Toast`, `Modal`, `Drawer`, `Skeleton`, `EmptyState`, `Hero`, `Nav`, `Logo`, …):

1. Locate one or more instances of that primitive in the selected-mockup HTML (`docs/mockups/{styleId}/webapp/*.html`). Identification heuristics:
   - **Button**: `<button>` elements + `<a>` styled as buttons (look for `.btn-*` classes, `padding`, `border-radius`, weight ≥ 500).
   - **Card**: any element with `border-radius` ≥ md AND `padding` ≥ 16px AND distinct background or border.
   - **Badge**: small inline element with `border-radius: pill` AND `font-size` ≤ sm.
   - **Nav**: `<nav>` element OR fixed-position element at the top of the document with link list.
   - **Logo**: brand mark element inside the nav, typically a small image / svg / icon + wordmark text.
   - **Hero**: first `<section>` after the header, full-width or near-full-width.
   - (etc.; full table in skill body)
2. For each found instance, extract its computed default visual contract:
   - `borderRadius` (named to the closest kit token, e.g. `radius-pill` → `rounded-full`)
   - `padding` (named to closest spacing token)
   - `fontWeight`, `fontSize`, `lineHeight`
   - `boxShadow` (named to closest shadow token)
   - Hover treatment (transform, color shift, shadow change)
   - For Nav: height, backdrop, fixed/sticky, link button shape
   - For Logo: composition (brand-mark + wordmark vs wordmark-only), brand-mark shape + color
3. Write each primitive's default-shape into:
   - `packages/ui-kit/src/patterns/components/{primitive}.html` (the kit's canonical preview of that primitive in this kit's flavor) — emits the data-comp + Tailwind-class composition the screens compositor should reach for
   - `design-system-preview.html` (gate-3 review artefact) — must contain at minimum one rendered instance of EVERY primitive in the kit's component plan
4. The `data-comp="<Primitive> · <variant> · …"` annotation already used in `design-system-preview.html` stays; the NEW guarantee is that the default-variant render matches the mockup's instance.

### Pass 3 — Named-pattern extraction (NEW)

For multi-element compositions that don't fit a single primitive, extract them as **named patterns** in `packages/ui-kit/src/patterns/`:

1. Scan the mockup for repeated multi-element shapes:
   - **`Wordmark`** — logo composition (brand-mark + wordmark text combo, used in nav + footer)
   - **`Eyebrow` / `SectionTag`** — small mono uppercase label preceding a section heading
   - **`StatTile` / `FloatingStat`** — small card with icon + numeric value + label (the "48hrs" / "3.2×" overlay)
   - **`TrustBar`** — strip of named-brand logos under hero (or above footer)
   - **`MarqueeStrip`** — scrolling client/partner roster
   - **`HeroBadge`** — small pill above the H1 (e.g. "Now taking on new projects")
   - **`SocialProofRow`** — avatar stack + count + line of text ("50+ brands launched")
   - **`ServicePillarCard`** — large card with icon badge, heading, body, bulleted list, "Explore →" CTA
   - **`CaseStudyCard`** — image + tag + title + outcome stat
2. For each pattern found, emit a file `packages/ui-kit/src/patterns/{pattern-slug}.html` containing:
   - The pattern's canonical composition (HTML + Tailwind classes, drawing on the kit's primitives)
   - A `<style>` block ONLY if the pattern requires custom CSS not expressible in Tailwind + the kit's already-extracted tokens (rare; preferred path is to express via existing tokens)
   - A `data-pattern="{slug}"` attribute on the root element
3. Patterns are addressable by `/screens` via filename. When `/screens` composes a screen and recognizes a section as matching a pattern, it embeds the pattern reference instead of recomposing from scratch.
4. The kit's `UI-KIT.md` consumption guide gets a `## Patterns` section listing all extracted patterns + when to reach for each.

### Output contract addition

`packages/orchestrator-contracts/src/stylesheet.ts` (`StylesheetOutput` Zod schema) gains:

- `componentsExtracted: { name: string; defaultVariantFile: string; mockupInstanceCount: number }[]` — what primitives got captured + how many mockup instances informed each.
- `patternsExtracted: { slug: string; file: string; instances: number }[]` — what patterns got captured.

These let the reviewer / sync-phase-plan / future audit see what the extraction covered.

### Acceptance test (design-system-preview parity)

Add a manual-or-tooled acceptance step to gate-3 review: render `design-system-preview.html` side-by-side with the selected mockup. For each primitive, the rendered preview should be **visually indistinguishable at the component-default-shape level** — same button shape, same nav, same logo treatment, same hero stat-card composition. Content may differ (preview shows components in a grid), layout differs (preview is index-style), but the component shapes themselves must match.

Tooling note: this can be automated later (vision-LLM compares preview vs mockup), but for v1 the acceptance is human-eyeballed during the existing gate-3 signoff.

### Screens compositor consumer-side change

`/screens` skill body (`.claude/skills/screens/SKILL.md`) gains a "use the kit's patterns/ directory before inventing" rule: when composing a screen section, the compositor first checks `packages/ui-kit/src/patterns/` for a matching named pattern and reaches for it before falling back to first-principles composition. This is a small addition (one §) — the heavy lifting is in /stylesheet.

### ui-designer agent consumer-side note

`.claude/agents/ui-designer.md` gains a §"Two-layer extraction" note documenting that the agent dispatched to /stylesheet now produces three layers (tokens + components + patterns), and the agent dispatched to /screens consumes all three.

## Rejected Alternatives

- **Alternative A — Make `/screens` read the mockup directly as a layout blueprint instead of fixing `/stylesheet`.**
  Rejected because: the operator's framing is correct that the kit should be the source of truth for component shapes — the mockup is a one-time visual reference; the kit is what every future screen reaches for. Fixing only `/screens` would mean every screen has to re-extract pattern intent from the mockup, instead of doing the extraction once at /stylesheet time and amortizing across all 12+ screens. Also: the kit is what code-gen consumers (web/mobile builders) consume in Mode B; if the kit doesn't have the right Button shape, builders generate the wrong React Button regardless of what /screens did. The kit MUST be correct upstream.

- **Alternative B — Add a "passthrough" option to `/screens` that preserves the mockup's `<style>` block verbatim when `selectedBy === "operator-direct"`.**
  Rejected because: this was my initial straw-man in investigate-001. It papers over the symptom (P3's screen looks flat) without fixing the cause (the kit doesn't actually know what the components should look like). A passthrough would also break the kit-only consumption contract that Mode-B builders depend on (custom CSS in screens doesn't translate to React+Tailwind builder output). The kit must capture the shape; the screen must compose from the kit.

- **Alternative C — Leave /stylesheet alone and document the gap as an ADR (kit-only-vs-mockup-fidelity tradeoff).**
  Rejected because: this is just deferring. The operator's empirical finding (Phase 3 produces a 1/10 score on what was a high-quality Phase-2 reference) means the gap is blocking new project quality TODAY. An ADR without code is a permission slip to keep shipping mediocre output. (The ADR can still be authored — see Validation Criteria — but as a SECONDARY artefact alongside the code change, not as a substitute.)

- **Alternative D — Have the operator manually edit the kit after /stylesheet to add the missing Nav / Logo / patterns.**
  Rejected because: the factory's entire value proposition is "spec → working app, without operator hand-holding." Pushing a 30-minute manual kit-fix step into every project is exactly the kind of factory regression the rebuild was supposed to eliminate. Also: the operator-direct mockup-injection case (P3 here) is rare; the common case is fresh-gen mockups where the operator never sees the mockup HTML directly. Manual editing doesn't scale.

## Expected Outcomes

- [ ] `/stylesheet` writes `packages/ui-kit/src/patterns/components/{primitive}.html` for every primitive in the kit's components plan, each rendering the mockup's default visual contract for that primitive (Button is pill-shaped when the mockup buttons are pill-shaped; Card has the right default radius + padding; Nav has the right height + backdrop + link-shape).
- [ ] `/stylesheet` writes `packages/ui-kit/src/patterns/{pattern-slug}.html` for every distinctive multi-element composition the mockup uses (minimum: Wordmark / Eyebrow / StatTile / TrustBar / HeroBadge / ServicePillarCard / CaseStudyCard when they appear in the mockup).
- [ ] `design-system-preview.html` contains a rendered instance of EVERY primitive in the kit's components plan, including a `Header / Nav / Logo` section that today is missing.
- [ ] `StylesheetOutput` Zod schema gains `componentsExtracted[]` + `patternsExtracted[]` fields, populated by the skill.
- [ ] Running `/stylesheet` on `projects/test-app` (Spark Studio mockup, gulia-captured) produces a `design-system-preview.html` whose Button primitive is pill-shaped (matching `mockups/style-3/webapp/home.html`'s `.btn-primary { border-radius: var(--radius-pill); }`) and contains a Nav primitive section.
- [ ] `/screens` skill body has a "use kit patterns before inventing" rule referencing the new patterns/ directory.

## Validation Criteria

**Empirical reproduction case (the test bench):**

- Use `projects/test-app` with the existing operator-injected gulia-captured `style-3` Spark Studio mockup (no re-mockup-gen required; the input is already in place).
- Wipe `packages/ui-kit/src/patterns/` and `docs/design-system-preview.html`. Re-run `/stylesheet`. Inspect outputs.

**Pass conditions:**

- `packages/ui-kit/src/patterns/components/button.html` exists and contains a button rendered with `rounded-full` (or equivalent kit alias for pill) — NOT `rounded-md`.
- `packages/ui-kit/src/patterns/components/nav.html` exists and renders the 68px-tall blurred-backdrop fixed header with pill link buttons + logo + CTA composition.
- `packages/ui-kit/src/patterns/wordmark.html` exists and renders the brand-mark-on-wordmark logo composition.
- `packages/ui-kit/src/patterns/stat-tile.html` exists and renders the floating hero stat composition.
- `packages/ui-kit/src/patterns/trust-bar.html` exists.
- `packages/ui-kit/src/patterns/eyebrow.html` exists.
- `design-system-preview.html` contains all of the above rendered live + a `<section id="header">` containing the Nav/Logo primitive.
- `StylesheetOutput`'s returned JSON has `componentsExtracted.length >= 10` AND `patternsExtracted.length >= 5`.

**Negative-regression test:**

- Re-run `/stylesheet` on `projects/test-app` with the (hypothetical) `style-0` mockup that has a minimal `<style>` block (modest decoration). Confirm the kit's Button primitive STILL has the right shape for that mockup (not pill if that mockup uses flat-cornered buttons). The extraction has to be mockup-faithful, not always-pill.

**Cross-stack contract:**

- The new patterns/ files use semantic HTML + Tailwind utilities + already-extracted kit tokens. They MUST NOT introduce custom CSS that escapes the token system (e.g. literal hex colors, magic-number spacings).
- `/screens` must successfully compose `home.html` from the kit + patterns and produce output that visually carries the mockup's Button pill-shape, Nav header, and section-tag eyebrows forward. Manual eyeball at gate-4.

**Secondary artefacts:**

- `DECISIONS.md` ADR-006 documenting the three-pass extraction model (tokens / components / patterns) so future stack-skill authors know the contract.
- `/sync-phase-plan` run at row close to fold the three-pass contract into `phase-plan.md` so the litmus test ("rebuild from phase-plan.md should produce the currently-shipped system") holds.

**Performance:**

- `/stylesheet` runtime per the kit's complexity should not regress more than 50% vs current (currently ~$0.5-1.0 per run on Sonnet at building tier; new passes add ~30% LLM work for pattern detection — budget $2 cap in `~/.claude/models.yaml` accommodates this).

## Attempt Log

<!-- Populated automatically by agents. -->
