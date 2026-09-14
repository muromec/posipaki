// ── What a container environment is ────────────────────────────────────────
//
// Two things, kept apart on purpose: a container that exists, and an actor that
// runs inside one.  A container is an image and a name — and the name is never
// derived, because it decides who else ends up in that container.  What runs
// inside is a command: either one the image already has, or one a prepare step
// puts there.

import type { KitApp } from "posipaki/remote/node";

/** The container itself: the image to start from, and what to call it. */
export interface ContainerSpec {
  /** The image the container is started from. */
  image: string;
  /**
   * The container's name, given by the consumer.  There is no default: a name
   * taken from the image would be a guess, and a name is what decides who else
   * can be in there.
   */
  container: string;
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

/** Something about a container does not hold: a spec that cannot be staged, or one that never came up. */
export class PodmanSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanSpecError";
  }
}
