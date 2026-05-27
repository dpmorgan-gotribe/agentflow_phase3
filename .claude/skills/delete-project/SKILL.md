---
name: delete-project
description: Delete a generated app under projects/<name>/, including its git state and associated factory artefacts (registered worktrees, proposal file, bare-repo siblings). Inverse of /new-project. Preview-by-default; --yes required to commit; --dry-run to print only.
when_to_use: when the user asks to delete, remove, tear down, nuke, or clean up a project under projects/<name>/; for tidying up smoke-test or experimental scaffolds
argument-hint: <name> [--yes] [--dry-run] [--keep-proposal] [--keep-bare-repos]
allowed-tools: Read Write Bash Glob Grep
---

# /delete-project — Tear Down a Generated App

Removes `projects/<name>/` along with the git worktrees registered against
it, the matching `proposals/<name>-proposal.md` (if any), and any
`projects/<name>*.git/` bare-repo siblings left behind by Mode B
git-agent smoke runs.

The lifecycle inverse of `/new-project`. Same name regex, same
reserved-word block list, same factory-root guard. Always destructive —
**preview-by-default**, `--yes` to commit, `--dry-run` to print without
touching the filesystem.

## Arguments

- `<name>` (required) — project slug, kebab-case, regex
  `^[a-z][a-z0-9-]{1,48}$` (matches `/new-project`).
- `--yes` — skip the safety gate and execute the deletion. Without this
  flag, the skill prints the preview + exits 0 without removing
  anything.
- `--dry-run` — print the preview only and exit 0. Mutually exclusive
  with `--yes`.
- `--keep-proposal` — do NOT remove `proposals/<name>-proposal.md` even
  if it exists.
- `--keep-bare-repos` — do NOT remove `projects/<name>*.git/` siblings
  (smoke / origin bare-repo leftovers).

## Steps

### 1. Validate `<name>`

- Regex: `^[a-z][a-z0-9-]{1,48}$` — starts with a letter, kebab-case,
  2-49 chars.
- Reject these reserved names: `active`, `archive`, `templates`, `test`,
  `shared`, `factory`.
- Reject anything that would resolve outside `projects/<name>/`:
  - any `..` segment
  - any leading `/` or `\`
  - any drive prefix (`C:`, `~`, etc.)
- On failure, error with:
  `Project name '<name>' invalid. Must match ^[a-z][a-z0-9-]{1,48}$ and not be a reserved word.`
- On mutually-exclusive `--yes` + `--dry-run`, error with:
  `--yes and --dry-run are mutually exclusive.`

### 2. Pre-flight existence + factory-root check

- Confirm CWD looks like the factory: `.claude/agents/` and
  `brief-template.md` must both exist at CWD. If not, error:
  `This doesn't look like the factory repo. Run from the agentflow-phase2 root.`
- Confirm `projects/<name>/` exists. If not, run
  `ls projects/ 2>/dev/null | grep -i "<name>" | head -5`
  to list nearby slugs and error:
  ```
  Project 'projects/<name>/' not found.
  Did you mean: <slug-1>, <slug-2>, ... ?
  ```
- Confirm `projects/<name>/` is NOT a symlink. If `test -L
projects/<name>` is true, error:
  `projects/<name>/ is a symlink. Resolve manually before deleting.`
- Confirm the user's CWD is NOT inside `projects/<name>/`. Compare
  realpath of CWD against realpath of `projects/<name>/`. If CWD is
  the project or a descendant, error:
  `Cannot delete the project you're currently inside; cd to the factory root first.`

### 3. Discover associated artefacts

Build a `targets[]` list without touching the filesystem yet:

1. **Project directory** (always):
   `targets += "projects/<name>/"`.
2. **Bare-repo siblings** (unless `--keep-bare-repos`):
   `ls -d projects/<name>*.git 2>/dev/null` — every match is a target.
   Catches anything whose directory name STARTS with `<name>` and ends
   in `.git` (e.g. `<name>.git/`, `<name>-origin.git/`,
   `<name>-mirror.git/`). Bare repos that interleave a suffix BEFORE
   the project's full slug (e.g. smoke runs that emit
   `<base>-origin-<timestamp>.git/` for project `<base>-<timestamp>`)
   are NOT auto-detected — the user must clean those up manually or
   re-invoke with the bare repo's own name as `<name>` (the
   project-not-found path will then surface the bare repo via the
   nearby-slug hint).
3. **Proposal file** (unless `--keep-proposal`):
   if `proposals/<name>-proposal.md` exists, add it.
4. **Registered git worktrees** — run
   `git worktree list --porcelain` from the factory root. For each
   `worktree <path>` line, normalize `<path>` to a forward-slash
   relative path; if it begins with `projects/<name>/`, add to
   `worktreesToRemove[]`.

Also scan for **uncommitted changes warning** (non-blocking): if
`projects/<name>/.git` exists, run
`git -C projects/<name> status --short 2>/dev/null | head -1` — if
non-empty, append to `warnings[]`:
`Project's inner repo has uncommitted changes; they will be lost.`

### 4. Print the preview

Always print, regardless of `--yes` / `--dry-run` / no-flag. Format:

```
/delete-project <name> — preview

Targets (<N>):
  - projects/<name>/                                    <size>
  - projects/<name>-origin-<timestamp>.git/             <size>
  - proposals/<name>-proposal.md                        <size>

Worktrees to remove (<N>):
  - projects/<name>/.claude/worktrees/feat-001-foo/

Warnings:
  - Project's inner repo has uncommitted changes; they will be lost.
```

