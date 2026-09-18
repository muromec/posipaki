#!/usr/bin/env bash
# ── build wrapper ──────────────────────────────────────────────────────────
# Tries tsdown (rolldown bundler) first; falls back to esbuild on platforms
# where rolldown has no native binding (e.g. linux-riscv64). The esbuild
# fallback bundles the same entry points as tsdown.config.ts and skips .d.ts
# generation (esbuild emits no types).
#
# Whichever bundler ran, the gateway entry gets one more pass of its own: it is
# the one file a consumer *copies* rather than imports, so it has to be one file.
# A build that leaves it importing a chunk builds fine, typechecks, passes every
# test here (they import the package, or bundle the gateway themselves) and then
# dies inside a sandbox.  scripts/check-dist.sh refuses that shape, so it cannot
# be published by accident — which is how 0.35.0 was caught.
#
# The whole tree builds from here: the core, then every package in packages/*,
# each with its own tsdown.config.ts.  One command for one release, and it ends
# by checking what it produced against package.json (scripts/check-dist.sh).
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
  # The gateway, alone: it is staged on its own, so it cannot share a chunk with anything.
  "$ROOT/node_modules/.bin/tsdown" --config "$ROOT/tsdown.gateway.config.ts"
  build_packages
elif tool_works "$ROOT/node_modules/.bin/esbuild"; then
  echo "build: rolldown unavailable — falling back to esbuild (no .d.ts)" >&2
  rm -rf "$ROOT/dist"
  "$ROOT/node_modules/.bin/esbuild" \
    "${ENTRY[@]}" \
    --bundle --format=esm --platform=node --target=node18 \
    --outdir=dist --outbase=src --sourcemap "$@"
  build_packages
else
  echo "build: no usable bundler found" >&2
  exit 2
fi

# The esbuild branch needs no second pass: it bundles every entry by itself, so the gateway is
# already one file there.  The tsdown branch is the one that splits, and the pass above is what
# puts the gateway back together.

# What was built is what the package promises.
bash "$ROOT/scripts/check-dist.sh"
