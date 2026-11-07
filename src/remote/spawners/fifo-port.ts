// ── the fifo pair as a channel of bytes ────────────────────────────────────
//
// Two named pipes and nothing above them.  A medium knows how to carry octets and in which order to open
// them; what those octets mean — a line, a frame, which protocol — is composed on top by the seam, so this
// file has no frame in it at all.
//
// The open order is the medium's one piece of knowledge.  A read opened on a fifo nobody writes to yet is
// handed an immediate end-of-stream by some runtimes, which ends a connection that never carried a byte:
// the served side therefore opens its write end first, and the client its read end, exactly as the line
// transport does.

import { open } from "node:fs/promises";

import { streamChannel, type Channel } from "../../port/index.js";

/** Which end of the pair is opened first: the served side blocks on its write, the client on its read. */
export type FifoOpenOrder = "served" | "client";

/**
 * A pair as bytes.
 *
 * `readPath` is where this side reads and `writePath` where it writes; the client's swap of the two is the
 * caller's, since which of the pair it reads is the pair's own definition.
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
