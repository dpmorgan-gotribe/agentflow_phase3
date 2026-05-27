#!/usr/bin/env bash
# .claude/hooks/block-dangerous.sh
#
# PreToolUse hook. Blocks destructive commands regardless of permission mode.
# Contract: reads tool-call JSON on stdin. Exit 0 to allow, exit 2 to block
# (stderr is surfaced back to the model).
set -euo pipefail

INPUT=$(cat)

_works() {
  "$1" --version >/dev/null 2>&1
}

PYTHON_BIN=""
if _works python; then
  PYTHON_BIN=python
elif _works python3; then
  PYTHON_BIN=python3
fi

if command -v jq >/dev/null 2>&1 && _works jq; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
elif [[ -n "$PYTHON_BIN" ]]; then
  COMMAND=$(printf '%s' "$INPUT" | "$PYTHON_BIN" -c 'import sys, json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command","") or "")')
else
  echo "BLOCKED: block-dangerous.sh requires either jq or python on PATH." >&2
  echo "Install jq (https://jqlang.github.io/jq/) or ensure python is on PATH." >&2
  exit 2
fi

if [[ -z "$COMMAND" ]]; then
  exit 0
fi

DANGEROUS_PATTERNS=(
  'rm[[:space:]]+-[a-z]*r[a-z]*f?[[:space:]]+/($|[[:space:]])'
  'rm[[:space:]]+-[a-z]*r[a-z]*f?[[:space:]]+~($|[[:space:]])'
  'rm[[:space:]]+-[a-z]*r[a-z]*f?[[:space:]]+\.($|[[:space:]])'
  ':\(\)\{[[:space:]]*:\|:&[[:space:]]*\};:'

  'git[[:space:]]+push.*(--force($|[[:space:]=])|[[:space:]]-f($|[[:space:]])).*\<(main|master)\>'
  'git[[:space:]]+push.*\<(main|master)\>.*(--force($|[[:space:]])|[[:space:]]-f($|[[:space:]]))'
  'git[[:space:]]+reset[[:space:]]+--hard'
  'git[[:space:]]+clean[[:space:]]+-[a-z]*f[a-z]*d'
  'git[[:space:]]+clean[[:space:]]+-[a-z]*d[a-z]*f'

  'DROP[[:space:]]+TABLE'
  'DROP[[:space:]]+DATABASE'
  'TRUNCATE[[:space:]]+TABLE'

  '(pnpm|npm|yarn|bun)[[:space:]]+publish([[:space:]]|$)'
  'eas[[:space:]]+submit([[:space:]]|$)'
  'vercel([[:space:]].*)?[[:space:]]--prod([[:space:]]|$)'
  '(fly|flyctl)[[:space:]]+deploy([[:space:]]|$)'
  'netlify[[:space:]]+deploy.*--prod'
  'docker[[:space:]]+push.*:latest($|[[:space:]])'

  'prisma[[:space:]]+migrate[[:space:]]+reset'
  'drizzle-kit[[:space:]]+drop'
  'supabase[[:space:]]+db[[:space:]]+reset'
  'aws[[:space:]]+s3[[:space:]]+sync.*--delete'
)

EXEMPTIONS=(
  'git[[:space:]]+push.*--force-with-lease'
  '(pnpm|npm|yarn|bun)[[:space:]]+publish[[:space:]].*--dry-run'
)

for exempt in "${EXEMPTIONS[@]}"; do
  if printf '%s' "$COMMAND" | grep -qiE "$exempt"; then
    exit 0
  fi
done

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if printf '%s' "$COMMAND" | grep -qiE "$pattern"; then
    echo "BLOCKED: command matches dangerous pattern: $pattern" >&2
    echo "command: $COMMAND" >&2
    exit 2
  fi
done

exit 0
