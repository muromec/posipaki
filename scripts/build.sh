#!/usr/bin/env bash
# ── build wrapper ──────────────────────────────────────────────────────────
# Tries tsdown (rolldown bundler) first; falls back to esbuild on platforms
# where rolldown has no native binding (e.g. linux-riscv64). The esbuild
# fallback bundles the same entry points as tsdown.config.ts and skips .d.ts
# generation (esbuild emits no types).
#
# The whole tree builds from here: the core, then every package in packages/*,
# each with its own tsdown.config.ts.  One command for one release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

tool_works() { [ -x "$1" ] || return 1; "$1" --version >/dev/null 2>&1; }
rolldown_ok() { node -e "try{require('rolldown')}catch(e){process.exit(1)}" >/dev/null 2>&1; }

# Entry points mirror tsdown.config.ts.
ENTRY=(
  src/index.ts
  src/xfetch.ts
  src/hooks.ts
  src/plugins/debug-logger.ts
  src/plugins/tree-introspection.ts
  src/remote/index.ts
  src/remote/node.ts
  src/remote/gateway-cli.ts
  src/testing/index.ts
)

# Each package is built by the script it builds itself with, so the tree and a
# single package publish from the same producer (and the same fallbacks):
# scripts/package-build.sh.
build_packages() {
  local dir
  for dir in "$ROOT"/packages/*/; do
    [ -f "${dir}tsdown.config.ts" ] || continue
    bash "$ROOT/scripts/package-build.sh" "$dir"
  done
}

if tool_works "$ROOT/node_modules/.bin/tsdown" && rolldown_ok; then
  "$ROOT/node_modules/.bin/tsdown" "$@"
  build_packages
  exit 0
fi

if tool_works "$ROOT/node_modules/.bin/esbuild"; then
  echo "build: rolldown unavailable — falling back to esbuild (no .d.ts)" >&2
  rm -rf "$ROOT/dist"
  "$ROOT/node_modules/.bin/esbuild" \
    "${ENTRY[@]}" \
    --bundle --format=esm --platform=node --target=node18 \
    --outdir=dist --outbase=src --sourcemap "$@"
  build_packages
  exit 0
fi

echo "build: no usable bundler found" >&2
exit 2
