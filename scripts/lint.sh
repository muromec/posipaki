#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tool_works() { [ -x "$1" ] || return 1; "$1" --version >/dev/null 2>&1; }
if tool_works "$ROOT/node_modules/.bin/oxlint"; then
  exec "$ROOT/node_modules/.bin/oxlint" "$@"
elif tool_works "$ROOT/node_modules/.bin/eslint"; then
  exec "$ROOT/node_modules/.bin/eslint" "$@"
else
  echo "lint: no linter available" >&2
  exit 0
fi
