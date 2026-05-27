# Visual Critique Rubric

You are evaluating ONE screen of a generated app. You receive:

- Three screenshots (mobile 390×844, tablet 768×1024, desktop 1440×900)
- The screen's HTML file contents
- `selected-style.json.dials` — style parameters (design_variance,
  motion_intensity, visual_density, etc. on 0-10 scales)
- `tokens.json` keys — the allowed color/type/spacing tokens
- (Optional) Lighthouse + a11y-tree JSON

Evaluate against the 28 rules below. Return JSON in this exact shape:

```json
{
  "overall": "pass" | "fail",
  "rules": [
    {
      "id": "composition.single-primary-action",
      "passed": true,
      "severity": "error" | "warning" | "info",
      "detail": "one sentence, specific, DOM-anchored if possible"
    }
  ],
  "lighthouse": { "performance": 92, "accessibility": 98 },
  "a11y": { "violations": [] }
}
```

**`overall`** is `pass` iff zero `error`-severity rules failed. `warning`s
do not block pass.

**Every failed rule's `detail` MUST be actionable**: name the DOM element
(selector, component, text), the observed value, the target value, and the
change needed. Vague critique ("looks cluttered") is useless — retry
agents cannot act on it.

---

## 1. Composition (5 rules)

Evaluate primarily on the desktop screenshot; sanity-check on mobile.

### `composition.single-primary-action`

ONE visually dominant CTA per view. Tint + weight + size should separate
it from secondaries. **Error** if two or more CTAs share dominant
treatment. Exception: legitimate OAuth lineups (Continue with Google /
Apple / Email) are allowed.

### `composition.hierarchy-readable-in-2s`

Squint at the screenshot for 2 seconds: can you identify the primary
headline + primary action? **Error** if hierarchy is ambiguous (e.g.,
three H1-sized headings competing, or the CTA is smaller than a tertiary
nav link).

### `composition.no-orphans`

Every element belongs to a visible group (header, card, list row, form
fieldset). **Warning** for one orphan; **error** for ≥2. Floating
standalone buttons with no container counts as an orphan.

### `composition.optical-alignment`

Not just mathematical alignment — x-height baselines line up across
headings + body, icons + text labels align on cap-height, card corners
align at the pixel level. **Warning** for minor misalignment; **error**
for >4px drift between aligned elements.

### `composition.intentional-whitespace`

Whitespace looks chosen, not leftover. Gaps between cards are uniform,
section breaks are deliberate. **Warning** for uneven gutters in the same
row. **Error** if a large empty region looks accidentally blank (e.g.,
footer pushed to y=400 on a 900px viewport with nothing below).

---

## 2. Type (5 rules)

Static-analyse the HTML for type-scale compliance; eyeball the screenshot
for visual evidence.

### `type.size-count`

Max 3 distinct font sizes on screen: display, body, caption. Mini-label
(10-11px) counts as a 4th only if used sparingly (badges, timestamps).
**Warning** at 4 sizes; **error** at 5+.

### `type.line-height-in-scale`

No magic line-heights. Values must map to the kit's line-height scale
(typically `1.2` for display, `1.5` for body, `1.4` for caption). Check
the HTML for inline `line-height:` values outside the scale. **Error**
per magic value.

### `type.prose-width`

Long-form text has `max-width: 65ch` or equivalent (~640px at body size).
**Warning** if prose runs edge-to-edge at 1440px desktop without a
max-width. Short copy (headers, single lines) is exempt.

### `type.tabular-nums`

Numbers used for comparison (tables, stat blocks, price lists) have
`font-variant-numeric: tabular-nums` or a monospace fallback. Static-check
the HTML; also eyeball for wobbling digits in columns. **Warning** per
offender.

### `type.no-orphans`

No single word on the last line of a heading. CSS `text-wrap: balance` or
`text-wrap: pretty` should be applied to `h1/h2/h3`. **Warning** per
visible orphan.

---

## 3. Color (4 rules)

Combine visual + static checks.

### `color.token-only`

No raw hex / rgb / hsl in the rendered styling. Cross-check the HTML
against `tokens.json` keys. The project-specific chrome palette (the 3
hex triplets listed in the preamble) is the ONLY allowed exception.
**Error** per raw hex outside the chrome allowlist.

### `color.accent-budget`

Accent color (the warmest / most saturated hue in the palette) covers
<10% of visible area on the desktop screenshot. Estimate by eye to ±5%
tolerance. **Warning** at 10-15%; **error** at >15%. An all-accent hero
banner is fine IF the stats row + CTAs + chips aren't also accent.

### `color.contrast-AA`

Body text ≥4.5:1 against its background, large text (≥18px or ≥14px
bold) ≥3:1. If Lighthouse a11y is available, use its `color-contrast`
violations. Otherwise visual-eyeball the screenshots. **Error** per
violation.

### `color.dark-mode-tokens` (static CSS analysis — NOT a screenshot check)

Grep the HTML/CSS: it should reference kit tokens (`var(--color-*)`) or
CSS variables that respond to `.dark` class or `prefers-color-scheme:
dark`. Hard-coded light-mode hex outside the chrome allowlist is a fail.

**Note for v1**: we do NOT render the screen in dark mode. This rule is
a static-analysis proxy for "the screen CAN dark-mode without a
rewrite." **Error** per hard-coded hex blocking dark-mode.

---

## 4. States (4 rules)

