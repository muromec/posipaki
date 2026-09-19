// ── process references ─────────────────────────────────────────────────────
//
// A process cannot be written down, so an answer about one carries an id the
// connection handed out and the name the far side knows it by.  What is checked
// here is the accounting around those ids — one per process, never reused — and
// that the walk copies rather than edits what the actor returned.

import { describe, it, expect, afterEach } from "vitest";
import { defineActor } from "../index.js";
import type { AsyncProcess } from "../process.async.js";
import type { Message } from "../types.js";
import {
  PROCESS_REF,
  ProcessHandles,
  UnreachableRemoteProcess,
  asProcessRef,
  decodeProcessRefs,
  encodeProcessRefs,
} from "./process-ref.js";

type Spawned = AsyncProcess<unknown, unknown, Message, Message, {}>;

const spawned: Spawned[] = [];

async function makeProcess(name = "target"): Promise<Spawned> {
  const Actor = defineActor({ name, setup: () => ({}), handlers: {} });
  const proc = (await Actor.spawn({})) as unknown as Spawned;
  spawned.push(proc);
  return proc;
}

afterEach(async () => {
  for (const proc of spawned.splice(0)) await proc.stop();
});

describe("ProcessHandles", () => {
  it("hands out one id per process, and never the same id for two", async () => {
    const handles = new ProcessHandles();
    const first = await makeProcess("first");
    const second = await makeProcess("second");

    expect(handles.handleFor(first)).toBe(1);
    expect(handles.handleFor(first)).toBe(1);
    expect(handles.handleFor(second)).toBe(2);

    // No process is ever handed out id 0: that one means the remote root.
    expect(handles.handleFor(await makeProcess("third"))).toBe(3);
  });
});

describe("encodeProcessRefs", () => {
  it("writes a process as a reference, and leaves other values alone", async () => {
    const proc = await makeProcess("kid");
    const handles = new ProcessHandles();

    expect(encodeProcessRefs(proc, handles)).toEqual({
      [PROCESS_REF]: { id: 1, pname: "kid" },
    });
    expect(encodeProcessRefs({ count: 2, ok: true, missing: null }, handles)).toEqual({
      count: 2,
      ok: true,
      missing: null,
    });
  });

  it("walks objects and arrays, and writes the same id for the same process", async () => {
    const kid = await makeProcess("kid");
    const other = await makeProcess("other");
    const handles = new ProcessHandles();

    const encoded = encodeProcessRefs({ kids: [kid, { deep: other }], again: kid }, handles);
    expect(encoded).toEqual({
      kids: [{ [PROCESS_REF]: { id: 1, pname: "kid" } }, { deep: { [PROCESS_REF]: { id: 2, pname: "other" } } }],
      again: { [PROCESS_REF]: { id: 1, pname: "kid" } },
    });
  });

  it("copies the containers it walks: the actor's own objects are not rewritten", async () => {
    const proc = await makeProcess("kid");
    const handles = new ProcessHandles();
    const state = { child: proc };

    const encoded = encodeProcessRefs(state, handles);

    expect(encoded).not.toBe(state);
    expect(state.child).toBe(proc);
    expect(encoded).toEqual({ child: { [PROCESS_REF]: { id: 1, pname: "kid" } } });
  });

  it("survives a cycle in a value that holds no process", async () => {
    const handles = new ProcessHandles();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;

    const encoded = encodeProcessRefs(loop, handles) as Record<string, unknown>;
    expect(encoded.name).toBe("loop");
  });
});

describe("decodeProcessRefs", () => {
  it("turns a reference into a process this side cannot reach", () => {
    const decoded = decodeProcessRefs({ $p: { id: 7, pname: "tools:kid" } });

    expect(decoded).toBeInstanceOf(UnreachableRemoteProcess);
    expect((decoded as UnreachableRemoteProcess).id).toBe(7);
    expect((decoded as UnreachableRemoteProcess).pname).toBe("tools:kid");
  });

  it("finds references inside what came with them", () => {
    const decoded = decodeProcessRefs({
      found: { $p: { id: 1, pname: "a" } },
      rest: [1, { $p: { id: 2, pname: "b" } }],
    }) as { found: UnreachableRemoteProcess; rest: [number, UnreachableRemoteProcess] };

    expect(decoded.found).toBeInstanceOf(UnreachableRemoteProcess);
    expect(decoded.rest[1]).toBeInstanceOf(UnreachableRemoteProcess);
    expect(decoded.rest[1].pname).toBe("b");
  });

  it("leaves anything that is not a reference as it was", () => {
    expect(decodeProcessRefs({ $p: { pname: "no id" } })).toEqual({ $p: { pname: "no id" } });
    expect(decodeProcessRefs({ $p: "not an object" })).toEqual({ $p: "not an object" });
    expect(asProcessRef({ $p: { id: 1, pname: "a" } })).toEqual({ id: 1, pname: "a" });
    expect(asProcessRef({ $p: { id: "1", pname: "a" } })).toBeNull();
  });
});

describe("a reference going back", () => {
  it("is written as the same reference, with the far side's own id", async () => {
    const handles = new ProcessHandles();
    const ref = new UnreachableRemoteProcess({ id: 3, pname: "tools:kid" });

    // Not a process of mine, so my table has no say in it: the id travels back
    // as it came, because that is the id the far side knows it by.
    expect(encodeProcessRefs([ref], handles)).toEqual([
      { [PROCESS_REF]: { id: 3, pname: "tools:kid" } },
    ]);
    expect(handles.handleFor(await makeProcess("mine"))).toBe(1);
  });
});
