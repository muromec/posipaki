// ── FIFO server spawner (argv) ─────────────────────────────────────────────
//
// Environment-specific: reads what the caller put in argv — the two named fifos, and the host
// version this artifact is being started for — checks that it *is* that build, connects, and
// returns a frame Channel with the $proto handshake already sent.
//
// The check comes first, before anything is opened: a payload that is not the build that was
// asked for has no business on a wire, and saying so before it connects is the only moment
// where the reason is still readable to the caller.

import { FifoUtf8NlineTransport } from "../transports/fifo.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import type { Channel } from "../channel.js";
import { PAYLOAD_REFUSED, hostVersionAccepts } from "../kit.js";

/** A `--flag=<value>` argument, or undefined. */
function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Serve one payload over the fifo pair in argv.
 *
 * `own` is the host version this artifact's bytes carry, when its build stamped one: given it,
 * the payload refuses to serve a host version that differs, and refuses a start that names
 * none.  Nothing stamped means nothing to check — and `--host-version`, if the caller sent one
 * anyway, is simply not ours to compare with.
 */
export async function fifoArgvSpawner(own?: string): Promise<Channel> {
  const verdict = hostVersionAccepts(own, flag("host-version"));
  if (!verdict.ok) {
    console.error(`payload: ${verdict.reason}`);
    process.exit(PAYLOAD_REFUSED);
  }

  const fifoIn = flag("fifo-in");
  const fifoOut = flag("fifo-out");
  if (!fifoIn || !fifoOut) {
    console.error("server: --fifo-in=<path> and --fifo-out=<path> required");
    process.exit(1);
  }

  const transport = await FifoUtf8NlineTransport.connect(fifoOut, fifoIn);
  const channel = json1Channel(transport);
  await channel.send({ $proto: VERSION });
  return channel;
}
