// ── process references ─────────────────────────────────────────────────────
//
// A process cannot be written down, so an answer about one carries an id the
// connection handed out and the name the far side knows it by.  What is checked
// here is the accounting around those ids — one per process, never reused, and
// the parity that keeps the two sides' ids apart — and that the walk copies
// rather than edits what the actor returned.

import { describe, it, expect, afterEach } from "vitest";
import { defineActor } from "../index.js";
import type { AsyncProcess } from "../process.async.js";
import type { Message } from "../types.js";
import {
  PROCESS_REF,
  ProcessTable,
  asProcessRef,
  decodeProcessRefs,
  encodeProcessRefs,
  isRemoteProcess,
  type ProcessRef,
} from "./process-ref.js";
import { RemoteProcess } from "./remote-process.js";

type Spawned = AsyncProcess<unknown, unknown, Message, Message, {}>;

const spawned: Spawned[] = [];

async function makeProcess(name = "target"): Promise<Spawned> {
  const Actor = defineActor({ name, setup: () => ({}), handlers: {} });
  const proc = (await Actor.spawn({})) as unknown as Spawned;
  spawned.push(proc);
  return proc;
}

/** A handle on a process the far side holds, with a sink that goes nowhere. */
function makeHandle(ref: ProcessRef): RemoteProcess {
  return new RemoteProcess(ref, () => {}, "here");
}

afterEach(async () => {
  for (const proc of spawned.splice(0)) await proc.stop();
});

describe("ProcessTable", () => {
  it("hands out one id per process, and never the same id for two", async () => {
    const table = new ProcessTable("odd");
    const first = await makeProcess("first");
    const second = await makeProcess("second");

    expect(table.handleFor(first)).toBe(3);
    expect(table.handleFor(first)).toBe(3);
    expect(table.handleFor(second)).toBe(5);

    // The first two ids of the parity are the two ends' roots, and neither is ever
    // handed out for anything else.
    expect(table.handleFor(await makeProcess("third"))).toBe(7);
  });

  it("keeps the first id of its parity for the root it was bound to", async () => {
    const odd = new ProcessTable("odd");
    const even = new ProcessTable("even");
    const root = await makeProcess("root");

    odd.bindRoot(root);
    expect(odd.rootId()).toBe(1);
    expect(odd.farRootId()).toBe(0);
    expect(odd.processFor(1)).toBe(root);
    expect(odd.resolve(1)).toBe(root);

    // The root takes a number like anything else, and the id in between is the far
    // side's root: the first id this side hands out is past both of them.
    expect(odd.handleFor(await makeProcess("kid"))).toBe(3);

    even.bindRoot(root);
    expect(even.rootId()).toBe(0);
    expect(even.farRootId()).toBe(1);
    expect(even.processFor(0)).toBe(root);
  });

  it("numbers each side's processes on its own half of the space", async () => {
    const odd = new ProcessTable("odd");
    const even = new ProcessTable("even");

    expect(odd.handleFor(await makeProcess("kid"))).toBe(3);
    expect(odd.handleFor(await makeProcess("other"))).toBe(5);
    expect(even.handleFor(await makeProcess("kid"))).toBe(2);
    expect(even.handleFor(await makeProcess("other"))).toBe(4);
  });

  it("holds the far side's processes under the ids they came with, apart from its own", async () => {
    const table = new ProcessTable("odd");
    const mine = await makeProcess("mine");
    const theirs = makeHandle({ id: 2, pname: "remote:kid" });

    expect(table.handleFor(mine)).toBe(3);
    table.bindFar(theirs.ref.id, theirs);

    // One number belongs to one side, so what it resolves to does not depend on
    // which way the frame that carries it was going.
    expect(table.processFor(3)).toBe(mine);
    expect(table.processFor(2)).toBeUndefined();
    expect(table.farHandleFor(2)).toBe(theirs);
    expect(table.farHandleFor(3)).toBeUndefined();
    expect(table.resolve(3)).toBe(mine);
    expect(table.resolve(2)).toBe(theirs);
    expect(table.resolve(4)).toBeUndefined();
    expect(table.handles()).toEqual([theirs]);
  });

  it("lets an id go, whichever side gave it, and never hands it out again", async () => {
    const table = new ProcessTable("odd");
    const mine = await makeProcess("mine");
    const theirs = makeHandle({ id: 2, pname: "remote:kid" });
    const id = table.handleFor(mine);
    table.bindFar(theirs.ref.id, theirs);

    expect(table.release(id)).toBe(mine);
    expect(table.resolve(id)).toBeUndefined();
    expect(table.release(2)).toBe(theirs);
    expect(table.farHandleFor(2)).toBeUndefined();
    expect(table.handles()).toEqual([]);

    // The same process crossing again is numbered afresh: an id let go is never
    // handed out twice, so nothing that still names it can mean another process.
    expect(table.handleFor(mine)).not.toBe(id);
  });

  it("does not let go of either root: one is its own end, the other what it talks to", async () => {
    const table = new ProcessTable("odd");
    const root = await makeProcess("root");
    table.bindRoot(root);
    const farRoot = makeHandle({ id: table.farRootId(), pname: "remote" });
    table.bindFar(table.farRootId(), farRoot);

    expect(table.release(table.rootId())).toBeUndefined();
    expect(table.release(table.farRootId())).toBeUndefined();
    expect(table.resolve(table.rootId())).toBe(root);
    expect(table.resolve(table.farRootId())).toBe(farRoot);
  });

  it("refuses a second root, and holds the far side's root like a process of theirs", async () => {
    const table = new ProcessTable("odd");
    const root = await makeProcess("root");
    table.bindRoot(root);
    const other = await makeProcess("other");

    expect(() => table.bindRoot(other)).toThrow(/already bound/);

    // The far side's root is a handle here, bound under the first id of the far side's
    // parity — the number this side's own numbering skipped.
    const farRoot = makeHandle({ id: 0, pname: "remote" });
    table.bindFar(0, farRoot);
    expect(table.farHandleFor(0)).toBe(farRoot);
    expect(table.resolve(0)).toBe(farRoot);
    expect(table.resolve(1)).toBe(root);
  });
});

