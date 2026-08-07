// ── Child-side adapter ─────────────────────────────────────────────────────
//
// Wraps a posipaki actor in a CLI process that speaks the wire protocol over
// a named fifo.  Usage:
//
//   if (isMain(import.meta.url)) {
//     runChild(MyActor.fn);
//   }

import type { AsyncProcessFn, Message } from "../types.js";
import { FifoTransport } from "./fifo.js";

/** Reconstruct sender identity from wire message. */
export function makeSender(
  fromName: string,
  parentName: string | null,
  parentId: symbol | null,
): { fromName: string; fromId: symbol } {
  if (parentId && fromName === parentName) {
    return { fromName, fromId: parentId };
  }
  return { fromName, fromId: Symbol() };
}
import { encode, decode, isInit, isMsg, PROTO_VERSION } from "./protocol.js";
import { spawnAsync } from "../index.js";

export async function runChild(
  fn: AsyncProcessFn<Record<string, unknown>, Record<string, unknown>, Message, Message>,
): Promise<void> {
  const fifoPath = process.argv
    .find((a) => a.startsWith("--fifo="))
    ?.slice("--fifo=".length);

  if (!fifoPath) {
    console.error("child: --fifo=<path> required");
    process.exit(1);
  }

  const transport = await FifoTransport.open(fifoPath, "writer");

  // 1. Send protocol version
  await transport.send(encode("$proto", PROTO_VERSION));

  // 2. Wait for $init
  const initMsg = await new Promise<Record<string, unknown>>((resolve) => {
    transport.onMessage((line) => {
      const msg = decode(line);
      if (isInit(msg)) resolve(msg.$init);
    });
  });

  const parentName = (initMsg.parentName as string) ?? null;
  const parentIdName = (initMsg.parentIdName as string) ?? null;
  const parentId = parentIdName ? Symbol.for(parentIdName) : null;

  // Remove parent fields from init args before passing to actor
  const { parentName: _pn, parentIdName: _pid, ...initArgs } = initMsg;

  // 3. Spawn the actor with a wrapped context that forwards emits to the wire
  // Wrap fn to inject parentId/parentName into ctx before the actor starts
  const wrappedFn: typeof fn = async function* (ctx, args) {
    (ctx as Record<string, unknown>).parentName = parentName;
    (ctx as Record<string, unknown>).parentId = parentId;
    return yield* fn(ctx, args);
  };

  const proc = spawnAsync(wrappedFn, "remote", (msgWithSender) => {
    const [msg, sender] = msgWithSender;
    transport.send(encode("$msg", { type: msg.type, fromName: sender.fromName, body: msg })).catch(() => {});
  })(initArgs);
  await proc.ready();

  // 4. Send initial state
  await transport.send(encode("$state", proc.state as Record<string, unknown>));

  // 5. Subscribe to state changes
  proc.subscribe(() => {
    transport.send(encode("$state", proc.state as Record<string, unknown>)).catch(() => {});
  });

  // 6. Forward incoming wire messages to the actor
  transport.onMessage((line) => {
    const msg = decode(line);
    if (isInit(msg)) return; // already handled
    if (isMsg(msg)) {
      const { fromName, body } = msg.$msg;
      proc.send(
        body as Message,
        { fromName, fromId: Symbol() },
      );
    }
  });

  // 7. On actor exit, send $exit
  const shutdown = async (code: number) => {
    await transport.send(encode("$exit", { code, state: proc.state }));
    transport.close();
    process.exit(code);
  };
  proc.wait().then(() => shutdown(0), (err) => {
    console.error("child actor error:", err);
    shutdown(1);
  });
}
