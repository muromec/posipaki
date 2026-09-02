// ── FIFO server spawner (argv) ─────────────────────────────────────────────
//
// Environment-specific: discovers the two named fifos from process argv,
// connects, and returns a frame Channel with the $proto handshake already sent.

import { FifoUtf8NlineTransport } from "../transports/fifo.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import type { Channel } from "../channel.js";

export async function fifoArgvSpawner(): Promise<Channel> {
  const fifoIn = process.argv.find((a) => a.startsWith("--fifo-in="))?.slice("--fifo-in=".length);
  const fifoOut = process.argv
    .find((a) => a.startsWith("--fifo-out="))
    ?.slice("--fifo-out=".length);

  if (!fifoIn || !fifoOut) {
    console.error("server: --fifo-in=<path> and --fifo-out=<path> required");
    process.exit(1);
  }

  const transport = await FifoUtf8NlineTransport.connect(fifoOut, fifoIn);
  const channel = json1Channel(transport);
  await channel.send({ $proto: VERSION });
  return channel;
}
