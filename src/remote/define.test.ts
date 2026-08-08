// ── defineRemoteActor tests ────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { defineRemoteActor } from "./define.js";

// Mock child module so isChild doesn't actually run
vi.mock("./child.js", () => ({
  runChild: vi.fn(),
  makeSender: vi.fn(),
}));

// Mock host module so spawn doesn't actually spawn
vi.mock("./host.js", () => ({
  spawnRemote: vi.fn(() => Promise.resolve({
    state: { pings: 0 },
    ready: async () => {},
    send: () => {},
    wait: async () => ({ code: 0, state: {} }),
    onMessage: () => {},
  })),
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makeDummyActor() {
  return defineActor({
    name: "dummy",
    inMessages: defineMessages<{ type: "PING"; count: number }>(),
    outMessages: defineMessages<{ type: "PONG"; count: number }>(),
    initialState: () => ({ pings: 0 }),
    handlers: {
      PING(msg: any) { this.emit({ type: "PONG", count: msg.count }); },
    },
  });
}

const TEST_URL = "file:///home/test/project/src/actors/echo.ts";

// ── pathHash ───────────────────────────────────────────────────────────────

describe("defineRemoteActor — pathHash", () => {
  it("same URL produces same isChild value", () => {
    const a = defineRemoteActor(makeDummyActor(), TEST_URL);
    const b = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(a.isChild).toBe(b.isChild);
  });
});

// ── isChild detection ──────────────────────────────────────────────────────

describe("defineRemoteActor — isChild detection", () => {
  let savedArgv: string[];

  beforeEach(() => { savedArgv = [...process.argv]; });
  afterEach(() => { process.argv = savedArgv; });

  it("isChild is false when marker is not in argv", () => {
    process.argv = ["bun", "script.ts"];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isChild).toBe(false);
  });

  it("isChild is true when marker is in argv", async () => {
    const { createHash } = await import("node:crypto");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    const marker = `--remote=${hash}`;

    process.argv = ["bun", "script.ts", marker];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isChild).toBe(true);
  });

  it("manual: true prevents auto child detection", async () => {
    const { createHash } = await import("node:crypto");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    const marker = `--remote=${hash}`;

    process.argv = ["bun", "script.ts", marker];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL, { manual: true });
    expect(def.isChild).toBe(false);
  });
});

// ── returned definition shape ──────────────────────────────────────────────

describe("defineRemoteActor — definition shape", () => {
  it("returns isChild, fn, config, spawn", () => {
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(typeof def.isChild).toBe("boolean");
    expect(typeof def.fn).toBe("function");
    expect(typeof def.spawn).toBe("function");
    expect(def.config).toBeDefined();
  });

  it("spawn returns an AsyncProcess", async () => {
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    const proc = def.spawn({});
    expect(proc).toBeDefined();
    expect(typeof proc.send).toBe("function");
    expect(typeof proc.wait).toBe("function");
    expect(typeof proc.subscribe).toBe("function");
    // Don't await — the mock spawnRemote resolves immediately but
    // the generator runs async. Just verify the handle shape.
  });
});

// ── marker format ──────────────────────────────────────────────────────────

describe("defineRemoteActor — marker format", () => {
  let savedArgv: string[];

  beforeEach(() => { savedArgv = [...process.argv]; });
  afterEach(() => { process.argv = savedArgv; });

  it("correct hash triggers isChild", async () => {
    const { createHash } = await import("node:crypto");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = fileURLToPath(TEST_URL);
    const expectedHash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);

    process.argv = ["bun", "script.ts", `--remote=${expectedHash}`];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isChild).toBe(true);
  });

  it("wrong hash does not trigger isChild", () => {
    process.argv = ["bun", "script.ts", "--remote=deadbeefcafe"];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isChild).toBe(false);
  });

  it("--remote without =value does not trigger isChild", () => {
    process.argv = ["bun", "script.ts", "--remote"];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isChild).toBe(false);
  });

  it("--remote= (empty hash) does not match", () => {
    process.argv = ["bun", "script.ts", "--remote="];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isChild).toBe(false);
  });
});
