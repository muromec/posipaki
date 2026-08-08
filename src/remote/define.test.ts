// ── defineRemoteActor tests ────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineRemoteActor } from "./define.js";

// Mock child module — prevent runChild from actually executing
vi.mock("./child.js", () => ({
  runChild: vi.fn(() => Promise.resolve()),
  makeSender: vi.fn(),
}));

// Mock host module — prevent spawnRemote from actually spawning
vi.mock("./host.js", () => ({
  spawnRemote: vi.fn(() => Promise.resolve({
    state: {},
    ready: async () => {},
    send: () => {},
    wait: async () => ({ code: 0, state: {} }),
    onMessage: () => {},
  })),
}));

// ── helpers ────────────────────────────────────────────────────────────────

function dummyFn(): any {
  return async function* () {};
}

const TEST_URL = "file:///home/test/project/src/actors/echo.ts";

// ── pathHash ───────────────────────────────────────────────────────────────

describe("defineRemoteActor — pathHash", () => {
  it("same URL produces same isChild value", () => {
    const a = defineRemoteActor(dummyFn(), TEST_URL);
    const b = defineRemoteActor(dummyFn(), TEST_URL);
    expect(a.isChild).toBe(b.isChild);
  });

  it("different URLs both produce definitions", () => {
    const a = defineRemoteActor(dummyFn(), "file:///a.ts");
    const b = defineRemoteActor(dummyFn(), "file:///b.ts");
    expect(typeof a.isChild).toBe("boolean");
    expect(typeof b.isChild).toBe("boolean");
  });
});

// ── isChild detection ──────────────────────────────────────────────────────

describe("defineRemoteActor — isChild detection", () => {
  let savedArgv: string[];

  beforeEach(() => { savedArgv = [...process.argv]; });
  afterEach(() => { process.argv = savedArgv; });

  it("isChild is false when marker is not in argv", () => {
    process.argv = ["bun", "script.ts"];
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(def.isChild).toBe(false);
  });

  it("isChild is true when marker is in argv", async () => {
    const { createHash } = await import("node:crypto");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    const marker = `--remote=${hash}`;

    process.argv = ["bun", "script.ts", marker];
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(def.isChild).toBe(true);
  });

  it("manual: true prevents auto child detection", async () => {
    const { createHash } = await import("node:crypto");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    const marker = `--remote=${hash}`;

    process.argv = ["bun", "script.ts", marker];
    const def = defineRemoteActor(dummyFn(), TEST_URL, { manual: true });
    expect(def.isChild).toBe(false);
  });
});

// ── returned definition shape ──────────────────────────────────────────────

describe("defineRemoteActor — definition shape", () => {
  it("returns isChild (boolean), runChild (function), spawn (function)", () => {
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(typeof def.isChild).toBe("boolean");
    expect(typeof def.runChild).toBe("function");
    expect(typeof def.spawn).toBe("function");
  });

  it("runChild returns a Promise", async () => {
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    const result = def.runChild();
    expect(result).toBeInstanceOf(Promise);
    await result; // don't leave it hanging
  });

  it("spawn is a function (not curried)", () => {
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    const spawnFn = def.spawn;
    expect(typeof spawnFn).toBe("function");
  });

  it("spawn(args) returns a Promise<RemoteProxy>", async () => {
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    const spawnFn = def.spawn;
    const proxy = await def.spawn({ tools: ["a"] });
    expect(proxy).toBeDefined();
    expect(typeof proxy.send).toBe("function");
    expect(typeof proxy.onMessage).toBe("function");
    expect(typeof proxy.wait).toBe("function");
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
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(def.isChild).toBe(true);
  });

  it("wrong hash does not trigger isChild", () => {
    process.argv = ["bun", "script.ts", "--remote=deadbeefcafe"];
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(def.isChild).toBe(false);
  });

  it("--remote without =value does not trigger isChild", () => {
    process.argv = ["bun", "script.ts", "--remote"];
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(def.isChild).toBe(false);
  });

  it("--remote= (empty hash) does not match", () => {
    process.argv = ["bun", "script.ts", "--remote="];
    const def = defineRemoteActor(dummyFn(), TEST_URL);
    expect(def.isChild).toBe(false);
  });
});
