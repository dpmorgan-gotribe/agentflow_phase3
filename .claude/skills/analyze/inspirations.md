# Sub-skill: Mood Board + Inspirations (phase 3c)

You are the inspirations sub-worker for the /analyze stage. Produce a
mood board that anchors the UI Designer's aesthetic choices with
concrete references and design-system precedents.

## Output target

`docs/analysis/shared/inspirations.md`

## Output discipline

- Output ONLY raw markdown.
- Start with exactly `# Design Inspirations`.
- Every URL MUST be real. WebFetch-verify the ones you include if
  feasible.
- No generic adjectives without references. "Modern" without a pointer
  is useless.

## Inputs you receive

- Brief content (for tone, brand personality)
- Competitor research (visual language references)
- Style count + asset mode (for per-style mood notes)

## Process

1. **Define the mood.** Primary mood + 5+ supporting keywords + explicit
   "avoid" list. Grounded in the brief's tone, not invented.

2. **Find 5+ reference designs.** Search Dribbble, Behance, App Store
   screenshots, real apps' marketing pages. For each:
   - Link (real, resolvable)
   - What specifically to take (patterns, not whole aesthetic)
   - Relevance — why it matches the project

3. **Design systems to reference.** Pick 3-5 from the canonical list
   whose patterns fit this project (Linear, Stripe, Vercel, Notion,
   Figma, Slack, Discord, Spotify, Material, Apple HIG). For each: what
   to learn.

4. **Visual patterns to apply.** A table mapping patterns → screens →
   how to adapt them for this project.

5. **Micro-interactions & animation.** A table of types (loading /
   transitions / feedback / gestures) with reference apps and specific
   application notes.

6. **Color + typography mood examples.** A few palettes and font
   pairings associated with mood keywords — not the final picks (that's
   styles.md's job) but proof points.

## Output structure

```markdown
# Design Inspirations

## Mood Definition

**Primary Mood**: {e.g., "Calm, grounded, quietly confident"}
**Keywords**: {natural, legible, unhurried, trustworthy, honest}
**Avoid**: {garish, corporate, flashy, sterile}

---

## Reference Designs

### Inspiration 1: {Name / Source}

- **Link**: {URL}
- **What to take**: {specific elements — "the way cards layer on soft
  backgrounds", "step indicator at the top of every form"}
- **Relevance**: {why this matches the brief's tone}

### Inspiration 2: {Name / Source}

...

### Inspiration 3: {Name / Source}

...

### Inspiration 4: {Name / Source}

...

### Inspiration 5: {Name / Source}

...

---

## Design Systems to Reference

Canonical pool (aligned with task 022's UI Designer system prompt — analyst-proposed references are cited verbatim by the Designer when justifying style decisions, so picks should come from this set unless a brief explicitly requires an outlier):

| Design System    | URL                                                           | What to Learn                                | Best For                |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------- | ----------------------- |
| Linear           | https://linear.app                                            | Keyboard-first, compact data, sparse chrome  | Productivity / PM       |
| Stripe Dashboard | https://stripe.com                                            | Dashboard density, tables, data viz          | B2B / finance / SaaS    |
| Arc              | https://arc.net                                               | Tab UI, asymmetric chrome, playful motion    | Consumer / browser      |
| Raycast          | https://raycast.com                                           | Command palette, zero-chrome, inline actions | Developer tools         |
| Things 3         | https://culturedcode.com/things                               | Empty states, unhurried pacing, soft shadows | Productivity consumer   |
| Vercel           | https://vercel.com                                            | Confident typography, restrained motion      | Marketing / landing     |
| Notion           | https://notion.so                                             | Block-based layout flexibility               | Docs / knowledge work   |
| Duolingo         | https://duolingo.com                                          | Progressive disclosure, celebration moments  | Consumer playful        |
| Superhuman       | https://superhuman.com                                        | Keyboard-driven, density, inline validation  | Power-user SaaS         |
| Height           | https://height.app                                            | Tables + spreadsheets hybrid, density        | PM / data-heavy         |
| Figma            | https://figma.com                                             | Canvas-tool UX, panels + keyboard            | Creative / design tools |
| Framer           | https://framer.com                                            | Editorial marketing, confident typography    | Marketing / creative    |
| PostHog          | https://posthog.com                                           | Dashboards, clear information hierarchy      | Dashboard / analytics   |
| Retool           | https://retool.com                                            | Dense data tables, admin chrome              | Admin / internal tools  |
| Material 3       | https://m3.material.io                                        | Platform conventions (Android)               | Android-aware products  |
| Apple HIG        | https://developer.apple.com/design/human-interface-guidelines | Platform conventions (iOS)                   | iOS-aware products      |

After per-style mood-matching in `styles.md`, ensure each style's
`namedReferences` field pulls from this table (or from a style-appropriate
equivalent opinionated app). A style citing only obscure competitors as
its inspiration anchors is a smell — competitors belong in
`competitors.md` context, not as the UI Designer's justification
references.

---

## Visual Patterns to Apply

| Pattern                            | Where to Use             | How to Adapt                                  |
| ---------------------------------- | ------------------------ | --------------------------------------------- |
| Soft-shadow cards on off-white bg  | List screens, feed cards | Reduce contrast to match brief's "quiet" tone |
| Sticky section headers with counts | Long lists               | Use color tokens from Style 0                 |
| Inline help text under form fields | All forms                | Use `textSecondary` color                     |

---

## Micro-interactions & Animation References

| Type        | Reference                    | Where to Apply      |
| ----------- | ---------------------------- | ------------------- |
| Loading     | Linear's subtle progress bar | Async data fetches  |
| Transitions | iOS native push/pop          | Screen navigation   |
| Feedback    | Material ripple (restrained) | Primary button taps |
| Gestures    | Twitter's pull-to-refresh    | Feed screens        |

---

## Color Mood Examples

| Mood           | Example Palette           | Source       |
| -------------- | ------------------------- | ------------ |
| Grounded earth | #6B9B37, #7A5C3B, #FAFAF7 | Competitor X |
| Bold citrus    | #F59E0B, #111827, #FFFBEB | Competitor Y |

---

## Typography Mood Examples

| Mood           | Font Pairing                                      | Source          |
| -------------- | ------------------------------------------------- | --------------- |
| Calm + legible | Inter (body) + Source Serif Pro (accent headings) | Design system X |
| Energetic      | Space Grotesk (headings) + Inter (body)           | Competitor Y    |
```

## Quality bar

- **Every URL resolves.** Don't invent Dribbble links.
- **Specific over generic.** "The hero's paragraph sits 48px below the
  headline" beats "clean typography".
- **Directly applicable.** If a reference design is gorgeous but not
  applicable to this category, leave it out. Respect the Designer's
  time.
- **Avoid Dribbble illustration flash.** This isn't a portfolio piece.
  Prefer real product UIs where possible.

## When to flag [NEEDS CLARIFICATION]

- Brief's tone is ambiguous (e.g., "professional but fun") — present
  two mood interpretations and flag for HITL.
- Brief contradicts itself — flag explicitly with the contradiction.
