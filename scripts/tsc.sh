#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME=node
if node --version &> /dev/null ; then
  true
elif bun --version &> /dev/null ; then
  RUNTIME=bun
else
  echo "Neither node nor bun found, exiting" >&2
  exit 2
fi
if [ -x "$ROOT/node_modules/.bin/tsc" ]; then
  exec $RUNTIME "$ROOT/node_modules/.bin/tsc" --noEmit "$@"
else
  echo "tsc: no TypeScript compiler found" >&2
  exit 2
fi
