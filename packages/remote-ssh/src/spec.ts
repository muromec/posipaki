// ── What an ssh environment is ─────────────────────────────────────────────
//
// One object describes the whole way in: which host, what to stage on it, who
// owns the kit, and how the run is shaped.  The commands are built from it and
// nothing here talks to a host, so every shape is asserted without ssh.

import type { KitApp } from "posipaki/remote/node";

/** A host reached over ssh, and the kit run on it. */
export interface SshSpec {
  /** Whatever ssh itself accepts: `host`, `user@host`, or an alias from `~/.ssh/config`. */
  host: string;
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
