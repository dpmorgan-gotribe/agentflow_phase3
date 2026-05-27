#!/usr/bin/env bash
# .claude/hooks/enforce-boundaries.sh
#
# PreToolUse hook. Two roles:
#   1. Block writes to paths outside $CLAUDE_PROJECT_DIR.
#   2. Block writes to sensitive files (.env, .env.local, *.pem, *.key, ...).
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
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')
elif [[ -n "$PYTHON_BIN" ]]; then
  FILE_PATH=$(printf '%s' "$INPUT" | "$PYTHON_BIN" -c 'import sys, json; ti=json.load(sys.stdin).get("tool_input",{}); print(ti.get("file_path") or ti.get("path") or "")')
else
  echo "BLOCKED: enforce-boundaries.sh requires either jq or python on PATH." >&2
  exit 2
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

if [[ -z "${CLAUDE_PROJECT_DIR:-}" ]]; then
  echo "BLOCKED: CLAUDE_PROJECT_DIR is not set. Cannot enforce project boundary." >&2
  exit 2
fi

if realpath -m / >/dev/null 2>&1; then
  RESOLVED=$(realpath -m "$FILE_PATH" 2>/dev/null || printf '%s' "$FILE_PATH")
  PROJECT_RESOLVED=$(realpath -m "$CLAUDE_PROJECT_DIR" 2>/dev/null || printf '%s' "$CLAUDE_PROJECT_DIR")
elif [[ -n "$PYTHON_BIN" ]]; then
  RESOLVED=$("$PYTHON_BIN" -c "import os,sys; print(os.path.abspath(sys.argv[1]))" "$FILE_PATH")
  PROJECT_RESOLVED=$("$PYTHON_BIN" -c "import os,sys; print(os.path.abspath(sys.argv[1]))" "$CLAUDE_PROJECT_DIR")
else
  RESOLVED="$FILE_PATH"
  PROJECT_RESOLVED="$CLAUDE_PROJECT_DIR"
fi

_normalize() {
  local p="${1,,}"
  p=$(printf '%s' "$p" | tr '\\' '/')
  p=$(printf '%s' "$p" | sed -E 's|^([a-z]):|/\1|')
  p="${p%/}"
  printf '%s' "$p"
}

RESOLVED_CMP=$(_normalize "$RESOLVED")
PROJECT_CMP=$(_normalize "$PROJECT_RESOLVED")

HOME_NORM=""
if [[ -n "${HOME:-}" ]]; then
  HOME_NORM=$(_normalize "$HOME")
fi
ALLOWED_HARNESS_PREFIX=""
if [[ -n "$HOME_NORM" ]]; then
  ALLOWED_HARNESS_PREFIX="${HOME_NORM}/.claude/projects"
fi

if [[ -n "$ALLOWED_HARNESS_PREFIX" \
      && ( "$RESOLVED_CMP" == "$ALLOWED_HARNESS_PREFIX" \
        || "$RESOLVED_CMP" == "$ALLOWED_HARNESS_PREFIX"/* ) ]]; then
  : # allowed
elif [[ "$RESOLVED_CMP" != "$PROJECT_CMP" && "$RESOLVED_CMP" != "$PROJECT_CMP"/* ]]; then
  echo "BLOCKED: write outside project directory" >&2
  echo "  project: $PROJECT_RESOLVED" >&2
  echo "  target:  $RESOLVED" >&2
  exit 2
fi

BASENAME=$(basename "$FILE_PATH")
BLOCKED_FILES=(
  ".env"
  ".env.local"
  "*.pem"
  "*.key"
  "id_rsa"
  "id_ed25519"
  "id_ecdsa"
  "id_dsa"
  "credentials.json"
  "firebase-adminsdk-*.json"
  "*.p12"
  "*.pfx"
  "*.keystore"
  "*.jks"
)
for blocked in "${BLOCKED_FILES[@]}"; do
  # shellcheck disable=SC2053
  if [[ "$BASENAME" == $blocked ]]; then
    echo "BLOCKED: cannot modify sensitive file: $FILE_PATH" >&2
    echo "  matched pattern: $blocked" >&2
    exit 2
  fi
done

exit 0