describe("encodeProcessRefs", () => {
  it("writes a process as a reference, and leaves other values alone", async () => {
    const proc = await makeProcess("kid");
    const table = new ProcessTable("odd");

    expect(encodeProcessRefs(proc, table)).toEqual({
      [PROCESS_REF]: { id: 3, pname: "kid" },
    });
    expect(encodeProcessRefs({ count: 2, ok: true, missing: null }, table)).toEqual({
      count: 2,
      ok: true,
      missing: null,
    });
  });

  it("walks objects and arrays, and writes the same id for the same process", async () => {
    const kid = await makeProcess("kid");
    const other = await makeProcess("other");
    const table = new ProcessTable("odd");

    const encoded = encodeProcessRefs({ kids: [kid, { deep: other }], again: kid }, table);
    expect(encoded).toEqual({
      kids: [
        { [PROCESS_REF]: { id: 3, pname: "kid" } },
        { deep: { [PROCESS_REF]: { id: 5, pname: "other" } } },
      ],
      again: { [PROCESS_REF]: { id: 3, pname: "kid" } },
    });
  });

  it("copies the containers it walks: the actor's own objects are not rewritten", async () => {
    const proc = await makeProcess("kid");
    const table = new ProcessTable("odd");
    const state = { child: proc };

    const encoded = encodeProcessRefs(state, table);

    expect(encoded).not.toBe(state);
    expect(state.child).toBe(proc);
    expect(encoded).toEqual({ child: { [PROCESS_REF]: { id: 3, pname: "kid" } } });
  });

  it("writes a root with the id its own side gave it", async () => {
    const odd = new ProcessTable("odd");
    const even = new ProcessTable("even");
    const root = await makeProcess("root");
    odd.bindRoot(root);
    even.bindRoot(root);

    expect(encodeProcessRefs(root, odd)).toEqual({ [PROCESS_REF]: { id: 1, pname: "root" } });
    // The other end of the same connection numbers its own root differently, and what
    // crosses is the number the side that holds it gave it.
    expect(encodeProcessRefs(root, even)).toEqual({ [PROCESS_REF]: { id: 0, pname: "root" } });
  });

  it("writes a handle back as the id it came with, whatever this side's table says", () => {
    const table = new ProcessTable("odd");
    const handle = makeHandle({ id: 2, pname: "remote:kid" });

    expect(encodeProcessRefs([handle], table)).toEqual([
      { [PROCESS_REF]: { id: 2, pname: "remote:kid" } },
    ]);
    // The id is the far side's, so nothing here has to know it.
    expect(table.resolve(2)).toBeUndefined();
  });

  it("survives a cycle in a value that holds no process", () => {
    const table = new ProcessTable("odd");
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;

    const encoded = encodeProcessRefs(loop, table) as Record<string, unknown>;
    expect(encoded.name).toBe("loop");
  });
});

describe("decodeProcessRefs", () => {
  it("turns a reference into what the side makes of it: a handle", () => {
    const decoded = decodeProcessRefs({ $p: { id: 7, pname: "tools:kid" } }, makeHandle);

    expect(isRemoteProcess(decoded)).toBe(true);
    expect((decoded as RemoteProcess).pname).toBe("tools:kid");
    expect((decoded as RemoteProcess).ref.id).toBe(7);
    expect((decoded as RemoteProcess).isConnected()).toBe(true);
  });

  it("finds references inside what came with them", () => {
    const decoded = decodeProcessRefs(
      {
        found: { $p: { id: 1, pname: "a" } },
        rest: [1, { $p: { id: 2, pname: "b" } }],
      },
      makeHandle,
    ) as { found: RemoteProcess; rest: [number, RemoteProcess] };

    expect(isRemoteProcess(decoded.found)).toBe(true);
    expect(isRemoteProcess(decoded.rest[1])).toBe(true);
    expect(decoded.rest[1].pname).toBe("b");
  });

  it("leaves anything that is not a reference as it was", () => {
    const asked: ProcessRef[] = [];
    const askedFor = (ref: ProcessRef) => {
      asked.push(ref);
      return makeHandle(ref);
    };

    expect(decodeProcessRefs({ $p: { pname: "no id" } }, askedFor)).toEqual({ $p: { pname: "no id" } });
    expect(decodeProcessRefs({ $p: "not an object" }, askedFor)).toEqual({ $p: "not an object" });
    expect(asked).toEqual([]);
    expect(asProcessRef({ $p: { id: 1, pname: "a" } })).toEqual({ id: 1, pname: "a" });
    expect(asProcessRef({ $p: { id: "1", pname: "a" } })).toBeNull();
  });
});