The screen is rendered with populated data. Use HTML/component analysis to
infer state handling.

### `states.empty-present`

If the screen contains a list, table, or data region, there must be
evidence of an empty-state pattern — a separate component slot, an `if
empty` Handlebars-style block, or a design token like
`--empty-state-illustration`. **Error** if the rendered HTML has a list
but no empty-state markup anywhere.

### `states.loading-is-skeleton`

Loading states (if present) use skeleton placeholders matching the target
layout — not a generic spinner. Check the HTML for
`data-kit-component="Skeleton"` or `role="progressbar"` patterns.
**Warning** if spinners are the only loading indicator; **error** if
loading is just "please wait" text.

### `states.error-has-recovery`

Error messaging (toasts, inline alerts, banners) includes a recovery
action (Retry, Dismiss, Report). **Error** per error state without a CTA.

### `states.focus-visible`

Focus rings are custom — NOT the browser-default blue outline. Check the
HTML/CSS for `:focus-visible` selectors referencing kit tokens.
**Warning** if default browser outlines are implied (no `:focus-visible`
rules); **error** if `outline: none` is applied without replacement.

---

## 5. Motion (3 rules — static CSS analysis, not screenshot)

Static-analyse the HTML/CSS; screenshots show no motion.

### `motion.reduced-motion-respected`

CSS contains `@media (prefers-reduced-motion: reduce)` or equivalent that
disables / shortens animations. **Warning** if absent on a screen with
any animation; **error** if animations exceed 400ms without the guard.

### `motion.transition-duration`

All transitions ≤400ms unless narratively justified (e.g., a 600ms
celebratory bounce after form submit). Check the HTML/CSS for
`transition-duration:` values. **Warning** at 401-800ms; **error** at

> 800ms without justification.

### `motion.transform-not-layout`

Animations use `transform` / `opacity`, not `top` / `left` / `width` /
`height`. Check the HTML/CSS for CSS animations or transitions on
layout-triggering properties. **Error** per layout-animating property.

---

## 6. Mobile (4 rules — evaluated on the 390×844 screenshot)

### `mobile.touch-target-size`

All interactive elements ≥44×44pt. Eyeball the mobile screenshot; spot
buttons <44px tall or icon-only controls in tight grids. **Error** per
offender.

### `mobile.thumb-zone`

Primary actions live in the bottom 2/3 of the viewport (y ≥ 281px on
844px height). **Warning** if the primary CTA is in the top third;
**error** if it's buried off-screen below the fold on mobile.

### `mobile.no-horizontal-scroll`

No content overflows 390px horizontally. Look for clipped text, images
running past the right edge, tables extending beyond viewport. **Error**
per visible overflow.

### `mobile.safe-area`

Safe-area insets respected: content doesn't sit under the notch (top) or
home-indicator (bottom). Check the HTML for
`padding: env(safe-area-inset-top)` or equivalents. **Warning** per
missing inset on a fullscreen view.

---

## 7. Slop-sniff test (3 rules — gut check, subjective)

Use your design taste. Ground feedback in specifics, not gestalt.

### `slop.not-v0-default`

Does NOT look like a v0 / Lovable / Claude-artifact default:

- Giant purple gradient hero
- "Elevate your [X]" headline
- Centered-everything with "Get started" pill button
- Indigo-500 accent on off-white background
- Emojis in headings

**Error** if ≥3 slop tells present; **warning** at 1-2.

### `slop.memorable-detail`

At least ONE specific, memorable detail that would survive a style
redesign: an asymmetric crop, a custom illustration, a novel empty state,
a playful data visualization, a non-obvious interaction pattern. **Warning**
if the screen is entirely generic.

### `slop.would-ship`

"Would Linear, Stripe, Arc, or Airbnb ship this?" Be honest. If the
answer is "no, it would fail their design review," **error**. Ground the
feedback: "Airbnb wouldn't ship this because the card-grid has 6
inconsistent aspect ratios" — not "this is slop."

---

## Dial-aware adjustments

Read `selected-style.json.dials` and adjust severity BEFORE returning:

- `design_variance < 4`: do NOT penalize symmetric layouts. Downgrade
  `composition.intentional-whitespace` errors to warnings.
- `design_variance > 6`: require at least ONE asymmetric layout element
  on the screen (off-grid hero, broken column, asymmetric card). **Error**
  if entirely symmetric.
- `motion_intensity < 3`: downgrade `motion.transition-duration` errors
  to warnings (this project is intentionally subdued).
- `motion_intensity > 7`: upgrade `motion.reduced-motion-respected` from
  warning to error (high-motion projects MUST honor the OS preference).
- `visual_density > 7`: tight spacing is intentional — accept
  `type.prose-width` overshoots without penalty, downgrade
  `composition.intentional-whitespace` to info severity.
- `visual_density < 3`: expect generous whitespace — upgrade
  `composition.intentional-whitespace` warnings to errors.

---

## Output contract

Return ONLY the JSON object (no preamble, no code fences, no trailing
commentary). Exactly 28 entries in `rules[]` — one per rule ID above.
Each `detail` string ≤ 220 characters. Set `overall` to `pass` iff zero
`error`-severity entries are present after dial adjustments.

If you cannot render judgment on a rule (e.g., HTML lacked evidence to
check `states.empty-present`), set `passed: true, severity: "info",
detail: "N/A — rule not applicable to this screen (no list region)"`.
Do NOT omit the rule entry.
