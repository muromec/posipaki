// ── Process Name Match Tests ─────────────────────────────────────────────
//
// RED PHASE — describes the pname pattern matcher before it exists.

import { describe, it, expect } from "vitest";

describe("pnameMatch", () => {
  it("exact name matches", async () => {
    const { pnameMatch } = await import("./pname-match.js");
    expect(pnameMatch("connector", ["connector"])).toBe(true);
    expect(pnameMatch("connector", ["other"])).toBe(false);
  });

  it("'*' matches anything", async () => {
    const { pnameMatch } = await import("./pname-match.js");
    expect(pnameMatch("anything", ["*"])).toBe(true);
  });

  it("'prefix:*' matches the prefix and its subtree", async () => {
    const { pnameMatch } = await import("./pname-match.js");
    expect(pnameMatch("reflector", ["reflector:*"])).toBe(true);
    expect(pnameMatch("reflector:connector", ["reflector:*"])).toBe(true);
    expect(pnameMatch("reflector:connector:tool", ["reflector:*"])).toBe(true);
    expect(pnameMatch("other:connector", ["reflector:*"])).toBe(false);
  });

  it("empty pattern list matches nothing", async () => {
    const { pnameMatch } = await import("./pname-match.js");
    expect(pnameMatch("connector", [])).toBe(false);
  });

  it("multiple patterns are OR-ed", async () => {
    const { pnameMatch } = await import("./pname-match.js");
    expect(pnameMatch("connector", ["reflector", "connector"])).toBe(true);
    expect(pnameMatch("connector", ["reflector", "other"])).toBe(false);
  });
});
