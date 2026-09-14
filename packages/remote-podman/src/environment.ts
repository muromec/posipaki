// ── A container of its own for an actor ────────────────────────────────────
//
// The composite: the container actor above gives an actor the container its
// lifetime needs, and the connector runs it in there.  Started when the actor is
// spawned, let go when the actor is done — nothing left behind, and nothing
// shared: two actors that want one container ask the container actor for it.
//
// Reach for this when the container exists *for the actor*.  When it does not —
// a container the consumer keeps, or one that outlives several actors — use the
// container actor and the connector directly.

import type { Channel, ClientSpawner } from "posipaki/remote";
import { containerActor } from "./container.js";
import type { ContainerOut } from "./container.js";
import { podmanBootstrap } from "./bootstrap.js";
import type { PodmanBootstrapOptions } from "./bootstrap.js";
import type { ContainerLifeOptions } from "./lifetime.js";
import { PodmanSpecError } from "./spec.js";
import type { ContainerSpec, KitSpec } from "./spec.js";

/** Everything an environment takes: the container's life, the way in, and how closely the actor watches. */
export type PodmanEnvironmentOptions<Args> = PodmanBootstrapOptions<Args> &
  ContainerLifeOptions & {
    /** How often the container actor looks at whether the container is still there. */
    watchMs?: number;
  };

/** A promise that can be settled from the outside. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Start the container actor and wait until its container is up. */
async function holdContainer(
  spec: ContainerSpec,
  options: ContainerLifeOptions,
): Promise<{ release: () => void }> {
  const ready = deferred();
  const proc = await containerActor.spawn(
    { image: spec.image, container: spec.container, ...options },
    {
      name: spec.container,
      toParent: (msg: ContainerOut) => {
        if (msg.type === "UP") ready.resolve();
        if (msg.type === "FAILED") {
          ready.reject(
            new PodmanSpecError(`container ${spec.container} is not available: ${msg.reason}`),
          );
        }
      },
    },
  );
  await ready.promise;
  proc.send({ type: "RETAIN" });
  return {
    release: () => {
      proc.send({ type: "RELEASE" });
    },
  };
}

/**
 * Run an actor in a container of its own: the container is started for it and
 * let go when its channel is gone.  Each spawn gets its own container, so this
 * is not the shape for two actors sharing one.
 *
 * The container here exists for the actor, so it is one we assume we manage: a
 * name that is taken is taken over — what is there is killed and ours is started
 * (`onConflict: "replace"`).  An environment that must not do that says so.
 */
export function podmanEnvironment<Args>(
  spec: ContainerSpec & KitSpec,
  options: PodmanEnvironmentOptions<Args> = {},
): ClientSpawner<Args> {
  const { onConflict = "replace" } = options;
  return async (args: Args): Promise<Channel> => {
    const holder = await holdContainer(spec, { ...options, onConflict });
    const connect = podmanBootstrap<Args>(spec, {
      ...options,
      onGone: () => {
        options.onGone?.();
        holder.release();
      },
    });
    try {
      return await connect(args);
    } catch (err) {
      holder.release();
      throw err;
    }
  };
}
