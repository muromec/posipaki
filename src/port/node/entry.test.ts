// ── the node entry's own surface ─────────────────────────────────────────────
//
// What `posipaki/port/node` hands out is what a consumer can reach: a port missing from the entry is a port
// nobody can fork, and the tree itself imports the modules directly, so nothing else here would notice.

import { describe, expect, it } from "vitest";

import * as entry from "../node.js";

describe("posipaki/port/node", () => {
  it("hands out the media and the ports built on them", () => {
    for (const name of ["spawnPort", "spawnPorts", "BinaryPort", "Utf8Port", "httpListener"]) {
      expect(typeof (entry as Record<string, unknown>)[name]).not.toBe("undefined");
    }
  });
});
