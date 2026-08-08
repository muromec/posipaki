// ── Child-side adapter ─────────────────────────────────────────────────────
//
// Wraps a posipaki actor in a CLI process that speaks the wire protocol over
// two unidirectional named fifos.

import type { AsyncProcessFn, Message } from "../types.js";
import { FifoUtf8NlineTransport } from "./fifo.js";

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
  const fifoIn = process.argv
    .find((a) => a.startsWith("--fifo-in="))
    ?.slice("--fifo-in=".length);
  const fifoOut = process.argv
    .find((a) => a.startsWith("--fifo-out="))
    ?.slice("--fifo-out=".length);

  if (!fifoIn || !fifoOut) {
    console.error("child: --fifo-in=<path> and --fifo-out=<path> required");
    process.exit(1);
  }

  const transport = await FifoUtf8NlineTransport.connect(fifoOut, fifoIn);

  // 1. Send protocol version
  await transport.send(encode("$proto", PROTO_VERSION));

  // 2. Wait for $init
  const initMsg = await new Promise<Record<string, unknown>>((resolve) => {
    transport.onMessage((line) => {
      const msg = decode(line);
      if (isInit(msg)) resolve(msg.$init);
    });
  });
  transport.removeHandler();

  const parentName = (initMsg.parentName as string) ?? null;
  const parentIdName = (initMsg.parentIdName as string) ?? null;
  const parentId = parentIdName ? Symbol.for(parentIdName) : null;
  const { parentName: _pn, parentIdName: _pid, ...initArgs } = initMsg;

  // 3. Spawn the actor
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

  // 6. Forward incoming messages to the actor
  transport.onMessage((line) => {
    const msg = decode(line);
    if (isMsg(msg)) {
      const { fromName, body } = msg.$msg;
      proc.send(body as Message, { fromName, fromId: Symbol() });
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
