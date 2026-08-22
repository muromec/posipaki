/* eslint-disable unicorn/consistent-function-scoping */
// ── parentId / parentName on ProcessCtx ───────────────────────────────────
//
// RED phase — tests expected to fail until parent identity is implemented.

import { describe, it, expect } from "vitest";
import { spawnAsync, runDispatchAsync } from "./process.async.js";
import type { ProcessCtx, Message, WithSender } from "./types.js";

type PokeM = { type: "POKE" };
type PongM = { type: "PONG" };

type SimpleState = {
  parentId: Symbol | null,
  parentName: string | null,
  messages: string[],
}


async function* simple(
  ctx: ProcessCtx<null, SimpleState, Message, Message>,
) {
  const messages = [];
  yield {
    parentId: ctx.parentId,
    parentName: ctx.parentName,
    messages,
  };

  let run = true;


  async function exitOnly([msg, from]) {
    if (msg.type === 'STOP') {
      run = false;
    }
    if (msg.type === 'POKE') {
      messages.push(
        (from.fromId === ctx.parentId)
        ? 'from-parent'
        : 'from-other'
      );
    }
  }

  yield* runDispatchAsync(ctx.pname, exitOnly, () => !run);
  ctx.toParent({ type: 'EXIT'});
}

async function* forking(
  ctx: ProcessCtx<null, ParentInfo, PokeM, PongM>,
) {
  ctx.fork(simple, "child")(null);
  yield* simple(ctx);
}


describe("parent identity on ProcessCtx", () => {
  it("root actor has null parentId and parentName", async () => {
    const proc = spawnAsync(simple, "root")(null);
    await proc.ready();

    expect(proc.state).not.toBeNull();
    expect(proc.state.parentId).toBeNull();
    expect(proc.state.parentName).toBeNull();

    await proc.stop();
  });

  it("forked child has parentId and parentName from parent", async () => {

    const proc = spawnAsync(forking, "parent")(null);
    await proc.ready();

    const child = proc.children[0];
    expect(child.state).not.toBeNull();
    expect(child.state.parentId).toBe(proc.id);
    expect(child.state.parentName).toBe("parent");
  });

  it("child can identify parent messages via ctx.parentId", async () => {
    async function* poking(
      ctx: ProcessCtx<null, null, Message, Message>,
    ) {
      const c = ctx.fork(simple, "child")(null);
      c.send({ type: "POKE" } as PokeM, { fromName: ctx.pname, fromId: ctx.id });
      yield* simple(ctx);
    }

    const proc = spawnAsync(poking, "parent")(null);
    await proc.ready();

    const { messages } = proc.children[0].state

    await proc.stop();

    expect(messages).toContain("from-parent");
    expect(messages).not.toContain("from-other");
  });

  it("parent gets childProc.id and pname from fork return value", async () => {
    // Spawn a root, fork a child, verify the parent can get the child's id
    type ChildInfo = {
      childId: Symbol,
      childName: string,
    }

    async function* forkingId(
      ctx: ProcessCtx<null, null, PokeM, PongM>,
    ) {
      const c = ctx.fork(simple, "child")(null);
      yield { childId: c.id, childName: c.pname };
      yield* simple(ctx);
    }

    const proc = spawnAsync(forkingId, "parent")(null);
    await proc.ready();
    expect(proc.state.childId).toBeTruthy();
    expect(proc.state.childId).toBe(proc.children[0].id);
    expect(proc.state.childName).toBe('child');

  });
});
