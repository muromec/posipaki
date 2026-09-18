#!/usr/bin/env bash
# ── the shape we publish ───────────────────────────────────────────────────
# Every path package.json promises has to be on disk after a build.  A bundler
# is free to place its chunks where it likes, and when it moves a file the
# package still builds, still typechecks and still passes its tests — because
# everything here imports `src/`.  What breaks is the consumer: an export that
# resolves to nothing, or a module that worked out its own location and now
# points at a chunk directory.  This is the check that makes that a red build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Whatever runtime this machine has runs the check: `node` is not everywhere, and a
# build that cannot check what it produced is worse than one that never promised to.
RUNNER=""
for candidate in node bun; do
  if command -v "$candidate" >/dev/null 2>&1; then
    RUNNER="$(command -v "$candidate")"
    break
  fi
done
if [ -z "$RUNNER" ]; then
  echo "check-dist: neither node nor bun is on this machine" >&2
  exit 2
fi

# The root comes in through the environment: the first script argument does not land in
# the same place for every runtime.
CHECK_DIST_ROOT="$ROOT" "$RUNNER" -e '
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.CHECK_DIST_ROOT;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Runtime targets only: the esbuild fallback emits no .d.ts on the platforms
// where rolldown has no binding, and that is a known, stated limitation.
const missing = [];
let checked = 0;
for (const [specifier, target] of Object.entries(pkg.exports ?? {})) {
  const paths =
    typeof target === "string"
      ? [target]
      : Object.entries(target)
          .filter(([condition]) => condition !== "types")
          .map(([, path]) => path);
  for (const path of paths) {
    if (!path.startsWith("./dist/") || path.endsWith(".d.ts")) continue;
    checked += 1;
    if (!existsSync(join(root, path))) missing.push(`${specifier} → ${path}`);
  }
}
if (missing.length > 0) {
  console.error("check-dist: package.json points at files that are not there:");
  for (const line of missing) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`check-dist: ${checked} exports resolve in dist`);
'

for dir in "$ROOT"/packages/*/; do
  [ -f "${dir}package.json" ] || continue
  [ -f "${dir}dist/index.js" ] || {
    echo "check-dist: $(basename "$dir") has no dist/index.js" >&2
    exit 1
  }
done
