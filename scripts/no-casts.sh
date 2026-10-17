#!/usr/bin/env bash
# ── casts a commit adds ────────────────────────────────────────────────────
# `as unknown as` throws away both types and asserts a third, which is the one thing a typed
# codebase exists to prevent; `as any` is the same erasure without the ceremony.  Checked on
# the lines a commit ADDS — what is already in the tree is not this gate's argument — and the
# fix for a new one is a type, not a comment.
#
#   $ bash scripts/no-casts.sh          the staged diff, as the pre-commit hook sees it
#
# A hit is printed with its file, so the answer to "where" is in the failure.
set -euo pipefail

hits=$(git diff --cached -U0 -- '*.ts' 2>/dev/null | awk '
  /^\+\+\+ b\// { file = substr($0, 7) }
  /^\+/ && !/^\+\+\+/ {
    line = $0
    sub(/^\+/, "", line)
    if (line ~ /as[ \t]+unknown[ \t]+as/ || line ~ /as[ \t]+any([^A-Za-z0-9_]|$)/) {
      printf "    %s: %s\n", file, line
    }
  }')

if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  exit 1
fi
