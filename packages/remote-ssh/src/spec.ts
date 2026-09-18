// ── What an ssh environment is ─────────────────────────────────────────────
//
// One string — whatever ssh itself accepts — and nothing else.  A host is a name: there is
// no image to start from and no container of ours to name, because the ssh process *is* the
// lifetime, which is why this package has no environment of its own to hold or clean up.
//
// Everything that happens on the other side is posipaki's: the payload and the gateway, the
// kit they are staged in, the runtime that runs them, the fifo inside, and the wire.

import type { KitApp, RemoteSpec } from "posipaki/remote/node";

/** A host, and the actor staged onto it: what a caller of this package has. */
export interface SshRemoteSpec<Args> extends Omit<RemoteSpec<Args>, "name" | "entry"> {
  /** Whatever ssh itself accepts: `host`, `user@host`, or an alias from `~/.ssh/config`. */
  host: string;
  /** What the far end's output and errors are tagged with.  Defaults to the host itself. */
  name?: string;
}

/** Staging failed, or the host never spoke: nothing here is ssh's own. */
export { RemoteSpecError as SshSpecError } from "posipaki/remote/node";

/** Who a staged kit belongs to, re-exported where a caller of this package looks for it. */
export type { KitApp };
