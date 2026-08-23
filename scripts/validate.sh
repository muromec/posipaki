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

# ── typecheck ────────────────────────────────────────────────────
echo -n "  typecheck … "
if bash "$ROOT/scripts/tsc.sh" --noEmit 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${RED}FAIL${NC}"
  failures=$((failures + 1))
fi

# ── lint ─────────────────────────────────────────────────────────
echo -n "  lint … "
if bash "$ROOT/scripts/lint.sh" -D correctness -D suspicious src/ 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${RED}FAIL${NC}"
  failures=$((failures + 1))
fi

# ── format:check ──────────────────────────────────────────────────
echo -n "  format:check … "
if bash "$ROOT/scripts/fmt.sh" --check src/ 2>&1; then
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${YELLOW}issues found (non-blocking)${NC}"
fi

# ── tests ─────────────────────────────────────────────────────────
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
