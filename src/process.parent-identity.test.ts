/* eslint-disable unicorn/consistent-function-scoping */
// ── parentId / parentName on ProcessCtx ───────────────────────────────────
//
// RED phase — tests expected to fail until parent identity is implemented.

import { describe, it, expect } from "vitest";
import { spawnAsync, runDispatchAsync, type AsyncProcess } from "./process.async.js";
import type { AsyncProcessFn, ProcessCtx, Message, WithSender, SenderInfo } from "./types.js";

type PokeM = { type: "POKE" };
type PongM = { type: "PONG" };

type SimpleState = {
  parentId: Symbol | null;
  parentName: string | null;
  messages: string[];
};

async function* baseLoop(ctx: ProcessCtx<null, unknown, Message, Message>) {
  let run = true;

  yield* runDispatchAsync<[Message, SenderInfo]>(
    ctx.pname,
    async function exitOnly([msg, from]) {
      if (msg.type === "STOP") {
        run = false;
      }
    },
    () => !run,
  );
  ctx.toParent({ type: "EXIT" });
}

const simple: AsyncProcessFn<null, SimpleState, Message, Message> = async function* simple(
  ctx,
  args,
) {
  const messages: string[] = [];
  yield {
    parentId: ctx.parentId,
    parentName: ctx.parentName,
    messages,
  };

  let run = true;

  yield* runDispatchAsync(
    ctx.pname,
    async function exitOnly([msg, from]) {
      if (msg.type === "STOP") {
        run = false;
      }
      if (msg.type === "POKE") {
        messages.push(from.fromId === ctx.parentId ? "from-parent" : "from-other");
      }
    },
    () => !run,
  );
  ctx.toParent({ type: "EXIT" });
};

const forking: AsyncProcessFn<null, SimpleState, Message, Message> = async function* forking(
  ctx,
  args,
) {
  ctx.fork(simple, "child")(null);
  yield* simple(ctx, args);
};

describe("parent identity on ProcessCtx", () => {
  it("root actor has null parentId and parentName", async () => {
    const proc = spawnAsync(simple, "root")(null);
    await proc.ready();

    expect(proc.state).not.toBeNull();
    expect(proc.state!.parentId).toBeNull();
    expect(proc.state!.parentName).toBeNull();

    await proc.stop();
  });

  it("forked child has parentId and parentName from parent", async () => {
    const proc = spawnAsync(forking, "parent")(null);
    await proc.ready();

    const childProc = proc.children[0] as unknown as AsyncProcess<
      null,
      SimpleState,
      Message,
      Message,
      {}
    >;

    expect(childProc.state).not.toBeNull();
    expect(childProc.state!.parentId).toBe(proc.id);
    expect(childProc.state!.parentName).toBe("parent");
  });

  it("child can identify parent messages via ctx.parentId", async () => {
    const poking: AsyncProcessFn<null, SimpleState, Message, Message> = async function* poking(
      ctx,
      args,
    ) {
      const c = ctx.fork(simple, "child")(null);
      c.send({ type: "POKE" } as PokeM, { fromName: ctx.pname, fromId: ctx.id });
      yield* simple(ctx, args);
    };

    const proc = spawnAsync(poking, "parent")(null);
    await proc.ready();

    const childProc = proc.children[0] as unknown as AsyncProcess<
      null,
      SimpleState,
      Message,
      Message,
      {}
    >;
    const { messages } = childProc.state!;

    await proc.stop();

    expect(messages).toContain("from-parent");
    expect(messages).not.toContain("from-other");
  });

  it("parent gets childProc.id and pname from fork return value", async () => {
    // Spawn a root, fork a child, verify the parent can get the child's id
    type ChildInfo = {
      childId: Symbol;
      childName: string;
    };

    const forkingId: AsyncProcessFn<null, ChildInfo, Message, Message> = async function* forkingId(
      ctx,
    ) {
      const c = ctx.fork(simple, "child")(null);
      yield { childId: c.id, childName: c.pname };
      yield* baseLoop(ctx);
    };

    const proc = spawnAsync(forkingId, "parent")(null);
    await proc.ready();
    expect(proc.state!.childId).toBeTruthy();
    expect(proc.state!.childId).toBe(proc.children[0].id);
    expect(proc.state!.childName).toBe("child");
  });
});
