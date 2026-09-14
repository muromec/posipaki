// ── A container as an actor ────────────────────────────────────────────────
//
// A container is a resource with a life, so it gets a process of its own: the
// actor starts the container when it starts, holds it while it lives, and lets
// it go when it ends.  That is what makes one container shareable inside one
// agent without either consumer owning it — they retain this actor, and the
// count decides when the container goes.
//
// What it does *not* do is adopt: a name that is already held by a container
// this process did not start is somebody else's process, and their lifetime is
// not ours to own.  `onConflict` says what to do about that (see lifetime.ts) —
// by default, refuse and say so.

import { defineActor, defineMessages } from "posipaki";
import { containerExists, startContainer, stopContainer } from "./lifetime.js";
import type { ContainerHandle, ContainerLifeOptions } from "./lifetime.js";
import { PodmanSpecError } from "./spec.js";
import type { ContainerSpec } from "./spec.js";

/** What the actor is spawned with: the container, and how to treat a taken name. */
export interface ContainerActorArgs extends ContainerLifeOptions {
  /** The image the container is started from. */
  image: string;
  /** The container's name, given by the consumer. */
  container: string;
  /** How often to look at whether the container is still there.  Defaults to 500ms. */
  watchMs?: number;
}

export type ContainerIn = { type: "RETAIN" } | { type: "RELEASE" } | { type: "STATUS" };

export type ContainerOut =
  | { type: "UP"; container: string; ours: boolean }
  | { type: "FAILED"; container: string; reason: string }
  | { type: "RETAINED"; container: string; consumers: number }
  | { type: "RELEASED"; container: string; consumers: number }
  | { type: "STOPPED"; container: string }
  | { type: "GONE"; container: string }
  | { type: "STATUS"; container: string; ours: boolean; up: boolean; consumers: number };

/** How often the actor looks at whether its container is still there. */
const WATCH_MS = 500;

interface ContainerActorState {
  spec: ContainerSpec;
  options: ContainerLifeOptions;
  watchMs: number;
  /** The handle when we hold it, `null` when we are only a guest in it. */
  handle: ContainerHandle | null;
  consumers: number;
  watcher: ReturnType<typeof setInterval> | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Let the container go, if it is ours to let go. */
async function letGo(handle: ContainerHandle | null, done: (stopped: boolean) => void): Promise<void> {
  if (!handle) {
    done(false);
    return;
  }
  await stopContainer(handle);
  done(true);
}

/**
 * The container, as a process: `UP` once it is there (with `ours` saying whether
 * we are holding it), `GONE` when it disappears under us, and the consumer count
 * in between.  The last release lets it go; so does an end, however it comes.
 */
export const containerActor = defineActor({
  name: "container",
  inMessages: defineMessages<ContainerIn>(),
  outMessages: defineMessages<ContainerOut>(),
  setup: (args: ContainerActorArgs): ContainerActorState => ({
    spec: { image: args.image, container: args.container },
    options: args,
    watchMs: args.watchMs ?? WATCH_MS,
    handle: null,
    consumers: 0,
    watcher: null,
  }),
  afterStart: async function () {
    const name = this.state.spec.container;
    try {
      const { handle } = await startContainer(this.state.spec, this.state.options);
      this.state.handle = handle;
      this.emit({ type: "UP", container: name, ours: handle !== null });
    } catch (err) {
      this.emit({ type: "FAILED", container: name, reason: errorText(err) });
      this.exit(errorText(err));
      return;
    }
    const watch = async () => {
      const handle = this.state.handle;
      const up = handle
        ? handle.alive()
        : await containerExists(this.state.spec.container, this.state.options.runHost);
      if (up) return;
      this.emit({ type: "GONE", container: name });
      this.exit("the container is gone");
    };
    this.state.watcher = setInterval(() => {
      void watch();
    }, this.state.watchMs);
  },
  afterEnd: async function () {
    if (this.state.watcher) clearInterval(this.state.watcher);
    // An actor that goes takes its container with it: that is the whole point of
    // holding one.  A guest has nothing to let go of.
    await letGo(this.state.handle, () => {});
  },
  handlers: {
    RETAIN() {
      this.state.consumers += 1;
      this.emit({
        type: "RETAINED",
        container: this.state.spec.container,
        consumers: this.state.consumers,
      });
    },
    RELEASE() {
      if (this.state.consumers > 0) this.state.consumers -= 1;
      this.emit({
        type: "RELEASED",
        container: this.state.spec.container,
        consumers: this.state.consumers,
      });
      if (this.state.consumers > 0) return;
      const name = this.state.spec.container;
      // Let go of the handle first, so an end that follows does not stop it twice.
      const handle = this.state.handle;
      this.state.handle = null;
      void letGo(handle, (stopped) => {
        if (stopped) this.emit({ type: "STOPPED", container: name });
        this.exit("the last consumer left");
      });
    },
    STATUS() {
      const handle = this.state.handle;
      this.emit({
        type: "STATUS",
        container: this.state.spec.container,
        ours: handle !== null,
        up: handle ? handle.alive() : false,
        consumers: this.state.consumers,
      });
    },  },
});

/** Start a container and hold it, outside an actor.  Throws when the name is not ours to take. */
export async function holdContainer(
  spec: ContainerSpec,
  options: ContainerLifeOptions = {},
): Promise<ContainerHandle> {
  const { handle } = await startContainer(spec, options);
  if (!handle) {
    throw new PodmanSpecError(
      `container ${spec.container} is already running, and is not ours to hold`,
    );
  }
  return handle;
}
