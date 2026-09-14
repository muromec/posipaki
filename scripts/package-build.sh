#!/usr/bin/env bash
# ── build one package ──────────────────────────────────────────────────────
# Run from a package directory (`bash ../../scripts/package-build.sh`, which is
# what the package's own `build` and `prepack` scripts call), so a package can be
# built, packed and published on its own while the rest of the tree sits still.
#
# Tries tsdown (rolldown) from the package's own config; falls back to esbuild on
# platforms where rolldown has no native binding (e.g. linux-riscv64), which skips
# .d.ts generation.  The core stays external in the fallback: a package imports
# posipaki, it does not carry it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${1:-$PWD}"

tool_works() { [ -x "$1" ] || return 1; "$1" --version >/dev/null 2>&1; }
rolldown_ok() { node -e "try{require('rolldown')}catch(e){process.exit(1)}" >/dev/null 2>&1; }

if [ ! -f "$PKG/tsdown.config.ts" ]; then
  echo "build: $PKG has no tsdown.config.ts" >&2
  exit 2
fi

echo "build: $(basename "$PKG")" >&2

if tool_works "$ROOT/node_modules/.bin/tsdown" && rolldown_ok; then
  (cd "$PKG" && "$ROOT/node_modules/.bin/tsdown")
  exit 0
fi

if tool_works "$ROOT/node_modules/.bin/esbuild"; then
  echo "build: rolldown unavailable — falling back to esbuild (no .d.ts)" >&2
  rm -rf "$PKG/dist"
  (cd "$PKG" && "$ROOT/node_modules/.bin/esbuild" src/index.ts \
    --bundle --format=esm --platform=node --target=node18 \
    --external:posipaki --external:'posipaki/*' \
    --outdir=dist --outbase=src --sourcemap)
  exit 0
fi

echo "build: no usable bundler found" >&2
exit 2
