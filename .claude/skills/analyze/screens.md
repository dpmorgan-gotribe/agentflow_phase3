# Sub-skill: Per-Platform Screens (phase 4, screens half)

You are the screens-extraction sub-worker for a specific platform. You
produce a v3.0-schema JSON with every screen, its navigation state,
components, icons, and flow memberships. This is the primary input to
`/mockups` and `/screens` downstream.

## Output target

`docs/analysis/{platform}/screens.json`

## Output discipline

- Output ONLY raw JSON. No code fences wrapping the output, no prose,
  no markdown.
- Validate against `schemas/screens.schema.json` before returning. If
  invalid, fix and retry — do not return invalid JSON.
- Use 2-space indentation for pretty-print.
- Every screen MUST have all required fields (see below).

## Inputs you receive

- Platform name (`webapp` | `mobile` | `admin` | `desktop`) — `PlatformId`
  per 034b's common.ts
- Brief slice for this platform
- `docs/analysis/{platform}/flows.md` (just produced — sibling output)
- `docs/analysis/{platform}/navigation-schema.md` (just produced)
- Full brief.md for context
- `companion/navigation-schema.json` if user-supplied

## v3.0 schema shape

```json
{
  "version": "3.0",
  "generatedAt": "2026-04-18T10:00:00Z",
  "app": {
    "appId": "runclub-mobile",
    "appName": "RunClub",
    "appType": "mobile",
    "layoutSkill": "mobile",
    "defaultNavigation": {
      "header": {
        "variant": "standard",
        "actions": ["search", "notifications"]
      },
      "footer": {
        "variant": "tab-bar",
        "tabs": ["feed", "record", "groups", "profile"]
      },
      "sidemenu": { "visible": false }
    },
    "screens": [
      {
        "id": "feed",
        "file": "feed.html",
        "name": "Group Feed",
        "description": "Primary social feed showing group activity",
        "section": "feed",
        "navigation": {
          "header": {
            "variant": "standard",
            "actions": ["search", "notifications"]
          },
          "footer": {
            "variant": "tab-bar",
            "tabs": ["feed", "record", "groups", "profile"],
            "activeTab": "feed"
          },
          "sidemenu": { "visible": false }
        },
        "components": ["header", "bottom-nav", "run-card", "fab"],
        "icons": ["menu", "search", "notifications", "add"],
        "flows": ["daily-check-in", "view-friends-runs"]
      }
    ]
  }
}
```

## Required fields per screen (ALL REQUIRED)

- `id` — kebab-case, unique within the app
- `file` — filename, `{id}.html`
- `name` — human-readable title
- `description` — 1 sentence, what the screen does
- `section` — matches a section id from navigation-schema.md
- `navigation` — object with:
  - `header`: `{ variant, actions }`
  - `footer`: `{ variant, tabs?, activeTab? }` (tabs + activeTab required when variant is `tab-bar`)
  - `sidemenu`: `{ visible, items?, activeSection? }` (items + activeSection required when visible is `true`)
- `components` — array, min length 2. Names from the standard primitive
  set: `header`, `bottom-nav`, `side-menu`, `card`, `button-primary`,
  `button-secondary`, `modal`, `form-input`, `avatar`, `badge`, `fab`,
  `chip`, `tab-bar`, `list-item`, `empty-state`, `error-state`,
  `toast`, `tooltip`, `drawer`, `skeleton`, etc. See task 024 for the
  canonical list.
- `icons` — array, min length 1. Icon names from the chosen library
  (Lucide names work as defaults: `home`, `search`, `menu`, `add`, etc.).
- `flows` — array, min length 1. Flow names matching those in
  `flows.md`. Use `miscellaneous` when the flow is a catch-all.

## App-level fields

- `appId` — platform-qualified identifier, e.g., `runclub-mobile`,
  `runclub-webapp`, `runclub-admin`. Kebab-case. Uses `PlatformId` as the
  suffix (matches `appType`).
- `appName` — human-readable app name.
- `appType` — one of: `mobile` | `webapp` | `admin` | `desktop`.
- `layoutSkill` — the skill key the layout primitive uses:
  - `mobile` for `appType: mobile`
  - `webapp` for `appType: webapp`
  - `desktop` for `appType: admin` or `appType: desktop`
- `defaultNavigation` — fallback navigation when a screen doesn't
  override. Use the most common section's navigation as default.

## Process

1. **Build the screen list.** From navigation-schema.md's `sections[].screens[]`,
   plus any screens in brief or companion/navigation-schema.json not yet
   captured. Deduplicate. Target 100% of screens from your flows.md.

2. **Enrich each screen:**
   - Section → from navigation-schema.md grouping
   - Navigation → inherit from section's nav in navigation-schema.md;
     override where the screen has specific nav (e.g., `activeTab`
     differs by screen)
   - Components → infer from screen description, flow position, and
     patterns. Always include `header` and one content primitive
     minimum.
   - Icons → derive from screen actions + navigation actions + context
   - Flows → look up which flows include this screen in flows.md

3. **Handle large briefs (>150 screens).** If your platform's brief
   slice has many sections, process each section separately, producing
   an intermediate chunk, then merge. Track unique screen IDs to avoid
   duplicates.

4. **Validate before returning.** Use
   `node scripts/validate-screens.mjs <your-json>` (the orchestrator
   supplies the validator path). Must pass before you return.

## Chunking pseudo-code

If the brief has sections (via navigation-schema.md's `sections[]`):

```
for section in sections:
    screens_in_section = extract_from_brief(section_id)
    chunk = build_screens_json(
        app_wrapper=section_id,
        screens=screens_in_section
    )
    all_chunks.append(chunk)

merged = merge_chunks(all_chunks)  # preserve unique IDs
output = validate_and_return(merged)
```

## Examples of good components + icons inference

- **Screen: `feed.html`**, section `feed` → components: `header`,
  `bottom-nav`, `run-card` (the repeated list item), `fab` (add/record
  button). Icons: `menu`, `search`, `notifications`, `add`.
- **Screen: `settings-account.html`**, section `settings` → components:
  `header`, `list-item`, `button-secondary` (destructive: delete
  account). Icons: `chevron-left`, `chevron-right`, `user`.
- **Screen: `signup.html`**, section `auth` → components: `form-input`,
  `button-primary`, `card`. Icons: `eye`, `mail`, `lock`.

## When to flag [NEEDS CLARIFICATION]

- Brief mentions a screen but doesn't describe its content — include
  the screen with minimal components (`header`, `card`) and flag in the
  description: `"NEEDS CLARIFICATION: screen purpose not specified in brief"`.
- Navigation state ambiguous for a screen — inherit section defaults and
  flag.
- Missing flow membership → use `miscellaneous` and flag.

## Critical rules

1. **This is JSON. Output ONLY JSON.** No prose before or after.
2. **Validate before returning.** Invalid JSON fails the whole stage.
3. **100% coverage of flows.md's screens.** Anything missing = orphan.
4. **Never fabricate screen IDs** not implied by the brief or the
   user's navigation schema.
