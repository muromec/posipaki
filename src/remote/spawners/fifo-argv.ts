// ── FIFO payload spawner, from argv ───────────────────────────────────────
//
// The serving side of a payload someone else started: the two fifo paths and the host version arrive in argv.
// It checks the version, opens the pair as bytes, and lets the seam compose the frames over it.
//
// The check runs before anything is opened, because the reason is readable to the caller only while the
// payload has not connected yet.
import { jsonSeam } from "../seam.js";
import { fifoByteChannel } from "./fifo-port.js";
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

  // The medium carries octets, and the seam above says what a frame in them is: this side reads
  // `--fifo-out` and writes `--fifo-in`, opening its write end first.
  return jsonSeam(async () => fifoByteChannel(fifoOut, fifoIn, "served"))(undefined);
}
