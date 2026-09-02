// ── defineSubprocessActor tests ────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { defineSubprocessActor } from "./define-subprocess.js";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

vi.mock("./server.js", () => ({
  serveRemoteActor: vi.fn(() => Promise.resolve()),
  makeSender: vi.fn(),
}));

vi.mock("./client.js", () => ({
  remoteClient: vi.fn(() => makeDummyProxyActor()),
}));

function makeDummyProxyActor() {
  return {
    name: "dummy",
    fn: async function* () {},
    async spawn() {
      return {
        send: () => {},
        wait: async () => ({}),
        subscribe: () => {},
        state: {},
      };
    },
  };
}

function makeDummyActor() {
  return defineActor({
    name: "dummy",
    inMessages: defineMessages<{ type: "PING"; count: number }>(),
    outMessages: defineMessages<{ type: "PONG"; count: number }>(),
    setup: () => ({ pings: 0 }),
    handlers: {
      PING(msg: { type: "PING"; count: number }) {
        this.emit({ type: "PONG", count: msg.count });
      },
    },
  });
}

const TEST_URL = "file://" + join(dirname(fileURLToPath(import.meta.url)), "./fixtures/manual.js");

describe("defineSubprocessActor — pathHash", () => {
  it("same URL produces same isRemoteRoot value", () => {
    const a = defineSubprocessActor(makeDummyActor(), TEST_URL);
    const b = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(a.isRemoteRoot).toBe(b.isRemoteRoot);
  });
});

describe("defineSubprocessActor — isRemoteRoot detection", () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = [...process.argv];
  });
  afterEach(() => {
    process.argv = savedArgv;
  });

  it("isRemoteRoot is false when marker is not in argv", () => {
    process.argv = ["bun", "script.ts"];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });

  it("isRemoteRoot is true when marker is in argv", () => {
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    process.argv = ["bun", "script.ts", `--remote=${hash}`];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(true);
  });

  it("manual: true prevents auto remote root detection", () => {
    const scriptPath = fileURLToPath(TEST_URL);
    const hash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    process.argv = ["bun", "script.ts", `--remote=${hash}`];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL, { manual: true });
    expect(def.isRemoteRoot).toBe(false);
  });
});

describe("defineSubprocessActor — return shape", () => {
  it("returns { actor, runRemoteRoot, isRemoteRoot }", () => {
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(typeof def.isRemoteRoot).toBe("boolean");
    expect(typeof def.runRemoteRoot).toBe("function");
    expect(def.actor).toBeDefined();
  });

  it("runRemoteRoot returns a Promise", () => {
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    const result = def.runRemoteRoot();
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });
});

describe("defineSubprocessActor — marker format", () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = [...process.argv];
  });
  afterEach(() => {
    process.argv = savedArgv;
  });

  it("correct hash triggers isRemoteRoot", () => {
    const scriptPath = fileURLToPath(TEST_URL);
    const expectedHash = createHash("sha256").update(scriptPath).digest("hex").slice(0, 12);
    process.argv = ["bun", "script.ts", `--remote=${expectedHash}`];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(true);
  });

  it("wrong hash does not trigger isRemoteRoot", () => {
    process.argv = ["bun", "script.ts", "--remote=deadbeefcafe"];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });

  it("--remote without =value does not trigger isRemoteRoot", () => {
    process.argv = ["bun", "script.ts", "--remote"];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });

  it("--remote= (empty hash) does not match", () => {
    process.argv = ["bun", "script.ts", "--remote="];
    const def = defineSubprocessActor(makeDummyActor(), TEST_URL);
    expect(def.isRemoteRoot).toBe(false);
  });
});
