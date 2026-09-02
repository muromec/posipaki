// ── Server-side adapter ─────────────────────────────────────────────────────
//
// Serves a posipaki actor over the remote-actor wire protocol. The seam's
// server side: `serveRemoteActor` runs an actor over an already-established
// transport (transport-agnostic). `runFifoServer` is the FIFO CLI entry point
// that discovers its named fifos from argv and serves over them.

import type { AsyncProcessFn, Message } from "../types.js";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isInit, isMsg, PROTO_VERSION } from "./protocol.js";
import { spawnAsync } from "../index.js";
import type { Transport } from "./transport.js";

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

export async function serveRemoteActor<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
>(fn: AsyncProcessFn<Args, State, InMsg, OutMsg>, transport: Transport): Promise<void> {
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

  // 3. Bridge actor output → transport
  proc.subscribe("message", async (msg, sender) => {
    try {
      await transport.send(encode("$msg", { fromName: sender.fromName, body: msg }));
    } catch {
      console.error("Error sending out the message");
    }
  });
  proc.subscribe("state", async () => {
    try {
      await transport.send(encode("$state", proc.state as Record<string, unknown>));
    } catch (e) {
      console.error("Error sending out the message", e);
    }
  });

  await proc.ready();

  await transport.send(encode("$state", proc.state as Record<string, unknown>));

  // 4. Bridge transport input → actor
  transport.onMessage((line) => {
    const msg = decode(line);
    if (isMsg(msg)) {
      const { fromName, body } = msg.$msg;
      proc.send(body as InMsg, makeSender(fromName, parentName, parentId));
    }
  });

  // 5. Await actor exit, then announce it and close
  let code = 0;
  try {
    await proc.wait();
  } catch (err) {
    console.error("server actor error:", err);
    code = 1;
  }
  await transport.send(encode("$exit", { code, state: proc.state }));
  await transport.close();
}

export async function runFifoServer<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
>(fn: AsyncProcessFn<Args, State, InMsg, OutMsg>): Promise<void> {
  const fifoIn = process.argv.find((a) => a.startsWith("--fifo-in="))?.slice("--fifo-in=".length);
  const fifoOut = process.argv
    .find((a) => a.startsWith("--fifo-out="))
    ?.slice("--fifo-out=".length);

  if (!fifoIn || !fifoOut) {
    console.error("server: --fifo-in=<path> and --fifo-out=<path> required");
    process.exit(1);
  }

  const transport = await FifoUtf8NlineTransport.connect(fifoOut, fifoIn);
  await serveRemoteActor(fn, transport);
}
