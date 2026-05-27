---
task-id: "018c"
title: "/draft-brief Skill"
status: complete
priority: P1
tier: 4 — Brief System
depends-on: ["015", "016", "017", "018b"]
estimated-scope: small
---

# 018c: /draft-brief Skill

## Why This Exists

Tier 4 as originally scoped (015 schema → 016 template → 017 validator → 018
scanner → 018b new-project) leaves a UX gap: `/new-project` scaffolds an
**empty** 20-section `brief.md`, then the user must fill all 20 sections by
hand before the Analyst (task 019) can do anything with it. For vibe coding
workflows — "I want to build X" → structured spec — that's the same
friction a traditional PRD template has. `/draft-brief` closes the gap by
translating a freeform proposal into a filled-in, schema-valid brief.md.

This task was added mid-build during the scaffolding session, after user
raised the question "if I propose a brief, how does it become the format
that's being validated?". Adding it here rather than deferring to a later
tier because the entire design pipeline (§022-025) needs real briefs to
test against.

## What This Task Produces

A skill at `.claude/skills/draft-brief/SKILL.md` that:

1. Accepts a freeform proposal via `$ARGUMENTS` (text, file path, URL, or
   empty-for-interactive)
2. Drafts all 20 sections of a brief.md, classifying each section as
   filled / inferred / TODO
3. Pre-fills frontmatter (project-name, author from git config, dates,
   inferred tags)
4. Runs `/validate-brief` on the result and reports any remaining errors
5. Supports re-runs that preserve existing user content by default

Plus an update to the existing `.claude/skills/new-project/SKILL.md` so a
single command can create a project AND draft its brief:

```
/new-project myapp --proposal "habit-tracking app for parents of toddlers"
/new-project myapp --proposal-file ./rough-idea.md
/new-project myapp --proposal-url https://example.com/spec.html
```

## Scope

### Input contract

| Arg form                          | Source                    |
| --------------------------------- | ------------------------- |
| `"<text>"` (plain string, no `/`) | treat as proposal text    |
| `<path>` (file exists)            | Read the file             |
| `http://...` or `https://...`     | WebFetch the URL          |
| (empty)                           | ask user conversationally |

### Section classification (for each of the 20 sections)

- **CLEAR** — content is explicit in the proposal. Write it directly. No TODO.
- **INFERABLE** — content can be derived with a reasonable assumption
  (e.g., proposal says "mobile app" → infer platform targets). Write it AND
  insert `<!-- TODO: review assumption — see {assumption-summary} -->`.
- **UNKNOWN** — not inferable from proposal. Keep the section's template
  guidance comment and add `<!-- TODO: fill this in -->`.

If 3 or more sections are UNKNOWN, the skill MUST ask targeted follow-ups
BEFORE writing — typical critical questions: "Who's the primary user?",
"What's the platform — web, mobile, both?", "Does it need auth?", "Any
regulated data — PII, health, financial?", "Free or paid?". Don't ask all
20 sections' worth — just the ones that gate multiple sections.

### Frontmatter pre-fill rules

- `project-name`: from the proposal's main noun, or from `<name>` if
  chained via `/new-project`
- `author`: from `git config user.name`
- `created` / `last-modified`: today's date
- `version`: `0.1.0` (draft version, user bumps to 1.0.0 on approval)
- `status`: `draft`
- `brief-schema-version`: `"1.0"`
- `tags`: inferred — pick 3-5 from {mvp, web, mobile, ios, android,
  fintech, health, social, dev-tools, b2b, b2c, marketplace, saas, crud,
  realtime, ai, …} based on proposal content

### Iteration model

- Re-running `/draft-brief` on a project with existing brief content
  **preserves** any section whose content ≠ the template's default
  `<!-- guidance -->` comment (user has edited it) AND ≠ `<!-- TODO: … -->`
  (skill's own placeholder).
- Sections still containing the original template guidance or the skill's
  TODO markers are eligible for re-drafting.
- `--overwrite` flag forces a clean regenerate. User confirmation required
  if existing brief passed validation.

### Integration with `/new-project`

Add three mutually-exclusive flags to new-project:

- `--proposal "<text>"` — raw proposal text
- `--proposal-file <path>` — path to a proposal file (absolute, or relative
  to CWD BEFORE `/new-project` switches into the project dir)
- `--proposal-url <url>` — URL to fetch

Flow: `/new-project` scaffolds the project AS USUAL. If any `--proposal*`
flag is supplied, it then invokes `/draft-brief` with the proposal from
within `projects/<name>/`. The scaffold's empty brief.md gets replaced by
the drafted version. `/validate-brief` runs last and its result appears in
the return payload.

### Reporting contract

Return exactly this shape (no HTML, no prose-only response):

```
Draft written: projects/<name>/brief.md
  Filled by AI: §1, §3, §6, §11, §12 (5/20)
  Inferred — review: §4, §5, §7, §8, §15 (5/20)
  Still TODO: §9, §13, §14, §16, §17, §18, §19, §20 (8/20)
  Frontmatter: pre-filled (project-name, author, dates, version, status, schema, 4 tags)
Validation: {pass | N errors — run /validate-brief --keep-going for details}

Next: review TODO sections and re-run `/draft-brief` with answers, or edit
brief.md directly.
```

## Acceptance Criteria

- [ ] `.claude/skills/draft-brief/SKILL.md` exists with the frontmatter
      above
- [ ] Supports all 4 input forms: text arg, file path, URL, empty
- [ ] Classifies every section as CLEAR / INFERABLE / UNKNOWN
- [ ] Asks follow-ups when ≥3 sections would be UNKNOWN
- [ ] Pre-fills frontmatter fields correctly
- [ ] Invokes `/validate-brief` at the end
- [ ] Re-runs preserve user-edited sections; `--overwrite` forces regenerate
- [ ] `/new-project` supports `--proposal`, `--proposal-file`,
      `--proposal-url` flags (mutually exclusive)
- [ ] `/new-project` with a proposal flag auto-invokes `/draft-brief`
      inside the new project
- [ ] Reporting contract followed exactly

## Human Verification

Fresh-init path with proposal:

1. `/new-project habit-tracker --proposal "Mobile habit tracker for
parents of toddlers. Track custom habits, streaks, daily reminders.
iOS first, Android later. No account — local-only data."`
2. `projects/habit-tracker/brief.md` exists with 20 sections
3. §1 Vision, §3 Problem, §6 Personas have meaningful content
4. §13 Security and §14 Regulatory are probably TODO (no regulated data
   implied) — confirm they're marked, not silently auto-filled
5. `/validate-brief` in the project passes frontmatter + codeblocks
6. `tags` includes `mobile`, `ios`, `b2c` (or similar inferred tags)

Re-run path:

7. Edit §1 by hand, then re-run `/draft-brief "..."` in the project
8. Your §1 edit is preserved
9. TODO sections get re-drafted if new info is in the re-proposal
10. `--overwrite` prompts for confirmation and then regenerates fully

## Downstream Dependencies

Unblocks:

- **019** Analyst / `/analyze` — assumes a filled-in brief.md
- Every design/build pipeline task (022-030) — needs real content to
  operate on, not empty placeholders
