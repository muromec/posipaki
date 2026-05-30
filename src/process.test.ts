import { describe, it, expect, vi } from "vitest";
import { spawn } from "./index";
import type { ProcessCtx, Message } from "./types";
import type { ExitMessage } from "./util";

describe("Process", () => {
  type SimpleStore = {
    state: string;
  };
  type ChangeM = {
    type: "CHANGE";
    data: string;
  };
  type Nil = null;

  function* p1() {
    yield { state: "s1" };
  }

  it("should expose process state returned from generator", async () => {
    const proc = spawn(p1, "p1")(null);
    await proc.ready();
    expect(proc.state).toEqual({ state: "s1" });
  });

  it("should set process id to unique symbol created from the process name", () => {
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

  it("should change internal state in response to message", async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, "p2")(null);
    await proc.ready();
    proc.send({ type: "CHANGE", data: "s2" });
    await await proc.tickAsync();
    expect(proc.state).toEqual({ state: "s2" });
  });

  it("should notify subscriber when the state changes", async () => {
    const callback = vi.fn();
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, "p2")(null);
    proc.subscribe(callback);
    proc.send({ type: "CHANGE", data: "s2" });
    await await proc.tickAsync();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("should resolve proc.wait() when generator runs out", async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p1, "p2")(null);
    const res = proc.wait();
    expect(await res).toBe(undefined);
  });

  it("should wait for generator to run out", async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, "p2")(null);
    const res = proc.wait();
    expect(res).toBeInstanceOf(Promise);

    proc.send({ type: "CHANGE", data: "s2" });
    await await proc.tickAsync();

    expect(await res).toBe(undefined);
  });

  type PongM = {
    type: "PONG";
    pseq: number;
  };
  function* p3(ctx: ProcessCtx<Message, ExitMessage | PongM>) {
    yield null;
    ctx.toParent({ type: "PONG", pseq: 0 });
  }

  it("should emit messages to parent", async () => {
    const bus = vi.fn();
    const proc = spawn<Nil, SimpleStore, Message, ExitMessage | PongM>(
      p3,
      "p3",
      bus,
    )(null);
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 0 });
    expect(bus).toHaveBeenCalledWith({ type: "EXIT", pid: proc.id });
  });

  type PingM = {
    type: "PING";
    pseq: number;
  };
  type CountStore = {
    seq: number;
  };

  function* p4(ctx: ProcessCtx<PingM, ExitMessage | PongM>) {
    const state = { seq: 0 };
    yield state;

    while (state.seq < 5) {
      const msg: PingM = yield null;
      if (msg.pseq !== state.seq) {
        break;
      }
      ctx.toParent({ type: "PONG", pseq: state.seq });
      state.seq += 1;
    }
  }

  it("should play ping-pong and keep count of messages", async () => {
    const bus = vi.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
      bus,
    )(null);

    proc.send({ type: "PING", pseq: 0 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 0 });

    proc.send({ type: "PING", pseq: 1 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 1 });

    proc.send({ type: "PING", pseq: 2 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 2 });

    proc.send({ type: "PING", pseq: 3 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 3 });

    proc.send({ type: "PING", pseq: 4 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 4 });
    expect(bus).toHaveBeenCalledWith({ type: "EXIT", pid: proc.id });
    expect(bus).toHaveBeenCalledTimes(6);
  });

  it("should exit ping-pong when sequence breaks", async () => {
    const bus = vi.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
      bus,
    )(null);

    proc.send({ type: "PING", pseq: 0 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "PONG", pseq: 0 });

    proc.send({ type: "PING", pseq: 2 });
    await await proc.tickAsync();
    expect(bus).toHaveBeenCalledWith({ type: "EXIT", pid: proc.id });

    expect(bus).toHaveBeenCalledTimes(2);
  });

  it("should allow two subscribers", async () => {
    const sub1 = vi.fn();
    const sub2 = vi.fn();

    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
    )(null);

    const cb1 = () => sub1(proc.state ? proc.state.seq : null);
    const cb2 = () => sub2(proc.state ? proc.state.seq : null);

    expect(proc.isListenedTo).toBe(false);
    const un1 = proc.subscribe(cb1);

    // dispatch
    vi.clearAllMocks();
    proc.send({ type: "PING", pseq: 0 });
    await proc.tickAsync();

    // check callbacks
    expect(sub1).toHaveBeenCalledWith(1);
    expect(sub2).not.toHaveBeenCalled();
    expect(proc.isListenedTo).toBe(true);

    const un2 = proc.subscribe(cb2);

    // dispatch
    vi.clearAllMocks();
    proc.send({ type: "PING", pseq: 1 });
    await proc.tickAsync();

    // check callbacks
    expect(sub1).toHaveBeenCalledWith(2);
    expect(sub2).toHaveBeenCalledWith(2);
    expect(proc.isListenedTo).toBe(true);

    un2();

    // dispatch
    vi.clearAllMocks();
    proc.send({ type: "PING", pseq: 2 });
    await proc.tickAsync();

    // check callbacks
    expect(sub1).toHaveBeenCalledWith(3);
    expect(sub2).not.toHaveBeenCalled();
    expect(proc.isListenedTo).toBe(true);

    un1();

    // dispatch
    vi.clearAllMocks();
    proc.send({ type: "PING", pseq: 3 });
    await proc.tickAsync();

    // check callbacks
    expect(sub1).not.toHaveBeenCalled();
    expect(sub2).not.toHaveBeenCalled();
    expect(proc.isListenedTo).toBe(false);
  });

  it("should pause the process and keep messages in a buffer until resume", async () => {
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(
      p4,
      "p4",
    )(null);
    proc.pause();
    proc.send({ type: "PING", pseq: 0 });
    proc.send({ type: "PING", pseq: 1 });
    proc.send({ type: "PING", pseq: 2 });

    expect(proc.state).toEqual({ seq: 0 });
    proc.resume();
    await proc.tickAsync();
    expect(proc.state).toEqual({ seq: 3 });
  });
});
