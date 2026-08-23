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

export async function runChild<Args, State, InMsg extends Message, OutMsg extends Message>(
  fn: AsyncProcessFn<Args, State, InMsg, OutMsg>,
): Promise<void> {
  const fifoIn = process.argv.find((a) => a.startsWith("--fifo-in="))?.slice("--fifo-in=".length);
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

  const wrappedFn: typeof fn = async function* (ctx, args) {
    (ctx as Record<string, unknown>).parentName = parentName;
    (ctx as Record<string, unknown>).parentId = parentId;
    return yield* fn(ctx, args);
  };

  const proc = spawnAsync(wrappedFn, "remote")(initArgs as unknown as Args);
  proc.subscribe("message", async (msg, sender) => {
    try {
      const encodedMsg = encode("$msg", {
        fromName: sender.fromName,
        body: msg,
      });
      await transport.send(encodedMsg);
    } catch (e) {
      console.error("Error sending out the message");
    }
  });

  proc.subscribe("state", async () => {
    try {
      const encodedState = encode("$state", proc.state as Record<string, unknown>);
      await transport.send(encodedState);
    } catch (e) {
      console.error("Error sending out the message", e);
    }
  });

  await proc.ready();

  await transport.send(encode("$state", proc.state as Record<string, unknown>));

  // 6. Forward incoming messages to the actor
  transport.onMessage((line) => {
    const msg = decode(line);
    if (isMsg(msg)) {
      const { fromName, body } = msg.$msg;
      proc.send(body as InMsg, { fromName, fromId: Symbol() });
    }
  });

  // 7. On actor exit, send $exit
  const shutdown = async (code: number) => {
    await transport.send(encode("$exit", { code, state: proc.state }));
    await transport.close();
    process.exit(code);
  };
  proc.wait().then(
    () => shutdown(0),
    (err: unknown) => {
      console.error("child actor error:", err);
      shutdown(1);
    },
  );
}
