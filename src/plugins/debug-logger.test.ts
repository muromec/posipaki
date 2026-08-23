// ── debugLogger Plugin Tests ────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";
import { debugLogger, defaultMsgFilter } from "./debug-logger.js";
import type { Logger } from "./debug-logger.js";
import assert from "assert";
import { nextState } from '../testing/tick-utils.js';

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
  kind: "debug" | "msg" | "error" | "lifecycle";
  msgType?: string;
  event?: string;
  payload?: unknown;
}

function recordFactory(calls: DebugCall[]): (name: string) => Logger {
  return (name: string) => ({
    debug: (msg: string) => {
      calls.push({ name, kind: "debug", msgType: msg.match(/← (\w+)/)?.[1] ?? "" });
    },
    info: () => {},
    warn: () => {},
    error: () => {
      calls.push({ name, kind: "error" });
    },
    msg: (message: Message) => {
      calls.push({ name, kind: "msg", msgType: message.type, payload: message });
    },
    lifecycle: (event: string, detail?: unknown) => {
      calls.push({ name, kind: "lifecycle", event, payload: detail });
    },
  });
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

async function sendAndStop(
  proc: Awaited<ReturnType<ReturnType<typeof makeActor>["spawn"]>>,
  msg: PokeMsg | NopMsg,
) {
  await proc.ready();
  proc.send(msg);
  await proc.stop();
}

// ── tests ────────────────────────────────────────────────────────────────

describe("debugLogger", () => {
  let calls: DebugCall[];

  beforeEach(() => {
    calls = [];
  });

  describe("lifecycle events", () => {
    it("emits started / stopping / stopped", async () => {
      const Actor = makeActor("lifecycle-test", { factory: recordFactory(calls) });
      const proc = await Actor.spawn({});
      await proc.ready();
      await proc.stop();

      const events = calls.filter((c) => c.kind === "lifecycle").map((c) => c.event);
      expect(events).toContain("started");
      expect(events).toContain("stopping");
      expect(events).toContain("stopped");
    });

    it("emits child-exited when a forked child exits", async () => {
      const Child = defineActor({
        name: "child",
        afterStart() {
          this.exit();
        },
        handlers: {},
      });
      const Parent = defineActor({
        name: "parent",
        plugins: [debugLogger({ factory: recordFactory(calls) })],
        async setup() {
          await this.fork(Child, undefined, {});
          return {};
        },
        handlers: {},
      });
      const proc = await Parent.spawn({});
      await proc.ready();
      await nextState(proc);
      await proc.stop();

      const childExits = calls.filter(
        (c) => c.kind === "lifecycle" && c.event === "child-exited",
      );
      expect(childExits.length).toBeGreaterThan(0);
      expect(childExits[0].payload).toBe("parent:child");
    });

    it("registers hooks regardless of the DEBUG env var", async () => {
      process.env.DEBUG = '';
      const Actor = makeActor("no-debug-gate", { factory: recordFactory(calls) });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.filter((c) => c.kind === "lifecycle").length).toBeGreaterThan(0);
    });
  });

  describe("message filter (shrink / skip)", () => {
    it("skips a message when the filter returns null", async () => {
      const Actor = makeActor("filter-skip", {
        factory: recordFactory(calls),
        msgFilter: (msg) => (msg.type === "POKE" ? null : msg),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(calls.filter((c) => c.kind === "msg" && c.msgType === "POKE")).toEqual([]);
    });

    it("logs the shrunk payload when the filter shrinks", async () => {
      const Actor = makeActor("filter-shrink", {
        factory: recordFactory(calls),
        msgFilter: (msg) =>
          msg.type === "POKE" ? ({ ...msg, value: 0 } as PokeMsg) : msg,
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 99 });
      const logged = calls.find((c) => c.kind === "msg" && c.msgType === "POKE");
      expect(logged).toBeDefined();
      expect((logged!.payload as PokeMsg).value).toBe(0);
    });
  });

  describe("ignore option", () => {
    it("silences listed message types", async () => {
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
      expect(calls.filter((c) => c.kind === "msg" && c.msgType === "POKE").length).toBe(0);
      expect(calls.filter((c) => c.kind === "msg" && c.msgType === "NOP").length).toBe(1);
    });
  });

  describe("default msgFilter", () => {
    it("shrinks oversized string and array fields", () => {
      const shrunk = defaultMsgFilter({
        type: "BIG",
        history: Array.from({ length: 100 }, () => "x"),
        note: "a".repeat(1000),
      } as unknown as Message) as unknown as Record<string, unknown>;
      expect(shrunk.history).toBe("[100 items]");
      expect(shrunk.note).toContain("… (1000 chars)");
    });

    it("leaves small messages untouched", () => {
      const msg: Message = { type: "SMALL", value: 1 } as unknown as Message;
      expect(defaultMsgFilter(msg)).toBe(msg);
    });

    it("applies by default when no custom filter is given", async () => {
      const Actor = makeActor("default-shrink", { factory: recordFactory(calls) });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send({ type: "NOP", history: Array.from({ length: 50 }, () => "x") } as unknown as NopMsg);
      await proc.stop();
      const logged = calls.find((c) => c.kind === "msg" && c.msgType === "NOP");
      expect(logged).toBeDefined();
      expect((logged!.payload as Record<string, unknown>).history).toBe("[50 items]");
    });
  });

  describe("decoration", () => {
    it("decorates self.log on every actor", async () => {
      let decoratedLog: Logger = undefined as unknown as Logger;
      const Actor = defineActor({
        name: "decoration-test",
        beforeStart() {
          decoratedLog = this.log;
        },
        plugins: [debugLogger()],
        handlers: {},
      });
      const proc = await Actor.spawn({});
      await proc.ready();

      assert(decoratedLog);
      expect(decoratedLog.debug).toBeTypeOf("function");
      expect(decoratedLog.lifecycle).toBeTypeOf("function");

      await proc.stop();
    });
  });

  describe("custom factory", () => {
    it("uses the provided logger factory", async () => {
      const customCalls: string[] = [];
      const Actor = makeActor("custom-test", {
        factory: (name: string) => ({
          debug: (msg: string) => {
            customCalls.push(`custom:${name}:${msg}`);
          },
          info: () => {},
          warn: () => {},
          error: () => {},
          msg: (message: Message) => {
            customCalls.push(`custom:${name}:msg:${message.type}`);
          },
          lifecycle: (event: string) => {
            customCalls.push(`custom:${name}:lifecycle:${event}`);
          },
        }),
      });
      await sendAndStop(await Actor.spawn({}), { type: "POKE", value: 1 });
      expect(customCalls.some((c) => c.includes("lifecycle:started"))).toBe(true);
    });
  });

  describe("integration", () => {
    it("does not interfere with normal operation", async () => {
      const Actor = makeActor("test-int", { factory: recordFactory(calls) });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send({ type: "POKE", value: 1 });
      expect(await nextState(proc)).toEqual({ x: 42 });
      await proc.stop();
    });
  });
});
