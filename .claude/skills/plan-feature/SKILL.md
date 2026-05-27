---
name: plan-feature
description: Create a new feature implementation plan. Use when adding new functionality or capabilities to the system.
when_to_use: new feature, new capability, adding functionality, enhancement
argument-hint: [feature-description]
allowed-tools: Read Write Bash Grep Glob
---

# /plan-feature — Create Feature Implementation Plan

Create a structured feature plan so implementation is deliberate, tradeoffs are
examined up front, and the work is tracked through approval and completion.

## Steps

### 1. Get feature description

- If `$ARGUMENTS` is provided, use it as the feature description
- If empty, ask the user: "Describe the feature — what new capability should the system gain, and what problem does it solve?"

### 2. Check for existing related work

- If a `/check-existing-work` skill exists, invoke it with the feature keywords and let it handle the search
- Otherwise, fall back to raw grep:
  - `grep -rli "<keywords>" plans/active/ 2>/dev/null`
  - `grep -rli "<keywords>" plans/archive/ 2>/dev/null`
  - `grep -rli "<keywords>" plans/superseded/ 2>/dev/null`
- If matches found, list each with its file path and one-line summary from frontmatter, then ask the user whether to proceed, supersede an existing plan, or abandon
- If a superseded match exists, read its `lessons-learned` section (if present) and surface key points before proceeding

### 3. Reference the brief

- If `brief.md` exists at project root, scan its section headings
- Identify the section(s) most relevant to this feature (common fits: §1 Vision, §4 Core Entities, §11 Screen Catalog, §12 Key Features Summary)
- Record the section reference for the Problem Statement (e.g., "Implements brief.md §12 Key Features Summary — password reset")
- If `brief.md` does not exist, proceed without reference — but note "no brief.md at plan creation time" in the plan

### 4. Generate plan ID

- Count existing feature plans across active AND archive AND superseded:
  `ls plans/active/feat-*.md plans/archive/feat-*.md plans/superseded/feat-*.md 2>/dev/null | wc -l`
- Next ID = count + 1, zero-padded to 3 digits
- Generate slug from the feature description: lowercase, hyphens, strip stop words (the, a, an, for, of), max 30 chars
- Full ID: `feat-{NNN}-{slug}` (e.g., `feat-001-user-auth`, `feat-012-dashboard-charts`)

### 5. Read the feature plan template

- Read `plans/templates/feature-plan.md` to get the structure

### 6. Fill in the plan

**Frontmatter:**

- `id`: the generated ID
- `type`: feature
- `status`: draft
- `author-agent`: your agent name, or `human` if user-initiated
- `created`: today's date (YYYY-MM-DD)
- `updated`: today's date
- `branch`: `feat/{slug}`
- `attempt-count`: 0
- `max-attempts`: 5
- `feature-area`: infer from description and codebase structure (e.g., `auth`, `dashboard`, `billing`); leave `null` if unclear
- `priority`: default `P2` unless the user specified otherwise
- `affected-files`: start empty — populated from codebase search below

**Body:**

- **Problem Statement** — Expand the user's description into a crisp "what problem this solves, for whom". Include the brief.md section reference from step 3 if applicable.
- **Approach** — Write numbered implementation steps. Be specific about files, modules, and patterns (e.g., "1. Create Zod schema in `packages/types/src/user.ts`. 2. Add tRPC router in `apps/api/routes/user.ts`. 3. Build UI component in `apps/web/settings/`"). If the codebase is empty or early-stage, propose the file paths the feature should introduce.
- **Rejected Alternatives** — **REQUIRED: at least one alternative must be listed with reasoning for rejection.** This forces examining tradeoffs before implementation. Do not leave this section with just the placeholder. If you cannot think of an alternative, ask the user: "What other approach did you consider and reject, and why?"
- **Expected Outcomes** — 3-5 testable checkboxes that define "done". Each must be independently verifiable (e.g., "User can reset password via email link", not "Password reset works").
- **Validation Criteria** — Specific tests that must pass, manual verification steps, and performance thresholds if applicable.
- **Attempt Log** — Leave empty — populated by executing agents.

**Affected files:** Search the codebase for files the feature will touch:

- `grep -rli "<keywords>" apps/ packages/ 2>/dev/null | head -15`
- Include files likely to need edits AND files the feature will create
- Record as a list under `affected-files` in frontmatter

### 7. Write the plan

- Write to `plans/active/feat-{ID}-{slug}.md`

### 8. Create git branch

- Check current branch: `git branch --show-current`
- Check for uncommitted changes: `git status --short`
- Create and switch to feature branch: `git checkout -b feat/{slug}`
- If the branch already exists, warn but do not fail — switch to it: `git checkout feat/{slug}`
- If there are uncommitted changes that would conflict with the checkout, warn the user but still create the plan file (don't let git issues block plan creation); instruct them to stash or commit first, then run `git checkout feat/{slug}` manually

### 9. Update the active manifest

- Read `plans/active.md`
- Add a new row to the table with:
  `| feat-{NNN}-{slug} | feature | draft | {priority} | feat/{slug} | {one-line summary} |`
- Write updated `plans/active.md`

### 10. Report to user

Report exactly:

```
Feature plan created: plans/active/feat-{ID}-{slug}.md
Branch: feat/{slug}
Status: draft — review the plan and approve (status → approved) to start implementation.

Rejected Alternatives captured: {N}   ← must be ≥ 1
Brief reference: {brief.md §X or "none — no brief.md at creation time"}
```

## Edge Cases

- **Rejected alternatives absent**: If after filling the plan the Rejected Alternatives section is empty or still holds only the template placeholder, DO NOT write the plan. Prompt the user for at least one alternative and reason, then retry.
- **Very similar archived plan exists**: Prominently warn — "A similar feature was built or abandoned before. READ `plans/archive/feat-{NNN}-...md` and its lessons before starting. Consider whether this should supersede that plan instead (fill `supersedes` in frontmatter)."
- **Superseding an existing plan**: If the user chose to supersede in step 2, set `supersedes: feat-{NNN}-{old-slug}` in the new plan's frontmatter, and update the old plan's `superseded-by` field and status to `superseded` in the same run.
- **`$ARGUMENTS` is empty**: Do not generate a generic plan. Always prompt for a real description before proceeding — a vague plan is worse than no plan.
- **Brief.md validation fails**: If `brief.md` exists but is malformed (e.g., `/validate-brief` would fail), proceed with the plan but note in the Problem Statement: "WARNING: brief.md did not pass validation at plan creation — reference may be unreliable."
