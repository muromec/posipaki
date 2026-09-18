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
// The gateway is the one file a consumer *copies*: a kit stages it into an environment where
// nothing of ours is installed, and runs it there.  If a bundler split a chunk out of it, the
// chunk stays behind and the copied gateway dies of a missing import on the far side — a failure
// no test here can see, because everything else imports the package (and the sandbox tests build
// their own gateway).  So it has to be one file, and the build makes it one.
const gateway = join(root, "dist", "remote", "gateway-cli.js");
if (existsSync(gateway)) {
  // `from <quote>../…` in either quoting: the shell string this lives in takes no single quote,
  // so the quote itself is left out and a relative specifier is what is matched.
  const relative = /from\s+.[.][./]/.exec(readFileSync(gateway, "utf8"));
  if (relative !== null) {
    console.error("check-dist: dist/remote/gateway-cli.js is not one file:");
    console.error(`  it carries ${JSON.stringify(relative[0])} — a chunk a kit would not stage`);
    console.error("  see bundle_gateway in scripts/build.sh");
    process.exit(1);
  }
}
console.log(`check-dist: ${checked} exports resolve in dist, and the gateway is one file`);
'

for dir in "$ROOT"/packages/*/; do
  [ -f "${dir}package.json" ] || continue
  [ -f "${dir}dist/index.js" ] || {
    echo "check-dist: $(basename "$dir") has no dist/index.js" >&2
    exit 1
  }
done
