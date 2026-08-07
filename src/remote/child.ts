// ── Child-side adapter ─────────────────────────────────────────────────────
//
// Wraps a posipaki actor in a CLI process that speaks the wire protocol over
// a named fifo.  Usage:
//
//   if (isMain(import.meta.url)) {
//     runChild(MyActor.fn);
//   }

import { fileURLToPath } from "node:url";
import type { AsyncProcessFn, Message } from "../types.js";
import { FifoTransport } from "./fifo.js";
import {
  encodeProto,
  encodeState,
  encodeMsg,
  encodeExit,
  decode,
  isInit,
  isMsg,
} from "./protocol.js";
import { spawnAsync } from "../index.js";

export function isMain(url: string): boolean {
  return process.argv[1] === fileURLToPath(url);
}

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
  await transport.send(encodeProto());

  // 2. Wait for $init
  const initArgs = await new Promise<Record<string, unknown>>((resolve) => {
    transport.onMessage((line) => {
      const msg = decode(line);
      if (isInit(msg)) resolve(msg.$init);
    });
  });

  // 3. Spawn the actor with a wrapped context that forwards emits to the wire
  const proc = spawnAsync(fn, "remote", (msgWithSender) => {
    const [msg, sender] = msgWithSender;
    transport.send(encodeMsg(msg.type, sender.fromName, undefined, msg)).catch(() => {});
  })(initArgs);
  await proc.ready();

  // 4. Send initial state
  await transport.send(encodeState(proc.state as Record<string, unknown>));

  // 5. Subscribe to state changes
  proc.subscribe(() => {
    transport.send(encodeState(proc.state as Record<string, unknown>)).catch(() => {});
  });

  // 6. Forward incoming wire messages to the actor
  transport.onMessage((line) => {
    const msg = decode(line);
    if (isInit(msg)) return; // already handled
    if (isMsg(msg)) {
      const { fromName, fromIdName: _fromIdName, body } = msg.$msg;
      proc.send(
        body as Message,
        { fromName, fromId: Symbol() },
      );
    }
  });

  // 7. On actor exit, send $exit
  proc.wait().then(
    (_reason) => {
      const code = 0;
      transport.send(encodeExit(code, proc.state)).catch(() => {});
      transport.close();
      setTimeout(() => process.exit(code), 100);
    },
    (err) => {
      console.error("child actor error:", err);
      transport.send(encodeExit(1, proc.state)).catch(() => {});
      transport.close();
      setTimeout(() => process.exit(1), 100);
    },
  );
}
