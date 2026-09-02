// ── defineRemoteActor tests ────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { defineRemoteActor } from "./define.js";
import { join, dirname } from "node:path";

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

vi.mock("./server.js", () => ({
  serveRemoteActor: vi.fn(() => Promise.resolve()),
  makeSender: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => {
  let actual = {};
  if (importOriginal) {
    actual = await importOriginal();
  }

  return {
    ...actual,
    connectRemote: vi.fn(() =>
      Promise.resolve({
        state: { pings: 0 },
        ready: async () => {},
        send: () => {},
        wait: async () => ({ code: 0, state: {} }),
        onMessage: () => {},
      }),
    ),
  };
});

function makeDummyActor() {
  return defineActor({
    name: "dummy",
    inMessages: defineMessages<{ type: "PING"; count: number }>(),
    outMessages: defineMessages<{ type: "PONG"; count: number }>(),
    setup: () => ({ pings: 0 }),
    handlers: {
      PING(msg: any) {
        this.emit({ type: "PONG", count: msg.count });
      },
    },
  });
}

const TEST_URL = "file://" + join(dirname(fileURLToPath(import.meta.url)), "./fixtures/manual.js");

// ── pathHash ───────────────────────────────────────────────────────────────

describe("defineRemoteActor — pathHash", () => {
  it("same URL produces same isRemoteRoot value", () => {
    const a = defineRemoteActor(makeDummyActor(), TEST_URL);
    const b = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(a.isRemoteRoot).toBe(b.isRemoteRoot);
  });
});

// ── isRemoteRoot detection ─────────────────────────────────────────────────

describe("defineRemoteActor — isRemoteRoot detection", () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = [...process.argv];
  });
  afterEach(() => {
    process.argv = savedArgv;
  });

  it("isRemoteRoot is false when marker is not in argv", () => {
    process.argv = ["bun", "script.ts"];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });

  it("isRemoteRoot is true when marker is in argv", async () => {
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    const marker = `--remote=${hash}`;

    process.argv = ["bun", "script.ts", marker];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(true);
  });

  it("manual: true prevents auto remote root detection", async () => {
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    const marker = `--remote=${hash}`;

    process.argv = ["bun", "script.ts", marker];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL, { manual: true });
    expect(def.isRemoteRoot).toBe(false);
  });
});

// ── returned shape ─────────────────────────────────────────────────────────

describe("defineRemoteActor — return shape", () => {
  it("returns { actor, runRemoteRoot, isRemoteRoot }", () => {
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(typeof def.isRemoteRoot).toBe("boolean");
    expect(typeof def.runRemoteRoot).toBe("function");
    expect(def.actor).toBeDefined();
    expect(typeof def.actor.spawn).toBe("function");
  });

  it("actor.spawn returns an AsyncProcess", async () => {
    const { actor } = defineRemoteActor(makeDummyActor(), TEST_URL);
    const proc = await actor.spawn({});
    expect(proc).toBeDefined();
    expect(typeof proc.send).toBe("function");
    expect(typeof proc.wait).toBe("function");
    expect(typeof proc.subscribe).toBe("function");
  });

  it("runRemoteRoot returns a Promise", () => {
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    const result = def.runRemoteRoot();
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });
});

// ── marker format ──────────────────────────────────────────────────────────

describe("defineRemoteActor — marker format", () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = [...process.argv];
  });
  afterEach(() => {
    process.argv = savedArgv;
  });

  it("correct hash triggers isRemoteRoot", async () => {
    const scriptPath = fileURLToPath(TEST_URL);
    const expectedHash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);

    process.argv = ["bun", "script.ts", `--remote=${expectedHash}`];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(true);
  });

  it("wrong hash does not trigger isRemoteRoot", () => {
    process.argv = ["bun", "script.ts", "--remote=deadbeefcafe"];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });

  it("--remote without =value does not trigger isRemoteRoot", () => {
    process.argv = ["bun", "script.ts", "--remote"];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });

  it("--remote= (empty hash) does not match", () => {
    process.argv = ["bun", "script.ts", "--remote="];
    const def = defineRemoteActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });
});