Sizes via `du -sh <path> 2>/dev/null | awk '{print $1}'` — best-effort,
don't fail the skill if `du` isn't on PATH (Windows bash). If a section
is empty, omit it.

### 5. Confirmation gate

- `--dry-run` → print
  `Dry-run: nothing was deleted. Re-run with --yes to commit.` and
  return JSON with `preview: true`, `success: true`, exit 0.
- `--yes` → continue to step 6.
- Neither flag → print
  `Re-run with --yes to confirm, or --dry-run to preview only.` and
  return JSON with `preview: true`, `success: true`, exit 0.

Skills can't reliably read interactive stdin across Claude Code
surfaces, so the explicit-flag pattern is the safe equivalent of a y/n
prompt.

### 6. Execute the deletion

Order matters — worktrees BEFORE the rm so git's registry doesn't keep
ghost entries:

1. **Remove registered worktrees** — for each
   `worktreesToRemove[]` entry:
   `git worktree remove --force "<path>"`.
   Capture per-entry success/failure into `removed.worktrees[]`.
2. **Prune the registry once**:
   `git worktree prune`.
3. **Remove the project directory**:
   `rm -rf "projects/<name>"`.
   Quote the path; never pass through shell expansion. Append to
   `removed.paths[]` on success.
4. **Remove bare-repo siblings** (unless `--keep-bare-repos`):
   for each match from step 3.2, `rm -rf "<path>"` and append.
5. **Remove proposal file** (unless `--keep-proposal`):
   `rm -f "proposals/<name>-proposal.md"` and append.

If any single rm fails (permission denied, file in use), capture the
error in `errors[]` and CONTINUE — partial cleanup is more useful than
a panic-rollback that would leave the user in a worse state. The
self-verify step in §7 will surface what's left.

### 7. Self-verify

- For each path in `removed.paths[]` and `removed.worktrees[]`,
  re-stat: any leftover → append the path to `verifyFailures[]`.
- Re-run `git worktree list --porcelain | grep "projects/<name>/"` —
  any remaining entry → append to `verifyFailures[]`.
- If `verifyFailures[]` is non-empty, set `success: false` and include
  the list in the return JSON.

### 8. Return structured JSON

```json
{
  "success": true,
  "projectName": "<name>",
  "preview": false,
  "removed": {
    "paths": [
      "projects/<name>/",
      "projects/<name>-origin-<timestamp>.git/",
      "proposals/<name>-proposal.md"
    ],
    "worktrees": ["projects/<name>/.claude/worktrees/feat-001-foo/"]
  },
  "kept": [],
  "warnings": [],
  "errors": [],
  "verifyFailures": [],
  "nextStep": "Project '<name>' removed. Run /new-project <name> to recreate, or pick a different slug."
}
```

`kept[]` lists artefacts skipped due to `--keep-proposal` /
`--keep-bare-repos`. In dry-run / no-flag mode, `removed` is empty and
`preview: true`.

## Edge Cases

- **`<name>` is empty / missing**: error
  `/delete-project requires a project name. Usage: /delete-project <name> [--yes|--dry-run]`.
- **`projects/` does not exist at CWD**: routed by the factory-root
  check in §2 — error and stop. Same message as `/new-project`.
- **Project's inner `.git/` is missing or corrupt**: not a blocker; the
  rm proceeds. The factory's `git worktree list` is the source of
  truth for what worktrees exist, not the project's inner state.
- **Worktree `git worktree remove --force` fails** (e.g., the worktree
  dir is already gone but the registry entry persists):
  `git worktree prune` in step 6.2 cleans it up. Capture the warning
  but don't fail.
- **`proposals/` directory absent**: skip step 6.5 silently — it's
  optional state.
- **User passes both `--yes` and `--dry-run`**: rejected in §1.
- **User passes `--keep-bare-repos` but no bare repos exist**: no-op,
  `kept[]` stays empty.
- **`projects/<name>` exists but is empty**: still proceed; same
  preview + confirmation flow.
- **CWD is `projects/<name>/`**: rejected in §2.
- **Path contains backslashes** (Windows): normalize all path
  comparisons to forward slashes before matching against
  `projects/<name>/`.

## See also

- `/new-project <name>` — the inverse op (creates `projects/<name>/`).
- Factory `CLAUDE.md` § Project Initialization — lists the lifecycle
  pair.

## Operator note (rm denial)

Some Claude Code installs deny `rm -rf <path>` at the Bash-tool
permission layer even for safe paths under `projects/` (the factory's
`block-dangerous.sh` only blocks `rm -rf /`, `~`, `.` — anything else
is a separate per-tool approval gate set by the operator).

If you hit a denial:

1. **STOP**. Do not attempt to route the deletion through any other
   shell or tool to bypass the deny rule (that would defeat the
   user's intentional safety control).
2. Report the blocked path back to the user verbatim and let them
   decide: approve the prompt interactively, run the `rm` themselves
   via `! rm -rf projects/<name>`, or add a permanent
   `Bash(rm -rf projects/*)` allowlist entry via
   `/update-config` if they want future runs to pass.

The skill is preview-first by design — a `rm` denial mid-procedure is
not a failure mode worth automating around.
