// ── a node that accepts connections ────────────────────────────────────────
//
// This side's accepting half against this side's initiating half, over a real socket: the two roles of the protocol
// have to agree before either can be measured against a node that was not written here.

import { afterEach, describe, expect, it } from "vitest";

import type { Channel } from "posipaki/port";

import { open } from "./connection.js";
import { listen, type Listener } from "./listen.js";
import type { Peer } from "./handshake.js";
import type { WireMessage } from "./messages.js";

const COOKIE = "pocookie";

const listeners: Listener[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close();
});

/** The default for a callback nobody has given yet: a test's promise, and a run that never answers it. */
const nothing = (): void => undefined;

async function node(): Promise<{ listener: Listener; peers: Peer[]; refused: string[]; said: Promise<string>; refusedOnce: Promise<string> }> {
  const peers: Peer[] = [];
  const refused: string[] = [];
  let heard: (text: string) => void = nothing;
  let turnedAway: (text: string) => void = nothing;
  const said = new Promise<string>((resolve) => {
    heard = resolve;
  });
  // The refusal is the trigger: a case waits for this side to say why, not for a clock.
  const refusedOnce = new Promise<string>((resolve) => {
    turnedAway = resolve;
  });
  const listener = await listen(
    { self: "posipaki@127.0.0.1", cookie: COOKIE, creation: 99, timeoutMs: 2_000 },
    {
      onConnection(peer: Peer, messages: Channel<WireMessage>) {
        peers.push(peer);
        messages.onFrame((message) => {
          if (message.kind !== "message" || message.payload?.kind !== "binary") return;
          heard(Buffer.from(message.payload.bytes).toString("utf8"));
        });
      },
      onRefused(error: Error) {
        refused.push(error.message);
        turnedAway(error.message);
      },
    },
  );
  listeners.push(listener);
  return { listener, peers, refused, said, refusedOnce };
}

describe("listen", () => {
  it("proves the cookie both ways and hands the connection over", async () => {
    const { listener, peers, said } = await node();
    const connection = await open(listener.port, {
      host: "127.0.0.1",
      node: "posipaki",
      cookie: COOKIE,
      self: "probe@127.0.0.1",
      creation: 7,
      timeoutMs: 2_000,
    });
    expect(connection.peer).toMatchObject({ name: "posipaki@127.0.0.1" });
    expect(peers).toMatchObject([{ name: "probe@127.0.0.1" }]);
    const ourPid = { kind: "pid" as const, node: "probe@127.0.0.1", id: 1, serial: 0, creation: 7 };
    await connection.messages.send({
      kind: "message",
      control: { kind: "regSend", from: ourPid, to: "posipaki" },
      payload: { kind: "binary", bytes: Buffer.from("hi", "utf8") },
    });
    expect(await said).toBe("hi");
    await connection.messages.close("done");
  });

  it("refuses a connection that does not know the cookie, and says so", async () => {
    const { listener, refusedOnce } = await node();
    await expect(
      open(listener.port, {
        host: "127.0.0.1",
        node: "posipaki",
        cookie: "another cookie",
        self: "probe@127.0.0.1",
        creation: 7,
        timeoutMs: 400,
      }),
    ).rejects.toThrow(/does not know this cookie/);
    // The accepting side names the same fact from its end, and that refusal is the trigger.
    expect(await refusedOnce).toContain("does not know the cookie");
  });
});
