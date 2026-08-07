#!/usr/bin/env bash
# ── test runner wrapper ────────────────────────────────────────────────────
# Tries vitest first (if rolldown loads), falls back to bun, then node.
# Respects TEST_RUNNER env var: "vitest" | "bun" | "node".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

tool_works() { [ -x "$1" ] || return 1; "$1" --version >/dev/null 2>&1; }
rolldown_ok() { node -e "try{require('rolldown')}catch(e){process.exit(1)}" >/dev/null 2>&1; }

runner="${TEST_RUNNER:-}"

# ── vitest ─────────────────────────────────────────────────────────
if [ -z "$runner" ] || [ "$runner" = "vitest" ]; then
  if tool_works "$ROOT/node_modules/.bin/vitest" && rolldown_ok; then
    exec "$ROOT/node_modules/.bin/vitest" run "$@"
  fi
fi

# ── bun ────────────────────────────────────────────────────────────
if [ -z "$runner" ] || [ "$runner" = "bun" ]; then
  if command -v bun >/dev/null 2>&1; then
    exec bun test "$@"
  fi
fi

# ── node ───────────────────────────────────────────────────────────
if [ -z "$runner" ] || [ "$runner" = "node" ]; then
  if command -v node >/dev/null 2>&1; then
    exec node --test "$@"
  fi
fi

echo "test: no usable test runner found" >&2
exit 2
