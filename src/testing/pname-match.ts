// ── Process Name Match ───────────────────────────────────────────────────
//
// Tree-prefix matching for posipaki process names (`parent:child:...`).
//
// Pattern language (same as debug-logger's DEBUG env filtering):
//   - "*"            matches any name
//   - "name"         matches exactly
//   - "prefix:*"     matches `prefix` and `prefix:` + anything below it

/** True if `name` matches any of `patterns`. */
export function pnameMatch(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    if (p.endsWith(":*")) {
      const prefix = p.slice(0, -2);
      if (name === prefix || name.startsWith(prefix + ":")) return true;
    } else if (p === name) {
      return true;
    }
  }
  return false;
}
