#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x /usr/bin/tsc ]; then
  exec /usr/bin/tsc "$@"
elif [ -x "$ROOT/node_modules/.bin/tsc" ]; then
  exec "$ROOT/node_modules/.bin/tsc" "$@"
else
  echo "tsc: no TypeScript compiler found" >&2
  exit 2
fi
