// ── parentId / parentName on ProcessCtx ───────────────────────────────────
//
// RED phase — tests expected to fail until parent identity is implemented.

import { describe, it, expect } from "bun:test";
import { spawnAsync, runDispatchAsync } from "./process.async.js";
import type { ProcessCtx, Message, WithSender } from "./types.js";

type PokeM = { type: "POKE" };
type PongM = { type: "PONG" };

describe("parent identity on ProcessCtx", () => {
  it("root actor has null parentId and parentName", async () => {
    let capturedCtx: ProcessCtx<null, null, PokeM, PongM> | null = null;

    async function* root(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      capturedCtx = ctx;
      yield null;
      yield* runDispatchAsync(ctx.pname, async () => {});
    }

    const proc = spawnAsync(root, "root")(null);
    await proc.ready();

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.parentId).toBeNull();
    expect(capturedCtx!.parentName).toBeNull();
  });

  it("forked child has parentId and parentName from parent", async () => {
    let childCtx: ProcessCtx<null, null, PokeM, PongM> | null = null;

    async function* child(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      childCtx = ctx;
      yield null;
      yield* runDispatchAsync(ctx.pname, async () => {});
    }

    async function* parent(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      ctx.fork(child, "child")(null);
      yield null;
      yield* runDispatchAsync(ctx.pname, async () => {});
    }

    const proc = spawnAsync(parent, "parent")(null);
    await proc.ready();

    expect(childCtx).not.toBeNull();
    expect(childCtx!.parentId).toBe(proc.id);
    expect(childCtx!.parentName).toBe("parent");
  });

  it("child can identify parent messages via ctx.parentId", async () => {
    const messages: string[] = [];

    async function* child(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      yield null;
      yield* runDispatchAsync(ctx.pname, async ([msg, sender]: WithSender<PokeM>) => {
        if (sender.fromId === ctx.parentId) {
          messages.push("from-parent");
        } else {
          messages.push("from-other");
        }
      });
    }

    async function* parent(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      const c = ctx.fork(child, "child")(null);
      yield null;
      // Send message to child from parent
      ctx.sendSelf({ type: "POKE" } as PokeM);
      // Wait a tick then forward
      await new Promise((r) => setTimeout(r, 50));
      c.send({ type: "POKE" } as PokeM, { fromName: ctx.pname, fromId: ctx.id });
      await new Promise((r) => setTimeout(r, 50));
    }

    const proc = spawnAsync(parent, "parent")(null);
    await proc.ready();
    await proc.wait();

    expect(messages).toContain("from-parent");
    expect(messages).not.toContain("from-other");
  });

  it("parent can identify child messages via childProc.id", async () => {
    const messages: string[] = [];

    async function* child(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      yield null;
      // Send a message to parent
      ctx.toParent({ type: "PONG" } as PongM);
      yield* runDispatchAsync(ctx.pname, async () => {});
    }

    async function* parent(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      const c = ctx.fork(child, "child")(null);
      yield null;
      yield* runDispatchAsync(ctx.pname, async ([msg, sender]: WithSender<PongM>) => {
        if (sender.fromId === c.id) {
          messages.push("from-child");
        } else {
          messages.push("from-other");
        }
      });
    }

    const proc = spawnAsync(parent, "parent")(null);
    await proc.ready();
    await proc.wait();

    expect(messages).toContain("from-child");
    expect(messages).not.toContain("from-other");
  });
});
