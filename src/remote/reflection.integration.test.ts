// ── reflection across a real process boundary ──────────────────────────────
//
// The whole seam, end to end: a payload in a process of its own, driven through
// json1 over a fifo pair.  What the unit tests cannot check is here — that the
// announcement survives the encoder, and that the tree a harness walks does not
// stop at the boundary.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { defineActor } from "../index.js";
import { remoteClient } from "./client.js";
import { commandSpawner } from "./spawners/fifo-command.js";
import { RemoteProcess } from "./remote-process.js";
import type { TreeNode } from "../plugins/tree-introspection.js";
import type { Message } from "../types.js";
import { sleep } from "../util.js";

type Surface = Record<string, (...args: unknown[]) => Promise<unknown>>;

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

const fixture = join(dirname(import.meta.url.slice(7)), "./fixtures/reflect-payload.js");

/** A process of this side's own, with something to say when it is spoken to, so
 *  the other end of the wire can see it work. */
const worker = defineActor({
  name: "mine",
  async setup() {
    return { pings: 0 };
  },
  handlers: {
    async PING() {
      this.state.pings += 1;
      this.ctx.notify();
      await this.emit({ type: "PONG" });
    },
  },
});

async function spawnPayload() {
  const actor = remoteClient<Record<string, unknown>, Record<string, unknown>, Message, Message>(
    "reflector",
    commandSpawner([process.argv[0], fixture]),
  );
  const proc = await actor.spawn({});
  return { proc, surface: proc.$reflection as unknown as Surface };
}

