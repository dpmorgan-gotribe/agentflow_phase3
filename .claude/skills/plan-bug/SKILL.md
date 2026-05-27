---
name: plan-bug
description: Create a new bug investigation plan. Use when encountering errors, unexpected behavior, or failing tests.
when_to_use: bug report, error, crash, failing test, unexpected behavior
argument-hint: [bug-description]
allowed-tools: Read Write Bash Grep Glob
---

# /plan-bug — Create Bug Investigation Plan

Create a structured bug plan so the issue is tracked, investigated methodically,
and never retried blindly.

## Steps

### 1. Get bug description

- If `$ARGUMENTS` is provided, use it as the bug description
- If empty, ask the user: "Describe the bug — what's broken, what error do you see?"

### 2. Check for existing related work

- Search `plans/active/` for files matching keywords from the bug description:
  `grep -rli "<keywords>" plans/active/ 2>/dev/null`
- Search `plans/archive/` for previously investigated similar bugs:
  `grep -rli "<keywords>" plans/archive/ 2>/dev/null`
- If matches found, warn the user:
  "Related work exists — review these before proceeding:"
  List each match with its file path and one-line summary from frontmatter.
- If a `/check-existing-work` skill exists, invoke it instead of the raw grep.

### 3. Generate plan ID

- Count existing bug plans across active AND archive:
  `ls plans/active/bug-*.md plans/archive/bug-*.md 2>/dev/null | wc -l`
- Next ID = count + 1, zero-padded to 3 digits
- Generate slug from description: lowercase, hyphens, max 30 chars
- Full ID: `bug-{NNN}-{slug}` (e.g., `bug-001-login-empty-email`)

### 4. Read the bug plan template

- Read `plans/templates/bug-plan.md` to get the structure

### 5. Fill in the plan

Using information from the user and codebase:

**Frontmatter:**

- `id`: the generated ID
- `type`: bug
- `status`: draft
- `author-agent`: your agent name, or "human" if user-initiated
- `created`: today's date (YYYY-MM-DD)
- `updated`: today's date
- `branch`: `fix/{slug}`
- `attempt-count`: 0
- `max-attempts`: 5
- `error-message`: extract from user description if present
- `reproduction-steps`: from user description or "To be determined"
- `stack-trace`: from user description if present, else null

**Body:**

- **Bug Description**: expand the user's description into expected vs actual behavior
- **Reproduction Steps**: numbered steps if known, or mark as needing investigation
- **Error Output**: paste error/stack trace in code block if provided
- **Root Cause Analysis**: leave empty — to be filled during investigation
- **Fix Approach**: leave empty — to be filled after root cause is found
- **Rejected Fixes**: leave empty
- **Validation Criteria**: at minimum include "the original error no longer occurs"
- **Attempt Log**: leave empty

**Affected files:** Search the codebase for files related to the error:

- If an error message mentions a file path, include it
- If keywords relate to a module, grep for relevant source files
- `grep -rli "<keywords>" apps/ packages/ 2>/dev/null | head -10`

### 6. Write the plan

- Write to `plans/active/bug-{ID}-{slug}.md`

### 7. Create git branch

- Check current branch: `git branch --show-current`
- Create and switch to fix branch: `git checkout -b fix/{slug}`
- If branch already exists, warn but don't fail

### 8. Update the active manifest

- Read `plans/active.md`
- Add a new row to the table with: ID, type, status, priority, branch, one-line summary
- Write updated `plans/active.md`

### 9. Report to user

Report:

```
Bug plan created: plans/active/bug-{ID}-{slug}.md
Branch: fix/{slug}
Status: draft — review the plan and approve to start investigation.
```

## Edge Cases

- If the user provides a stack trace, extract the file paths and line numbers
  into `affected-files` automatically
- If a very similar bug plan exists in the archive, prominently warn:
  "A similar bug was investigated before — READ the lessons in {archive-path}
  before starting"
- If git operations fail (e.g., uncommitted changes), warn but still create
  the plan file — don't let git issues block plan creation
