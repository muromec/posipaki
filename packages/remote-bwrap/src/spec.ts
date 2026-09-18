// ── What a sandbox environment is ──────────────────────────────────────────
//
// One thing, and it is not the wire: a bubblewrap sandbox is a name and a list of
// arguments — there is no image to start from, because bwrap binds the machine we are
// already on — and those arguments are the caller's decision: they say what the payload
// may see and touch.  Everything else (the payload and the gateway, the kit they are
// staged in, the runtime that runs them, the fifo inside, the wire) is posipaki's, and
// this package never sees it.

import type { KitApp, RemoteSpec } from "posipaki/remote/node";

/** A sandbox, and the actor run in it: what a caller of this package has. */
export interface BwrapRemoteSpec<Args> extends Omit<RemoteSpec<Args>, "name" | "entry"> {
  /** The sandbox's name: errors and its own output are tagged with it.  Defaults to `bwrap`. */
  name?: string;
  /**
   * The bwrap arguments, as bwrap takes them: what is bound, what is unshared.  The
   * policy is yours — see `sandboxArgs` for the one that runs a payload and little else.
   */
  args: string[];
}

/** Staging failed, or the sandbox never spoke: nothing here is bwrap's own. */
export { RemoteSpecError as BwrapSpecError } from "posipaki/remote/node";

/**
 * Who a staged kit belongs to, re-exported where a caller of this package looks for it:
 * the app name and the build its bytes came from, which is what the gateway is told.
 */
export type { KitApp };
