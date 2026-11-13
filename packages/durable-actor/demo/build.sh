#!/usr/bin/env bash
# Bundle the demo: one script, no dev server, so the page can be opened straight from disk.
set -euo pipefail
cd "$(dirname "$0")/.."
bun build demo/demo.ts --outfile demo/dist/demo.js --target browser --format esm
