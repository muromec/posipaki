// ── What a container environment is ────────────────────────────────────────
//
// Two things, kept apart on purpose: a container that exists, and an actor that runs inside
// it.  A container is an image and a name — and the name is never derived, because it
// decides who else ends up in there.  What happens inside is posipaki's: the payload and
// the gateway, the kit they are staged in, the runtime that runs them, the fifo between
// them, and the wire over the exec.

import type { KitApp, RemoteSpec } from "posipaki/remote/node";

/** The container itself: the image to start from, and what to call it. */
export interface ContainerSpec {
  /** The image the container is started from. */
  image: string;
  /**
   * The container's name, given by the consumer.  There is no default: a name taken from
   * the image would be a guess, and a name is what decides who else can be in there.
   */
  container: string;
}

/** A container, and the actor run in it: what a caller of this package has. */
export interface PodmanRemoteSpec<Args>
  extends Omit<RemoteSpec<Args>, "name" | "entry">,
    ContainerSpec {
  /** What the far end's output and errors are tagged with.  Defaults to the container's name. */
  name?: string;
}

/** Staging failed, or the container never spoke: nothing here is podman's own. */
export { RemoteSpecError as PodmanSpecError } from "posipaki/remote/node";

/** Who a staged kit belongs to, re-exported where a caller of this package looks for it. */
export type { KitApp };
