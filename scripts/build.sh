#!/usr/bin/env bash
# ── build wrapper ──────────────────────────────────────────────────────────
# Tries tsdown (rolldown bundler) first; falls back to esbuild on platforms
# where rolldown has no native binding (e.g. linux-riscv64). The esbuild
# fallback bundles the same entry points as tsdown.config.ts and skips .d.ts
# generation (esbuild emits no types).
#
# Whichever bundler ran, the gateway entry gets one more pass of its own: it is
# the one file a consumer *copies* rather than imports, so it has to be one file
# — see `bundle_gateway` below.  A build that leaves it importing a chunk builds
# fine, typechecks, passes every test here (they import the package, or bundle
# the gateway themselves) and then dies inside a sandbox.  scripts/check-dist.sh
# refuses that shape, so it cannot be published by accident.
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

# ── the gateway, as one file ───────────────────────────────────────────────
# A kit stages this file *alone* into an environment where nothing of ours is installed — bwrap,
# a container, another host — and runs it there.  Everything else in dist may import a chunk,
# because a consumer installs the whole package; this one may not, and a bundler that splits
# shared code out of it leaves the chunk behind.  So it is bundled on its own, by the esbuild that
# is here in either branch, and check-dist.sh is what enforces the result.
bundle_gateway() {
  local out="$ROOT/dist/remote/gateway-cli.js"
  if [ ! -x "$ROOT/node_modules/.bin/esbuild" ]; then
    echo "build: no esbuild — the gateway is whatever the bundler produced" >&2
    return 0
  fi
  "$ROOT/node_modules/.bin/esbuild" "$ROOT/src/remote/gateway-cli.ts" \
    --bundle --format=esm --platform=node --target=node18 \
    --outfile="$out" --sourcemap
}
bundle_gateway

# What was built is what the package promises.
bash "$ROOT/scripts/check-dist.sh"
