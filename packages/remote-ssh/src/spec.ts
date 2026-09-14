// ── What an ssh environment is ─────────────────────────────────────────────
//
// Two things, kept apart on purpose: a host that is reached, and an actor that
// is staged onto it.  A host is a name and nothing else — there is no image to
// start from and no container of ours to name, because the ssh process itself is
// the lifetime.  What runs on it is a command: one the host already has, or one a
// prepare step puts there.

import type { KitApp } from "posipaki/remote/node";

/** The host itself: whatever ssh accepts — `host`, `user@host`, an alias from `~/.ssh/config`. */
export interface SshHostSpec {
  /** Whatever ssh itself accepts: `host`, `user@host`, or an alias from `~/.ssh/config`. */
  host: string;
}

/** The actor that gets staged in: who owns the kit, and which bundles it has. */
export interface KitSpec {
  /** The kit's owner: the app name and its build version.  Names the kit directory. */
  app: KitApp;
  /** The payload bundle on this machine, as the consumer built it. */
  payload: string;
  /** The gateway bundle on this machine; required when `relay`. */
  gateway?: string;
  /**
   * Run the payload behind the gateway — a fifo inside the host — instead of on
   * the run's own stdin/stdout.  Needed when the host is reached as another uid,
   * or when the payload may print without corrupting the wire.
   */
  relay?: boolean;
  /** Runtime candidates inside the host, best first.  Defaults to `node`, `nodejs`, `bun`. */
  runtime?: string[];
  /** Where the kit lands on the host, relative to `$HOME`.  Defaults to `bin/posipaki`. */
  parent?: string;
}

/** A host, and the actor staged onto it: both together, which is what a consumer usually has. */
export type SshSpec = SshHostSpec & KitSpec;

/** A kit already on the host, and the runtime that will run it. */
export interface SshStaged {
  kitDir: string;
  runtime: string;
}

/** Something about the way in does not hold: a spec that cannot be staged, or a host that said no. */
export class SshSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshSpecError";
  }
}
