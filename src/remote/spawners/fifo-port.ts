// ── the fifo pair as a channel of bytes ────────────────────────────────────
//
// Opens a pair of named pipes and hands back a channel of raw octets.  Nothing here decodes a line or knows a
// frame type: the seam composes those above it.
//
// The open order is the one thing this file has to get right.  A read opened on a fifo that has no writer yet is
// handed an immediate end-of-stream by some runtimes, and that ends a connection which never carried a byte.
// The served side therefore opens its write end first, and the client its read end.
// `FifoUtf8NlineTransport` does the same.

import { open } from "node:fs/promises";

import { streamChannel, type Channel } from "../../port/index.js";

/** Which end of the pair is opened first: the served side blocks on its write, the client on its read. */
export type FifoOpenOrder = "served" | "client";

/**
 * A pair as a channel of bytes.
 *
 * `readPath` is read here and `writePath` is written here — the pair as this side sees it, so the client
 * passes them swapped.  `order` decides which open is waited for first.
 */
export async function fifoByteChannel(
  readPath: string,
  writePath: string,
  order: FifoOpenOrder,
): Promise<Channel<Uint8Array>> {
  const readOpen = open(readPath, "r");
  if (order === "served") {
    const writeFd = await open(writePath, "w");
    const readFd = await readOpen;
    return streamChannel({ read: readFd.createReadStream(), write: writeFd.createWriteStream({}) });
  }
  const readFd = await readOpen;
  const writeFd = await open(writePath, "w");
  return streamChannel({ read: readFd.createReadStream(), write: writeFd.createWriteStream({}) });
}