describe("reflection across a process boundary", () => {
  it("answers a call with the far side's own method", async () => {
    const { proc, surface } = await spawnPayload();

    expect(await surface["probe.add"](40, 2)).toBe(42);

    await proc.stop();
  }, 20000);

  it("keeps two calls to the same method apart", async () => {
    const { proc, surface } = await spawnPayload();

    const [slow, quick] = await Promise.all([surface["probe.late"](30), surface["probe.late"](0)]);
    expect([slow, quick]).toEqual(["late:30", "late:0"]);

    await proc.stop();
  }, 20000);

  it("carries a refusal back as the reason", async () => {
    const { proc, surface } = await spawnPayload();

    await expect(surface["probe.boom"]()).rejects.toThrow("probe said no");
    await expect(surface["probe.refusing"]()).rejects.toThrow(/cannot cross a frame/);
    expect(surface["probe.nope"]).toBeUndefined();

    await proc.stop();
  }, 20000);

  it("hands back a handle for a process on the far side", async () => {
    const { proc, surface } = await spawnPayload();

    const first = (await surface["inspect.find"]("remote:kid")) as RemoteProcess;
    const second = (await surface["inspect.find"]("remote:kid")) as RemoteProcess;

    expect(first).toBeInstanceOf(RemoteProcess);
    expect(first.pname).toBe("remote:kid");
    expect(first.ref.id).toBeGreaterThan(0);
    // Handed over twice, it is one process, so it is one handle.
    expect(second).toBe(first);

    // And a process the far side does not have is still just null.
    expect(await surface["inspect.find"]("remote:nope")).toBeNull();

    await proc.stop();
  }, 20000);

  it("takes a reference back as an argument, parsed on the far side", async () => {
    const { proc, surface } = await spawnPayload();

    const found = (await surface["inspect.find"]("remote:kid")) as RemoteProcess;
    const seen = (await surface["probe.whatItGot"](found)) as {
      name: string;
      pname: string;
      canFork: boolean;
    };
    // Handed back to the side that holds it, a reference is the process itself.
    expect(seen.pname).toBe("remote:kid");
    expect(seen.canFork).toBe(true);

    // A process of mine goes the other way: numbered on this side, and a handle
    // on that side — a process it cannot fork, only talk to.
    const mine = await defineActor({ name: "mine", handlers: {} }).spawn({});
    const seenMine = (await surface["probe.whatItGot"](mine)) as {
      name: string;
      pname: string;
      canFork: boolean;
    };
    expect(seenMine.name).toBe("RemoteProcess");
    expect(seenMine.pname).toBe("mine");
    expect(seenMine.canFork).toBe(false);
    await mine.stop();

    await proc.stop();
  }, 20000);

  it("gets a handle on a process the far side put on its state, and is answered by it", async () => {
    const { proc } = await spawnPayload();

    const kid = (proc.state as unknown as { kid?: RemoteProcess }).kid;
    expect(kid).toBeInstanceOf(RemoteProcess);
    expect(kid?.pname).toBe("remote:kid");
    expect(kid?.isConnected()).toBe(true);

    // It crossed, so it was streamed: what it holds is here without anyone asking.
    await waitUntil(() => kid?.state !== null, "the state it streamed");
    expect(kid?.state).toEqual({ pings: 0 });

    const heard: Array<{ type?: string }> = [];
    kid?.subscribe("message", (msg) => heard.push(msg as { type?: string }));
    kid?.send({ type: "PING" });

    await waitUntil(() => heard.length > 0, "the far side's answer");
    expect(heard[0]).toEqual({ type: "PONG" });
    expect(kid?.state).toEqual({ pings: 1 });

    await proc.stop();
  }, 20000);

  it("hands a process of mine over, and a message from there is answered where it lives", async () => {
    const { proc, surface } = await spawnPayload();

    const mine = await worker.spawn({});
    const seen = (await surface["probe.poke"](mine)) as { heard: string[]; pings: number };

    // The far side could only answer once the message had been delivered here and
    // the result had come back over the wire: what it holds and what it says, on
    // the stream that started when it crossed.
    expect(seen).toEqual({ heard: ["PONG"], pings: 1 });
    expect((mine.state as unknown as { pings: number }).pings).toBe(1);

    await mine.stop();
    await proc.stop();
  }, 20000);

  it("stops a process on the far side, and knows when it is gone", async () => {
    const { proc } = await spawnPayload();

    const kid = (proc.state as unknown as { kid?: RemoteProcess }).kid!;
    await waitUntil(() => kid.state !== null, "the state it streamed");

    await kid.stop();

    expect(kid.hasEnded()).toBe(true);
    // Gone, not merely out of reach: there is nothing to send to any more.
    expect(() => kid.send({ type: "PING" })).toThrow(/has ended/);

    await proc.stop();
  }, 20000);

  it("lets a handle go, and the far side stops knowing the process by that id", async () => {
    const { proc, surface } = await spawnPayload();

    const kid = (await surface["inspect.find"]("remote:kid")) as RemoteProcess;
    await waitUntil(() => kid.state !== null, "the state it streamed");
    const id = kid.ref.id;

    kid.release();

    expect(kid.isConnected()).toBe(false);
    expect(() => kid.send({ type: "PING" })).toThrow(/was released/);

    // What the far side let go of is the id, not the process: asked again, the same
    // process is numbered afresh, and the handle that let it go is done.
    const again = (await surface["inspect.find"]("remote:kid")) as RemoteProcess;
    expect(again.pname).toBe("remote:kid");
    expect(again.ref.id).not.toBe(id);
    expect(again).not.toBe(kid);

    await proc.stop();
  }, 20000);

  it("holds a process on the far side back while it is paused", async () => {
    const { proc } = await spawnPayload();

    const kid = (proc.state as unknown as { kid?: RemoteProcess }).kid!;
    await waitUntil(() => kid.state !== null, "the state it streamed");

    kid.pause();
    kid.send({ type: "PING" });
    await sleep(50);
    expect(kid.state).toEqual({ pings: 0 });

    kid.resume();
    await waitUntil(() => (kid.state as { pings?: number }).pings === 1, "the message it took after resuming");

    await proc.stop();
  }, 20000);

  it("hands a process of mine over, and the far side ends it and waits for that", async () => {
    const { proc, surface } = await spawnPayload();

    const mine = await worker.spawn({});
    expect(await surface["probe.finish"](mine)).toEqual({ ended: true });

    // The far side is not guessing: the exit it waited for is the one this side's
    // process really reached.
    await mine.wait();

    await proc.stop();
  }, 20000);

  it("carries a process of mine inside a message, and the far side reads it as a handle", async () => {
    const { proc, surface } = await spawnPayload();

    const heard: Array<{ type?: string }> = [];
    proc.subscribe("message", (msg) => heard.push(msg as { type?: string }));

    const mine = await worker.spawn({});
    proc.send({ type: "KEEP", kid: mine } as { type: "KEEP"; kid: unknown } & Message);

    // The far side says so itself, once the message that carried the process has
    // been through its handlers.
    await waitUntil(() => heard.some((msg) => msg.type === "KEPT"), "the acknowledgement");
    expect(await surface["probe.kept"]()).toEqual({ pname: "mine", canSend: true });

    await mine.stop();
    await proc.stop();
  }, 20000);

  it("walks into the far side's tree instead of stopping at the boundary", async () => {
    const { proc, surface } = await spawnPayload();

    const tree = (await surface["inspect.getTree"]()) as TreeNode;
    expect(tree.status).toBe("running");
    expect(tree.children.map((child) => child.pname)).toEqual(["remote:kid"]);
    expect(tree.children[0].status).toBe("no introspection");

    await proc.stop();
  }, 20000);
});
