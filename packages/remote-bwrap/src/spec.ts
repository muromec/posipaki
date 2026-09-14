// ── What a sandbox environment is ──────────────────────────────────────────
//
// Two things, kept apart on purpose: a sandbox that exists, and an actor that
// runs inside one.  A sandbox is a name and a set of bwrap arguments — there is
// no image to start from, because bwrap binds the machine we are already on —
// and the arguments are the consumer's decision: they say what the payload may
// see and touch.  What runs inside is a command: either one
// that is already there, or one a prepare step puts there.

import type { KitApp } from "posipaki/remote/node";

/** The sandbox itself: what it is called here, and the bwrap arguments that shape it. */
export interface SandboxSpec {
  /**
   * The sandbox's name, given by the consumer.  There is no default: it is what
   * errors are reported against and what the sandbox's own output is tagged with.
   */
  name: string;
  /**
   * The bwrap arguments, as bwrap takes them: what is bound, what is unshared.
   * The policy is yours — see sandbox.ts for the one that runs a payload and
   * nothing else, and for what it leaves exposed.
   */
  args: string[];
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
   * Run the payload behind the gateway — a fifo inside the sandbox — instead of
   * on the run's own stdin/stdout.  Needs `tmpfs` or something writable in the
   * policy: the fifo has to be created somewhere.
   */
  relay?: boolean;
  /** Runtime candidates inside the sandbox, best first.  Defaults to `node`, `nodejs`, `bun`. */
  runtime?: string[];
  /** Where the kit lands, relative to the sandbox's `$HOME`.  Defaults to `bin/posipaki`. */
  parent?: string;
}

/** A sandbox and the actor run in it: both together, which is what a consumer usually has. */
export type BwrapSpec = SandboxSpec & KitSpec;

/** A kit already on the machine, and the runtime that will run it. */
export interface BwrapStaged {
  kitDir: string;
  runtime: string;
}

/** Something about a sandbox does not hold: a spec that cannot be staged, or one that never spoke. */
export class BwrapSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BwrapSpecError";
  }
}
