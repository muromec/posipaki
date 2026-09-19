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
  const handle = new RemoteProcess<Ping, Pong>(
    { id: 2, pname: "remote:kid" },
    (frame, to) => sent.push([frame, to]),
    "here",
  );
  return { handle, sent };
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

  it("says it is not connected once the connection is gone, and refuses to send", () => {
    const { handle, sent } = makeHandle();
    let told = 0;
    handle.subscribe("state", () => told++);

    handle.disconnect();
    handle.disconnect();

    expect(handle.isConnected()).toBe(false);
    expect(told).toBe(1);
    expect(() => handle.send({ type: "PING", n: 1 })).toThrow(/cannot be reached/);
    expect(sent).toEqual([]);
  });
});
