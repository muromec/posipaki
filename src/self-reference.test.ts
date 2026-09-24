// ── ctx.self: the process as a reference others can be given ─────────────────
//
// A process is reachable because somebody holds it; a name and a symbol are provenance, not
// an address.  `ctx.self` — `this.self` for an actor — is the handle itself, so a process
// can say "here I am" and whoever receives it can send back, read as that process and not
// as the recipient talking to itself.

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "./define-actor.js";
import type { SpawnedFrom } from "./actor-types.js";
import { runDispatchAsync, spawnAsync, isProcess } from "./process.async.js";
import type { AsyncProcessFn, Message, SenderInfo } from "./types.js";

/**
 * What a process that was handed a reference does with it: send to it, and say who it is.
 * A reference that crosses between processes is declared by what the receiver needs of it —
 * the shape of the process on the other end is not the receiver's to name.
 */
interface Handed {
  pname: string;
  id: symbol;
  send(msg: Message, from?: SenderInfo): void;
}

/** A promise and the one call that settles it, for tests that wait on a message. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("ctx.self", () => {
  it("is the process the actor runs as, not a copy of its identity", async () => {
    const looked = gate();
    let owner: SpawnedFrom<ReturnType<typeof makeProbe>> | null = null;
    let seen:
      | { pname: string; id: symbol; isProcess: boolean; sameCtx: boolean; sameProcess: boolean }
      | null = null;

    function makeProbe() {
      return defineActor({
        name: "probe",
        inMessages: defineMessages<{ type: "LOOK" }>(),
        outMessages: defineMessages<{ type: "LOOKED" }>(),
        setup: () => ({ andThen: false as boolean }),
        handlers: {
          LOOK() {
            // Compiled, never run: a handle typed as the actor's own process takes the
            // actor's own messages, and nothing else.
            if (this.state.andThen) {
              this.self.send({ type: "LOOK" });
              // @ts-expect-error — a message this actor does not take is not one its handle takes
              this.self.send({ type: "NOT_A_THING" });
            }
            seen = {
              pname: this.self.pname,
              id: this.self.id,
              isProcess: isProcess(this.self),
              sameCtx: this.self === this.ctx.self,
              sameProcess: this.self === owner,
            };
            looked.open();
          },
        },
      });
    }

    const Probe = makeProbe();
    const proc = await Probe.spawn({});
    owner = proc;
    await proc.ready();
    proc.send({ type: "LOOK" });
    await looked.promise;

    expect(seen).not.toBeNull();
    expect(seen!.isProcess).toBe(true);
    expect(seen!.pname).toBe(proc.pname);
    expect(seen!.id).toBe(proc.id);
    expect(seen!.sameCtx).toBe(true);
    // The process's own handle is the object a spawner got back, not a stand-in for it.
    expect(seen!.sameProcess).toBe(true);
    await proc.stop();
  });

  it("lets a process hand itself to another, and the holder send through it", async () => {
    const called = gate();
    const heard: Array<{ body: Message; from: SenderInfo }> = [];

    const Caller = defineActor({
      name: "caller",
      inMessages: defineMessages<{ type: "GO" }>(),
      outMessages: defineMessages<{ type: "CALLED" }>(),
      setup: (args: { peer: Handed }) => ({ peer: args.peer }),
      handlers: {
        GO() {
          this.state.peer.send({ type: "CALLED" }, { fromName: this.name, fromId: this.id });
        },
      },
    });

    const Owner = defineActor({
      name: "owner",
      inMessages: defineMessages<{ type: "CALLED" }>(),
      outMessages: defineMessages<{ type: "NONE" }>(),
      async setup() {
        // The owner's own handle, given away — the only way a process that is not its
        // parent can reach it.  No cast: a reference is assignable to what the receiver
        // needs of it.
        await Caller.spawnAsChild(this.ctx, { peer: this.self });
        return {};
      },
      handlers: {
        CALLED(body, from) {
          heard.push({ body, from });
          called.open();
        },
      },
    });

    const owner: SpawnedFrom<typeof Owner> = await Owner.spawn({});
    const caller = owner.children[0]!;
    await owner.ready();

    caller.send({ type: "GO" });
    await called.promise;

    expect(heard).toHaveLength(1);
    expect(heard[0]!.body).toEqual({ type: "CALLED" });
    // The recipient is the one that was handed over, and the sender is the caller — not
    // the owner, which is what a message injected through `sendSelf` would look like.
    expect(heard[0]!.from.fromName).toBe(caller.pname);
    expect(heard[0]!.from.fromId).toBe(caller.id);
    expect(heard[0]!.from.fromId).not.toBe(owner.id);

    await owner.stop();
  });

  it("is on a plain process's ctx too, and addresses it", async () => {
    const poked = gate();
    let selfRef: unknown = null;
    let got: Message | null = null;
    let stop = false;

    const fn: AsyncProcessFn<null, { n: number }, Message, Message> = async function* plain(ctx) {
      selfRef = ctx.self;
      yield { n: 0 };

      yield* runDispatchAsync<[Message, SenderInfo]>(
        ctx.pname,
        async ([msg]) => {
          got = msg;
          stop = true;
          poked.open();
        },
        () => stop,
      );
      ctx.toParent({ type: "EXIT" });
    };

    const proc = spawnAsync(fn, "plain")(null);
    await proc.ready();

    expect(isProcess(selfRef)).toBe(true);
    expect(selfRef).toBe(proc);
    expect(proc.state).toEqual({ n: 0 });

    proc.send({ type: "POKE" }, { fromName: "tester", fromId: Symbol("tester") });
    await poked.promise;
    expect(got).toEqual({ type: "POKE" });
    await proc.stop();
  });
});
