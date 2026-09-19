// ── a handle on a process of the far side ──────────────────────────────────
//
// A handle is the id a connection knows a process by, and the one thing that
// makes the id worth having: a way to put a frame on the wire with it.  What is
// checked here is that everything it offers is either that, or what comes back
// because of it.

import { describe, it, expect } from "vitest";
import { inspect as utilInspect } from "node:util";
import { isRemoteProcess, PROCESS_REF } from "./process-ref.js";
import { RemoteProcess } from "./remote-process.js";
import type { Message } from "../types.js";

type Ping = { type: "PING"; n: number } & Message;
type Pong = { type: "PONG"; n: number } & Message;

function makeHandle(
  sent: Array<[Record<string, unknown>, number]> = [],
  ref: { id: number; pname: string } = { id: 2, pname: "remote:kid" },
  kept = true,
) {
  const letGo: number[] = [];
  const handle = new RemoteProcess<Ping, Pong>(
    ref,
    (frame, to) => {
      sent.push([frame, to]);
    },
    "here",
    (id) => letGo.push(id),
  );
  // A handle that is asked anything is one something here keeps, so these keep one by
  // default; what an unkept reference does is its own set of tests.
  if (kept) handle.holdRef();
  return { handle, sent, letGo };
}

/** A reference nothing here keeps: nothing is heard from it, and it says so. */
function makeUnheldHandle() {
  const { handle, sent, letGo } = makeHandle();
  handle.releaseRef();
  sent.length = 0;
  letGo.length = 0;
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

  it("waits for what it holds, asking for it while it waits", async () => {
    const { handle, sent } = makeHandle();

    const waiting = handle.ready();

    // Asking and waiting are one act: a process that crossed is silent until something
    // here wants to hear it.
    expect(sent).toEqual([[{ $tune: { streams: ["state"] } }, 2]]);

    handle.receiveState({ ticks: 0 });
    await expect(waiting).resolves.toBeUndefined();
  });

  it("does not ask again for state it already has", async () => {
    const { handle, sent } = makeHandle();
    handle.receiveState({ ticks: 1 });

    await handle.ready();

    expect(handle.state).toEqual({ ticks: 1 });
    expect(sent).toEqual([]);
  });

  it("settles the wait when the process ends without saying anything", async () => {
    const { handle } = makeHandle();

    const waiting = handle.ready();
    handle.receiveExit({ code: 0, state: null });

    await expect(waiting).resolves.toBeUndefined();
  });

  it("settles the wait when the connection goes", async () => {
    const { handle } = makeHandle();

    const waiting = handle.ready();
    handle.disconnect();

    await expect(waiting).resolves.toBeUndefined();
  });

  it("settles the wait when the handle is let go of", async () => {
    const { handle } = makeHandle();

    const waiting = handle.ready();
    handle.release();

    await expect(waiting).resolves.toBeUndefined();
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


  it("is nothing until something keeps it, and hearing from it says what to do", () => {
    const { handle } = makeHandle([], { id: 2, pname: "remote:kid" }, false);

    expect(handle.refCount()).toBe(0);
    expect(() => handle.tune(["state"])).toThrow(/holdRef\(\) to keep this reference, or releaseRef\(\)/);
    expect(() => handle.subscribe("state", () => {})).toThrow(/holdRef/);
    expect(() => handle.ready()).toThrow(/holdRef/);

    handle.holdRef();
    expect(handle.refCount()).toBe(1);
    expect(() => handle.tune(["state"])).not.toThrow();
  });

  it("counts what it is kept by, and lets go when the last count goes", () => {
    const { handle, sent, letGo } = makeHandle();

    expect(handle.holdRef()).toBe(handle);
    expect(handle.refCount()).toBe(2);

    handle.releaseRef();
    expect(handle.refCount()).toBe(1);
    expect(handle.isConnected()).toBe(true);
    expect(sent).toEqual([]);

    handle.releaseRef();
    expect(handle.refCount()).toBe(0);
    expect(letGo).toEqual([2]);
    expect(handle.isConnected()).toBe(false);
  });

  it("gives the last count back without asking anything of a process that is gone", () => {
    const ended = makeHandle();
    ended.handle.receiveExit({ code: 0, state: { pings: 1 } });

    // Nothing is left to ask it for and nothing to tell the far side: the count going back
    // is the end of it, and the words for an ended process are not an error here.
    expect(() => ended.handle.releaseRef()).not.toThrow();
    expect(ended.letGo).toEqual([2]);
    expect(ended.handle.hasEnded()).toBe(true);

    const gone = makeHandle();
    gone.handle.disconnect();
    expect(() => gone.handle.releaseRef()).not.toThrow();
    expect(gone.letGo).toEqual([2]);
  });

  it("keeps the references sitting in what it holds, and lets them go with it", () => {
    const parent = makeHandle();
    const child = makeHandle([], { id: 4, pname: "remote:kid:leaf" }, false);

    parent.handle.receiveState({ leaf: child.handle });

    // Being held is what lets a reference be heard from, and what a process holds is held
    // here by the mere fact of sitting in it.
    expect(child.handle.refCount()).toBe(1);
    expect(() => child.handle.subscribe("state", () => {})).not.toThrow();

    parent.handle.release();

    expect(child.letGo).toEqual([4]);
    expect(child.handle.refCount()).toBe(0);
  });

  it("does not count a reference that arrived to be passed on, and drops it with the handle", () => {
    const parent = makeHandle();
    const guest = makeHandle([], { id: 6, pname: "remote:guest" }, false);
    const body = { type: "PONG", n: 1, guest: guest.handle } as unknown as Pong;

    parent.handle.receiveMessage(body, "remote:kid");
    expect(guest.handle.refCount()).toBe(0);

    parent.handle.release();

    expect(guest.letGo).toEqual([6]);
  });

  it("leaves a reference somebody kept to them when the one that carried it goes", () => {
    const parent = makeHandle();
    const guest = makeHandle([], { id: 6, pname: "remote:guest" }, false);
    const body = { type: "PONG", n: 1, guest: guest.handle } as unknown as Pong;

    parent.handle.receiveMessage(body, "remote:kid");
    guest.handle.holdRef();

    parent.handle.release();

    expect(guest.letGo).toEqual([]);
    expect(guest.handle.refCount()).toBe(1);
    expect(guest.handle.isConnected()).toBe(true);
  });

  it("says what it is, and an unkept reference is an unstable one", () => {
    const kept = makeHandle();
    const loose = makeHandle([], { id: 4, pname: "remote:kid:leaf" }, false);

    expect(JSON.stringify(loose.handle)).toBe('"UnstableReference"');
    expect(utilInspect(loose.handle)).toBe("UnstableReference");

    // A reference something keeps is the reference it is: the same one the wire carries.
    expect(JSON.stringify(kept.handle)).toBe('{"$p":{"id":2,"pname":"remote:kid"}}');
    expect(utilInspect(kept.handle)).toBe("RemoteProcess(2: remote:kid)");
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
    // Gone is not out of reach: the handle still names it, and what it left is here.
    // It is the process that can be asked nothing more.
    expect(handle.isConnected()).toBe(true);
    expect(await handle.wait()).toEqual({ code: 0, state: { pings: 1 } });
    expect(() => handle.send({ type: "PING", n: 1 })).toThrow(/has ended/);
    expect(() => handle.pause()).toThrow(/has ended/);
    expect(() => handle.stop()).toThrow(/has ended/);
    // And there is no id left to let go of: an end drops it on the far side, so the
    // handle that names a process gone is told it has ended rather than released.
    expect(() => handle.release()).toThrow(/has ended/);
    expect(handle.isConnected()).toBe(true);
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

    // Stopping waits for the end, and waiting is a subscription to the end: the
    // exit has to be asked for first, or there is nothing to resolve it.
    expect(sent).toEqual([
      [{ $tune: { streams: ["exit"] } }, 2],
      [{ $stop: {} }, 2],
    ]);
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
    // Subscribing is asking: a process that crossed is silent until something here
    // says what it wants to hear.
    expect(sent).toEqual([[{ $tune: { streams: ["state"] } }, 2]]);

    handle.receiveState({ pings: 0 });
    sent.length = 0;
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
    expect(() => handle.tune(["state"])).toThrow(/was released/);
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
    expect(sent).toEqual([[{ $tune: { streams: ["state"] } }, 2]]);
    sent.length = 0;

    handle.disconnect();
    handle.disconnect();

    expect(handle.isConnected()).toBe(false);
    expect(told).toBe(1);
    expect(() => handle.send({ type: "PING", n: 1 })).toThrow(/cannot be reached/);
    expect(() => handle.pause()).toThrow(/cannot be reached/);
    expect(() => handle.resume()).toThrow(/cannot be reached/);
    expect(() => handle.stop()).toThrow(/cannot be reached/);
    // Asking over a wire that is gone asks nothing: there is no far side to hear
    // it and no answer coming, so the handle does not pretend it asked.
    handle.subscribe("message", () => {});
    expect(sent).toEqual([]);
  });

  it("asks the far side for less, and for nothing at all", () => {
    const { handle, sent } = makeHandle();

    handle.tune(["state"]);
    handle.tune(["state", "message"]);
    handle.tune("silent");

    // Named in the one order the three are ever named in, so asking for the same
    // thing twice looks the same on the wire.
    expect(sent).toEqual([
      [{ $tune: { streams: ["state"] } }, 2],
      [{ $tune: { streams: ["message", "state"] } }, 2],
      [{ $tune: { streams: [] } }, 2],
    ]);
  });

  it("asks once for what it is already being told", () => {
    const { handle, sent } = makeHandle();

    handle.tune(["message", "message"]);
    handle.tune(["message"]);
    handle.subscribe("message", () => {});
    handle.subscribe("message", () => {});

    expect(sent).toEqual([[{ $tune: { streams: ["message"] } }, 2]]);
  });

  it("asks again when something here wants what silence turned off", () => {
    const { handle, sent } = makeHandle();
    handle.tune("silent");
    sent.length = 0;

    handle.subscribe("state", () => {});

    expect(sent).toEqual([[{ $tune: { streams: ["state"] } }, 2]]);
  });

  it("asks for the end when something waits for it", async () => {
    const { handle, sent } = makeHandle();

    const waiting = handle.wait();

    expect(sent).toEqual([[{ $tune: { streams: ["exit"] } }, 2]]);

    handle.receiveExit({ code: 0, state: { pings: 3 } });
    await expect(waiting).resolves.toEqual({ code: 0, state: { pings: 3 } });
  });
});
