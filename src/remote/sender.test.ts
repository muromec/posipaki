// ── Sender identity reconstruction ─────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { makeSender } from "./server.js";

describe("sender reconstruction", () => {
  const parentId = Symbol.for("test-parent");

  it("uses stable parentId when fromName matches parentName", () => {
    const s1 = makeSender("root", "root", parentId);
    const s2 = makeSender("root", "root", parentId);
    expect(s1.fromId).toBe(parentId);
    expect(s2.fromId).toBe(parentId);
    expect(s1.fromId).toBe(s2.fromId);
  });

  it("generates fresh anonymous symbol when fromName differs", () => {
    const s1 = makeSender("other", "root", parentId);
    const s2 = makeSender("other", "root", parentId);
    expect(s1.fromId).not.toBe(parentId);
    expect(s1.fromId).not.toBe(s2.fromId);
  });

  it("generates fresh symbol when parentId is null", () => {
    const s = makeSender("anything", null, null);
    expect(typeof s.fromId).toBe("symbol");
  });

  it("fromName is always the wire fromName", () => {
    const s = makeSender("alice", "root", parentId);
    expect(s.fromName).toBe("alice");
  });
});
