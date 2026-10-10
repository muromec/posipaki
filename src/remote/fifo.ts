// ── a fifo pair, as a listener and as a client ─────────────────────────────
//
// Two named pipes are one connection: whoever reads one and writes the other is talking to the side that
// did the opposite.  The medium gives one client per lifetime, so the listener takes one connection and is
// done, and the pair itself is made idempotently and never removed from under a client's feet.

import { execFile } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { ClientSpawner } from "./client.js";
import { isProto } from "./channel.js";
import { json1Channel, VERSION } from "./protocols/json1.js";
import type { Connection, Listener } from "./reactor.js";
import { FifoUtf8NlineTransport } from "./transports/fifo.js";

const runMkfifo = promisify(execFile);

/**
 * The pair, named as the serving side sees it: `read` is where it reads, and `write` where it writes.  The
 * client side passes the same pair and swaps them, which is what makes it a pair rather than two paths.
 */
export interface FifoPair {
  readonly read: string;
  readonly write: string;
}

export interface FifoListenerOptions<Meta = unknown> {
  /** Make the pair when it is missing, and refuse a path that exists and is not a fifo.  Default true. */
  make?: boolean;
  /** Admission and identity: what this returns is the connection's meta. */
  identify?(pair: FifoPair): Meta | Promise<Meta>;
}

/** What is at a path: nothing, a fifo, or something else. */
async function atPath(path: string): Promise<"missing" | "fifo" | "other"> {
  try {
    const info = await stat(path);
    return info.isFIFO() ? "fifo" : "other";
  } catch {
    return "missing";
  }
}

/**
 * Make the pair unless it is already there.  A fifo is a file and one pair serves every connection, so
 * nothing is recreated; something that is not a fifo where the pair goes is refused rather than worked
 * around, because a regular file read as input is a silence nobody can explain.
 */
export async function makeFifoPair(pair: FifoPair): Promise<void> {
  await mkdir(dirname(pair.read), { recursive: true });
  await mkdir(dirname(pair.write), { recursive: true });
  for (const path of [pair.read, pair.write]) {
    const there = await atPath(path);
    if (there === "fifo") continue;
    if (there === "other") throw new Error(`makeFifoPair: ${path} is not a fifo`);
    await runMkfifo("mkfifo", ["-m", "0600", path]);
  }
}

/**
 * Listen on a pair, as the served side: it reads `pair.read` and writes `pair.write`, and it opens the
 * write end first.  That order is the handshake: a stream opened for reading on a fifo nobody writes to is
 * handed an immediate end-of-stream by some runtimes, which closes a connection that never carried a byte.
 */
export async function fifoListener<Meta = unknown>(
  pair: FifoPair,
  options: FifoListenerOptions<Meta> = {},
): Promise<Listener<Meta>> {
  if (options.make ?? true) await makeFifoPair(pair);

  let taken = false;
  let closed = false;
  let parked: (() => Promise<void>) | null = null;
  let settled: Promise<void> = Promise.resolve();
  let release: { close: () => Promise<void> } | null = null;

  const unblock = async (): Promise<void> => {
    // The parked open is a writer waiting for a reader on `write`; reading it here is what releases it,
    // and a writer on `read` is what releases the read it opens next.  Both are held until it is through.
    const reader = await open(pair.write, "r");
    const writer = await open(pair.read, "w");
    release = {
      close: async () => {
        await writer.close();
        await reader.close();
      },
    };
  };
  return {
    async accept(): Promise<Connection<Meta>> {
      if (taken) throw new Error("fifoListener: the pair carries one connection per lifetime");
      if (closed) throw new Error("fifoListener: closed");
      taken = true;
      parked = unblock;

      let through: () => void = () => {};
      settled = new Promise<void>((resolve) => {
        through = resolve;
      });
      try {
        const transport = await FifoUtf8NlineTransport.connect(pair.read, pair.write);
        parked = null;
        if (closed) {
          // The release is what let this open through, and the listener is over: the connection it made is
          // closed rather than served.
          await transport.close();
          throw new Error("fifoListener: closed while waiting for a connection");
        }
        const meta = options.identify ? await options.identify(pair) : (undefined as Meta);
        return { meta, transport };
      } finally {
        through();
      }
    },
    async close(): Promise<void> {
      closed = true;
      // Release a wait parked on the pair, let the accept finish either way, and only then let go of the
      // handles that released it: they are what the parked open was waiting for.
      if (parked) await parked();
      await settled;
      await release?.close();
    },
  };
}

/**
 * Connect to a pair, as the client side: it reads what the listener writes and writes what it reads,
 * and it awaits the `$proto` frame, which is the side of the handshake a served actor speaks.
 */
export function fifoClientSpawner<Args = unknown>(
  pair: FifoPair | ((args: Args) => FifoPair),
): ClientSpawner<Args> {
  return async (args) => {
    const served = typeof pair === "function" ? pair(args) : pair;
    // The swap: this side reads what the serving side writes.
    const { transport } = FifoUtf8NlineTransport.beginConnect(served.write, served.read);
    const channel = json1Channel(await transport);
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    });
    channel.removeHandler();
    if (!isProto(first) || first.$proto !== VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(first).slice(0, 50)}`);
    }
    return channel;
  };
}
