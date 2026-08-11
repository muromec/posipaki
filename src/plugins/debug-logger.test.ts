// ── debugLogger Plugin Tests ────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";
import { debugLogger } from "./debug-logger.js";
import type { Logger } from "./debug-logger.js";
import assert from "assert";

// ── messages ─────────────────────────────────────────────────────────────

interface PokeMsg extends Message {
  type: "POKE";
  value: number;
}
interface NopMsg extends Message {
  type: "NOP";
}

const Pin = defineMessages<PokeMsg | NopMsg>();
const Pout = defineMessages<PokeMsg>();

// ── helpers ──────────────────────────────────────────────────────────────

interface DebugCall {
  name: string;
  msgType: string;
  kind: string;
}

function makeActor(name: string, opts?: Parameters<typeof debugLogger>[0]) {
  return defineActor({
    name,
    inMessages: Pin,
    outMessages: Pout,
    setup: () => ({ x: 0 }),
    plugins: [debugLogger(opts)],
    handlers: {
      POKE() {
        this.state.x = 42;
      },
      NOP() {},
    },
  });
}

function recordFactory(calls: DebugCall[]): (name: string) => Logger {
  return (name: string) => ({
    debug: (msg: string) => {
      const m = msg.match(/← (\w+)/);
      calls.push({ name, msgType: m ? m[1] : "", kind: "debug" });
    },
    info: () => {},
    warn: () => {},
    error: (_msg: string) => {},
  });
}

async function sendAndStop(
  proc: Awaited<ReturnType<ReturnType<typeof makeActor>["spawn"]>>,
  msg: PokeMsg | NopMsg,
) {
  await proc.ready();
  proc.send!(msg);
  proc.send!({ type: "STOP" });
  await proc.wait();
}

// ── tests ────────────────────────────────────────────────────────────────

describe("debugLogger", () => {
  let calls: DebugCall[];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    delete process.env.DEBUG;
  });

  describe("pattern matching", () => {
    it("* matches everything", async () => {
      process.env.DEBUG = "*";
      const Actor = makeActor("some-actor", {
        factory: recordFactory(calls),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.some((c) => c.name === "some-actor")).toBe(true);
    });

    it("prefix:* matches subtree", async () => {
      process.env.DEBUG = "openai:*";
      const Actor = makeActor("openai:connector", {
        factory: recordFactory(calls),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.some((c) => c.name === "openai:connector")).toBe(true);
    });

    it("exact name match", async () => {
      process.env.DEBUG = "openai:connector";
      const Actor = makeActor("openai:connector", {
        factory: recordFactory(calls),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.some((c) => c.name === "openai:connector")).toBe(true);
    });

    it("non-matching actor is skipped", async () => {
      process.env.DEBUG = "openai:connector";
      const Actor = makeActor("openai:tools", {
        factory: recordFactory(calls),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.some((c) => c.name === "openai:tools")).toBe(false);
    });

    it("multiple comma-separated patterns", async () => {
      process.env.DEBUG = "openai:connector,reflector:*";
      await sendAndStop(
        await makeActor("openai:connector", {
          factory: recordFactory(calls),
        }).spawn({}),
        { type: "POKE", value: 1 },
      );
      expect(calls.some((c) => c.name === "openai:connector")).toBe(true);
      calls.length = 0;
      await sendAndStop(
        await makeActor("reflector:openai", {
          factory: recordFactory(calls),
        }).spawn({}),
        { type: "POKE", value: 1 },
      );
      expect(calls.some((c) => c.name === "reflector:openai")).toBe(true);
    });

    it("empty DEBUG skips everything", async () => {
      delete process.env.DEBUG;
      const Actor = makeActor("anything", {
        factory: recordFactory(calls),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.length).toBe(0);
    });
  });

  describe("ignore option", () => {
    it("silences listed message types", async () => {
      process.env.DEBUG = "*";
      const Actor = makeActor("ignore-test", {
        ignore: ["POKE"],
        factory: recordFactory(calls),
      });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send({ type: "POKE", value: 1 });
      proc.send({ type: "NOP" });
      proc.send({ type: "STOP" });
      await proc.wait();
      expect(calls.filter((c) => c.msgType === "POKE").length).toBe(0);
      expect(calls.filter((c) => c.msgType === "NOP").length).toBe(1);
    });
  });

  describe("decoration", () => {
    it("decorates self.log on every actor regardless of DEBUG", async () => {
      delete process.env.DEBUG;
      let decoratedLog: Logger = undefined as unknown as Logger;
      const Actor = defineActor({
        name: "decoration-test",
        afterStart() {
          decoratedLog = this.log;
        },
        plugins: [debugLogger()],
        handlers: {},
      });
      const proc = await Actor.spawn({});
      await proc.ready();
      assert(decoratedLog);
      expect(decoratedLog).toBeDefined();
      expect(decoratedLog.debug).toBeTypeOf("function");
      proc.send({ type: "STOP" });
      await proc.wait();
    });
  });

  describe("custom factory", () => {
    it("uses the provided logger factory", async () => {
      process.env.DEBUG = "*";
      const customCalls: string[] = [];
      const Actor = makeActor("custom-test", {
        factory: (name: string) => ({
          debug: (msg: string) => {
            customCalls.push(`custom:${name}:${msg}`);
          },
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(customCalls.length).toBeGreaterThan(0);
      expect(customCalls[0]).toContain("custom:custom-test:");
    });
  });

  describe("integration", () => {
    it("does not interfere with normal operation", async () => {
      process.env.DEBUG = "*";
      const Actor = makeActor("test-int", {
        factory: recordFactory(calls),
      });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send({ type: "POKE", value: 1 });
      await new Promise((r) => setTimeout(r, 0));
      expect(proc.state!.x).toBe(42);
      proc.send({ type: "STOP" });
      await proc.wait();
    });
  });
});
