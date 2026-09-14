// ── What a container environment is ────────────────────────────────────────
//
// One object describes the whole way in: which image, which container (named, or
// derived from the image), what to stage inside it, who owns the kit, and how the
// run is shaped.  The commands are built from it and nothing here talks to
// podman, so every shape is asserted without a container.

import type { KitApp } from "posipaki/remote/node";

/** A container reached with podman, and the kit run inside it. */
export interface PodmanSpec {
  /** The image the container is started from. */
  image: string;
  /**
   * The container to use, named by the consumer.  There is no default: a name
   * taken from the image would be a guess, and the name decides who else can be
   * in there, so guessing it is worse than not having one.
   */
  container: string;
  /** The kit's owner: the app name and its build version.  Names the kit directory. */
  app: KitApp;
  /** The payload bundle on this machine, as the consumer built it. */
  payload: string;
  /** The gateway bundle on this machine; required when `relay`. */
  gateway?: string;
  /**
   * Run the payload behind the gateway — a fifo inside the container — instead of
   * on the run's own stdin/stdout.  Needed when the payload may print without
   * corrupting the wire.
   */
  relay?: boolean;
  /** Runtime candidates inside the container, best first.  Defaults to `node`, `nodejs`, `bun`. */
  runtime?: string[];
  /** Where the kit lands in the container, relative to `$HOME`.  Defaults to `bin/posipaki`. */
  parent?: string;
}

/** A kit already in the container, and the runtime that will run it. */
export interface PodmanStaged {
  kitDir: string;
  runtime: string;
}

/** Something about the way in does not hold: a spec that cannot be staged, or a container that never came up. */
export class PodmanSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanSpecError";
  }
}
