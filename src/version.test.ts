// ── Library identity: pinned to package.json ───────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIB_VERSION } from "./index.js";
import { LIB_VERSION as own } from "./version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf-8")) as {
  version: string;
};

describe("library identity", () => {
  it("tracks package.json instead of drifting", () => {
    expect(own).toBe(pkg.version);
  });

  it("is what the package's own entry point exports", () => {
    expect(LIB_VERSION).toBe(own);
  });
});
