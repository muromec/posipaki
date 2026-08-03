#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tool_works() { [ -x "$1" ] || return 1; "$1" --version >/dev/null 2>&1; }
if tool_works "$ROOT/node_modules/.bin/vitest"; then
  exec "$ROOT/node_modules/.bin/vitest" run "$@"
elif command -v bun >/dev/null 2>&1; then
  echo "test: vitest not available, using bun" >&2
  exec bun test "$@"
else
  echo "test: neither vitest nor bun available" >&2
  exit 2
fi
