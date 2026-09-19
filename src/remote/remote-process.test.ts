// ── a handle on a process of the far side ──────────────────────────────────
//
// A handle is the id a connection knows a process by, and the one thing that
// makes the id worth having: a way to put a frame on the wire with it.  What is
// checked here is that everything it offers is either that, or what comes back
// because of it.

import { describe, it, expect } from "vitest";
import { isRemoteProcess, PROCESS_REF } from "./process-ref.js";
import { RemoteProcess } from "./remote-process.js";
import type { Message } from "../types.js";

type Ping = { type: "PING"; n: number } & Message;
type Pong = { type: "PONG"; n: number } & Message;

function makeHandle(sent: Array<[Record<string, unknown>, number]> = []) {
  const letGo: number[] = [];
  const handle = new RemoteProcess<Ping, Pong>(
    { id: 2, pname: "remote:kid" },
    (frame, to) => sent.push([frame, to]),
    "here",
    (id) => letGo.push(id),
  );
  return { handle, sent, letGo };
}

describe("RemoteProcess", () => {
  it("sends a message to the process, under the id this connection knows it by", () => {
    const { handle, sent } = makeHandle();

    handle.send({ type: "PING", n: 1 });

    expect(sent).toEqual([[{ $msg: { fromName: "here", body: { type: "PING", n: 1 } } }, 2]]);
    expect(handle.isConnected()).toBe(true);
    expect(handle.pname).toBe("remote:kid");
  });

  it("is a handle: named, identified, and able to send", () => {
    const { handle } = makeHandle();

    expect(isRemoteProcess(handle)).toBe(true);
    expect(isRemoteProcess({ pname: "no ref", id: Symbol("x"), send: () => {} })).toBe(false);
    expect(isRemoteProcess({ $p: { id: 1, pname: "a" } })).toBe(false);
  });

  it("keeps what the far side said about its state, and tells its subscribers", () => {
    const { handle } = makeHandle();
    const seen: Array<Record<string, unknown>> = [];
    handle.subscribe("state", () => seen.push({ ...(handle.state ?? {}) }));

    handle.receiveState({ hits: 1 });
    const after = handle.state;
    handle.receiveState({ ready: true });

    // Updates add up, the way the root's do, and keep landing in one object.
    expect(seen).toEqual([{ hits: 1 }, { hits: 1, ready: true }]);
    expect(handle.state).toEqual({ hits: 1, ready: true });
    expect(handle.state).toBe(after);
  });

  it("hands a message it emitted to whoever subscribed", () => {
    const { handle } = makeHandle();
    const seen: Array<[Pong, string]> = [];
    const stop = handle.subscribe("message", (msg, fromName) => seen.push([msg, fromName]));

    handle.receiveMessage({ type: "PONG", n: 1 }, "remote:kid");
    stop();
    handle.receiveMessage({ type: "PONG", n: 2 }, "remote:kid");

    expect(seen).toEqual([[{ type: "PONG", n: 1 }, "remote:kid"]]);
  });

  it("asks the connection for a method the far side announced", async () => {
    const { handle } = makeHandle();
    const asked: Array<[string, unknown[]]> = [];

    handle.receiveMethods(["inspect.getTree", "probe.add"], async (name, args) => {
      asked.push([name, args]);
      return `${name}:${args.length}`;
    });

    expect(Object.keys(handle.$reflection)).toEqual(["inspect.getTree", "probe.add"]);
    expect(await handle.$reflection["probe.add"](1, 2)).toBe("probe.add:2");
    expect(asked).toEqual([["probe.add", [1, 2]]]);
  });

  it("waits for the far side to say it ended, and hands back what it left", async () => {
    const { handle } = makeHandle();
    const waiting = handle.wait();
    expect(handle.hasEnded()).toBe(false);

    handle.receiveExit({ code: 0, state: { pings: 1 } });

    expect(await waiting).toEqual({ code: 0, state: { pings: 1 } });
    expect(handle.hasEnded()).toBe(true);
    // Nothing more can be asked of it: it is gone, not merely out of reach.
    expect(await handle.wait()).toEqual({ code: 0, state: { pings: 1 } });
    expect(() => handle.send({ type: "PING", n: 1 })).toThrow(/has ended/);
    expect(() => handle.pause()).toThrow(/has ended/);
    expect(() => handle.stop()).toThrow(/has ended/);
  });

  it("stops waiting when the connection goes, rather than waiting for ever", async () => {
    const { handle } = makeHandle();
    const waiting = handle.wait();
    handle.disconnect();

    await expect(waiting).rejects.toThrow(/cannot be reached/);
    await expect(handle.wait()).rejects.toThrow(/cannot be reached/);
  });

  it("asks the far side to stop it, and answers when its exit comes back", async () => {
    const { handle, sent } = makeHandle();
    const stopping = handle.stop();

    expect(sent).toEqual([[{ $stop: {} }, 2]]);
    expect(handle.hasEnded()).toBe(false);

    handle.receiveExit({ code: 0, state: {} });
    await expect(stopping).resolves.toBeUndefined();
  });

  it("pauses and resumes it by asking the far side to", () => {
    const { handle, sent } = makeHandle();

    handle.pause();
    handle.resume();

    expect(sent).toEqual([
      [{ $pause: {} }, 2],
      [{ $resume: {} }, 2],
    ]);
  });

  it("lets go of the id when this side releases it, and asks nothing more of it", async () => {
    const { handle, sent, letGo } = makeHandle();
    const seen: Array<Record<string, unknown>> = [];
    handle.subscribe("state", () => seen.push({ ...(handle.state ?? {}) }));
    handle.receiveState({ pings: 0 });

    handle.release();

    expect(sent).toEqual([[{ $release: {} }, 2]]);
    // The connection is told to stop knowing the id, so nothing arriving for it can
    // land here again.
    expect(letGo).toEqual([2]);
    // Dead, like a handle whose connection went: the wire is fine, but this handle
    // reaches nothing.
    expect(handle.isConnected()).toBe(false);
    // Let go is not the same as ended: what happened to it over there is not this
    // side's to know.
    expect(handle.hasEnded()).toBe(false);

    expect(() => handle.send({ type: "PING", n: 1 })).toThrow(/was released/);
    expect(() => handle.pause()).toThrow(/was released/);
    expect(() => handle.resume()).toThrow(/was released/);
    expect(() => handle.stop()).toThrow(/was released/);
    await expect(handle.wait()).rejects.toThrow(/was released/);

    // And what still arrives for it is not news.
    handle.receiveState({ pings: 9 });
    handle.receiveMessage({ type: "PONG", n: 9 }, "remote:kid");
    handle.receiveExit({ code: 0, state: { pings: 9 } });
    expect(handle.state).toEqual({ pings: 0 });
    expect(seen).toEqual([{ pings: 0 }]);
    expect(handle.hasEnded()).toBe(false);
  });

  it("says it is not connected once the connection is gone, and refuses to send", () => {
    const { handle, sent } = makeHandle();
    let told = 0;
    handle.subscribe("state", () => told++);

    handle.disconnect();
    handle.disconnect();

    expect(handle.isConnected()).toBe(false);
    expect(told).toBe(1);
    expect(() => handle.send({ type: "PING", n: 1 })).toThrow(/cannot be reached/);
    expect(() => handle.pause()).toThrow(/cannot be reached/);
    expect(() => handle.resume()).toThrow(/cannot be reached/);
    expect(() => handle.stop()).toThrow(/cannot be reached/);
    expect(sent).toEqual([]);
  });
});
