import { describe, it, expect, vi } from "vitest";
import { spawn } from "./index";
import type { ProcessCtx, Message } from "./types";
import type { PongM, PingM } from "./test-helpers.js";
import type { ExitMessage } from "./util";

describe("Process", () => {
  type SimpleStore = { state: string };
  type ChangeM = { type: "CHANGE"; data: string };
  type Nil = null;

  function* p1() {
    yield { state: "s1" };
  }

  it("exposes state after ready()", async () => {
    const proc = spawn(p1, "p1")(null);
    await proc.ready();
    expect(proc.state).toEqual({ state: "s1" });
  });

  it("assigns a unique symbol id", () => {
    const proc = spawn(p1, "p1")(null);
    expect(proc.id).not.toBe(Symbol.for("p1"));
    expect(proc.id.toString()).toEqual("Symbol(p1)");
  });

  function* p2() {
    const state = { state: "p1" };
    yield state;
    const msg: ChangeM = yield null;
    state.state = msg.data;
  }

  it("updates state after tick()", async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, "p2")(null);
    await proc.ready();
    proc.send({ type: "CHANGE", data: "s2" });
    await proc.tick();
    expect(proc.state).toEqual({ state: "s2" });
  });

  it("notifies subscriber after tick()", async () => {
    const cb = vi.fn();
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, "p2")(null);
    await proc.ready();
    proc.subscribe(cb);
    proc.send({ type: "CHANGE", data: "s2" });
    await proc.tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("wait() resolves when generator completes", async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p1, "p2")(null);
    await proc.ready();
    await expect(proc.wait()).resolves.toBe(undefined);
  });

  it("wait() resolves after draining messages", async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, "p2")(null);
    await proc.ready();
    const res = proc.wait();
    expect(res).toBeInstanceOf(Promise);
    proc.send({ type: "CHANGE", data: "s2" });
    await proc.tick();
    await expect(res).resolves.toBe(undefined);
  });

  function* p3(ctx: ProcessCtx<unknown, null, Message, ExitMessage | PongM>) {
    yield null;
    const msg: Message = yield null;
    ctx.toParent({ type: "PONG", pseq: 0 });
    if (msg.type === "TRIGGER") {
      ctx.toParent({ type: "PONG", pseq: 0 });
    }
  }

  it("emits to parent and sends EXIT", async () => {
    const bus = vi.fn();
    const proc = spawn<Nil, SimpleStore, Message, ExitMessage | PongM>(
      p3,
      "p3",
      bus,
    )(null);
    await proc.ready();
    proc.send({ type: "TRIGGER" } as Message);
    await proc.tick();
    expect(bus).toHaveBeenCalledWith(expect.objectContaining({ type: "PONG", pseq: 0 }));
    expect(bus).toHaveBeenCalledWith(expect.objectContaining({ type: "EXIT" }));
  });

  type CountStore = { seq: number };

  function* p4(ctx: ProcessCtx<unknown, { seq: number }, PingM, ExitMessage | PongM>) {
    const state = { seq: 0 };
    yield state;
    while (state.seq < 5) {
      const msg: PingM = yield null;
      if (msg.pseq !== state.seq) break;
      ctx.toParent({ type: "PONG", pseq: state.seq });
      state.seq += 1;
    }
  }

  it("plays ping-pong and exits after five messages", async () => {
    const bus = vi.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
      bus,
    )(null);
    await proc.ready();
    for (let i = 0; i < 5; i++) {
      proc.send({ type: "PING", pseq: i });
      await proc.tick();
      expect(bus).toHaveBeenCalledWith(expect.objectContaining({ type: "PONG", pseq: i }));
    }
    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EXIT", pid: proc.id }),
    );
    expect(bus).toHaveBeenCalledTimes(6);
  });

  it("exits early on sequence break", async () => {
    const bus = vi.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
      bus,
    )(null);
    await proc.ready();
    proc.send({ type: "PING", pseq: 0 });
    await proc.tick();
    expect(bus).toHaveBeenCalledWith(expect.objectContaining({ type: "PONG", pseq: 0 }));
    proc.send({ type: "PING", pseq: 2 });
    await proc.tick();
    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EXIT", pid: proc.id }),
    );
    expect(bus).toHaveBeenCalledTimes(2);
  });

  it("supports multiple subscribers with unsubscribe", async () => {
    const s1 = vi.fn(),
      s2 = vi.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
    )(null);
    await proc.ready();
    const cb1 = () => s1(proc.state ? proc.state.seq : null);
    const cb2 = () => s2(proc.state ? proc.state.seq : null);
    expect(proc.isListenedTo).toBe(false);
    const u1 = proc.subscribe(cb1);
    proc.send({ type: "PING", pseq: 0 });
    await proc.tick();
    expect(s1).toHaveBeenCalledWith(1);
    expect(s2).not.toHaveBeenCalled();
    expect(proc.isListenedTo).toBe(true);
    const u2 = proc.subscribe(cb2);
    proc.send({ type: "PING", pseq: 1 });
    await proc.tick();
    expect(s1).toHaveBeenCalledWith(2);
    expect(s2).toHaveBeenCalledWith(2);
    u2();
    proc.send({ type: "PING", pseq: 2 });
    await proc.tick();
    expect(s1).toHaveBeenCalledWith(3);
    expect(s2).toHaveBeenCalledTimes(1);
    u1();
    proc.send({ type: "PING", pseq: 3 });
    await proc.tick();
    expect(s1).toHaveBeenCalledTimes(3);
    expect(s2).toHaveBeenCalledTimes(1);
    expect(proc.isListenedTo).toBe(false);
  });

  it("buffers while paused, processes on resume", async () => {
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
    )(null);
    await proc.ready();
    proc.pause();
    proc.send({ type: "PING", pseq: 0 });
    proc.send({ type: "PING", pseq: 1 });
    proc.send({ type: "PING", pseq: 2 });
    expect(proc.state).toEqual({ seq: 0 });
    proc.resume();
    await proc.tick();
    expect(proc.state).toEqual({ seq: 3 });
  });
});
