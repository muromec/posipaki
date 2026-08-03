#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tool_works() { [ -x "$1" ] || return 1; "$1" --version >/dev/null 2>&1; }
if tool_works "$ROOT/node_modules/.bin/oxfmt"; then
  exec "$ROOT/node_modules/.bin/oxfmt" "$@"
elif tool_works "$ROOT/node_modules/.bin/prettier"; then
  exec "$ROOT/node_modules/.bin/prettier" "$@"
else
  echo "fmt: no formatter available" >&2
  exit 0
fi
