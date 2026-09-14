#!/usr/bin/env bash
# ── Pre-commit validation ─────────────────────────────────────────────────
# Hook:   cp scripts/pre-commit .git/hooks/pre-commit
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
failures=0

# ── the workspaces ───────────────────────────────────────────────
# A package in packages/* is part of the tree: it has its own tsconfig and its
# own sources, and the gate treats both like the core's.  Tests need no listing —
# the runner walks the tree and finds them where they are.
PACKAGE_DIRS=()
PACKAGE_SRC=()
for dir in "$ROOT"/packages/*/; do
  [ -f "${dir}tsconfig.json" ] || continue
  PACKAGE_DIRS+=("$dir")
  PACKAGE_SRC+=("${dir}src")
done

# ── typecheck ────────────────────────────────────────────────────
echo -n "  typecheck … "
if bash "$ROOT/scripts/tsc.sh" --noEmit 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${RED}FAIL${NC}"
  failures=$((failures + 1))
fi

for dir in ${PACKAGE_DIRS[@]+"${PACKAGE_DIRS[@]}"}; do
  echo -n "  typecheck packages/$(basename "$dir") … "
  if bash "$ROOT/scripts/tsc.sh" -p "${dir}tsconfig.json" 2>&1; then
    echo -e "${GREEN}ok${NC}"
  else
    echo -e "${RED}FAIL${NC}"
    failures=$((failures + 1))
  fi
done

# ── lint ─────────────────────────────────────────────────────────
echo -n "  lint … "
if bash "$ROOT/scripts/lint.sh" -D correctness -D suspicious src/ ${PACKAGE_SRC[@]+"${PACKAGE_SRC[@]}"} 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${RED}FAIL${NC}"
  failures=$((failures + 1))
fi

# ── format:check ──────────────────────────────────────────────────
echo -n "  format:check … "
if bash "$ROOT/scripts/fmt.sh" --check src/ ${PACKAGE_SRC[@]+"${PACKAGE_SRC[@]}"} 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${YELLOW}issues found (non-blocking)${NC}"
fi

# ── tests ─────────────────────────────────────────────────────────
# One runner for the tree: the core's tests and every package's.
echo -n "  test … "
if bash "$ROOT/scripts/test.sh" --reporter=dots 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${RED}FAIL${NC}"
  failures=$((failures + 1))
fi

# ── result ────────────────────────────────────────────────────────
echo ""
if [ $failures -eq 0 ]; then
  echo -e "${GREEN}All checks passed.${NC}"
  exit 0
else
  echo -e "${RED}${failures} check(s) failed.${NC}"
  exit 1
fi
