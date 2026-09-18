// ── The container's life ───────────────────────────────────────────────────
//
// A container outlives the call that wanted it: it has to exist, stay up between
// calls, and be removable.  The policy is one sentence — the
// environment is a process-tree child of whoever holds it:
//
//   we start an *attached* `podman run` whose main process only reads its stdin;
//   while we live that read blocks, so `podman exec` can open as many channels as
//   we like; when we go, by any route, the write end closes, the reader sees EOF,
//   the main process exits, and `--rm` takes the container with it.
//
// So nothing has to remember to clean up.  What is left is what to do when the
// name is already taken by a container this process is not holding: kill it,
// replace it, reuse it, or refuse.

import { spawn } from "node:child_process";
import {
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
} from "./commands.js";
import { runHost } from "posipaki/remote/node";
import type { HostRun } from "posipaki/remote/node";
import { PodmanSpecError } from "./spec.js";
import type { ContainerSpec } from "./spec.js";

/** How long a container may take to appear before we call it failed. */
export const CONTAINER_START_MS = 30_000;

/** How often to ask whether it is there yet. */
const CONTAINER_POLL_MS = 50;

/** How long a stopped container's client gets to reap it before we kill it. */
const STOP_GRACE_MS = 5_000;

/**
 * How long a name that is still taken gets to be freed before a *reuse* gives up
 * on it: a container goes a moment after its holder does, not in the same instant.
 */
export const CONTAINER_REAP_MS = 2_000;

/** A container we started, held by the process that keeps it up. */
export interface ContainerHandle {
  name: string;
  /** True while the process holding the container up is still running. */
  alive(): boolean;
  /** Let go: the container's main process sees EOF, and `--rm` takes it away. */
  stop(): Promise<void>;
}

/** How a container is started.  Injectable, so no test ever runs podman. */
export type HostStart = (command: string[]) => Promise<ContainerHandle>;

/** The real thing: spawn it attached and keep the read end open by never writing. */
export const startHost: HostStart = (command) =>
  Promise.resolve().then(() => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
    // A podman that fails to start would otherwise be a silent promise: the probe
    // for the container says what happened, and this keeps the pipe errors quiet.
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    return {
      name: command[command.indexOf("--name") + 1] ?? "",
      alive: () => child.exitCode === null && child.signalCode === null,
      stop: () =>
        new Promise<void>((settle) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            settle();
            return;
          }
          // Let the main process see EOF first: `cat >/dev/null` returns, the
          // container stops, and the `podman run` client reaps it.  That is the
          // mechanism this policy is built on, so the kill is only a fallback, for a
          // client that will not die on its own — and the container goes a moment
          // after we do, not in the same instant.
          const grace = setTimeout(() => child.kill(), STOP_GRACE_MS);
          child.once("close", () => {
            clearTimeout(grace);
            settle();
          });
          child.stdin.end();
        }),
    };
  });

/**
 * What to do when the name is already taken by a container we are not holding.
 *
 * - `reuse` — somebody else (another process of ours, most likely) is holding it:
 *   run in theirs and let them keep the life.  Their death takes the container,
 *   and our channels with it, which is the deal for a name we did not start.
 * - `replace` — take the name: remove whatever is there and start our own.  For
 *   containers we assume we manage.
 * - `fail` — do not touch it.  The default, because it is the only one that never
 *   costs somebody else their container: a name is the consumer's to give, so a
 *   name that is taken is the consumer's question to answer.
 */
export type ConflictPolicy = "fail" | "reuse" | "replace";

/** What a start may ask for: three policies and three clocks. */
export interface ContainerLifeOptions {
  /** How host commands run — the probes and the removal.  Injectable. */
  runHost?: HostRun;
  /** How the container's own process is started.  Injectable. */
  startHost?: HostStart;
  /** What to do when the name is taken.  Defaults to `fail`. */
  onConflict?: ConflictPolicy;
  /** How long a container may take to appear.  Defaults to 30s. */
  startTimeoutMs?: number;
  /** How often to ask whether it is there yet.  Defaults to 50ms. */
  pollMs?: number;
  /** How long a reuse waits for a taken name to be freed.  Defaults to 2s. */
  reapMs?: number;
}

/** What a start did: a handle when we are holding it, and nothing when we are a guest. */
export interface ContainerStartResult {
  handle: ContainerHandle | null;
  /** How the name was taken when we arrived. */
  conflict: ConflictPolicy | null;
}

/** Is there a container by that name — whoever started it. */
export async function containerExists(container: string, run: HostRun = runHost): Promise<boolean> {
  return (await run(containerExistsCommand(container), "")).code === 0;
}

/** Wait for a name to be freed, or say it never was. */
async function waitGone(
  container: string,
  run: HostRun,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await containerExists(container, run))) return true;
    await new Promise((settle) => setTimeout(settle, pollMs));
  }
  return !(await containerExists(container, run));
}

/** Wait until the container answers, or say why it never did. */
async function waitForContainer(
  container: string,
  run: HostRun,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await containerExists(container, run)) return;
    await new Promise((settle) => setTimeout(settle, pollMs));
  }
  throw new PodmanSpecError(`container ${container} did not come up within ${timeoutMs}ms`);
}

/**
 * The container is there, or we start it and hold it.  A name that is taken is
 * handled by the policy — reused, replaced, or refused — and a container we do
 * not hold is not ours to stop, so the caller gets no handle for it.
 */
export async function startContainer(
  spec: ContainerSpec,
  options: ContainerLifeOptions = {},
): Promise<ContainerStartResult> {
  const run = options.runHost ?? runHost;
  const start = options.startHost ?? startHost;
  const pollMs = options.pollMs ?? CONTAINER_POLL_MS;
  const policy = options.onConflict ?? "fail";

  if (await containerExists(spec.container, run)) {
    if (policy === "fail") {
      throw new PodmanSpecError(
        `container ${spec.container} is already running, and is not ours to hold`,
      );
    }
    if (policy === "reuse") {
      // A container goes a moment after its holder, so give the name that moment
      // before deciding that somebody is really in there.
      if (!(await waitGone(spec.container, run, options.reapMs ?? CONTAINER_REAP_MS, pollMs))) {
        return { handle: null, conflict: "reuse" };
      }
    } else {
      await run(containerRemoveCommand(spec.container), "");
      await waitGone(spec.container, run, options.reapMs ?? CONTAINER_REAP_MS, pollMs);
    }
  }

  const handle = await start(containerKeepaliveCommand(spec));
  try {
    await waitForContainer(spec.container, run, options.startTimeoutMs ?? CONTAINER_START_MS, pollMs);
  } catch (err) {
    await handle.stop();
    throw err;
  }
  // The container answers, but our client is gone: the name was taken between the
  // probe and the start, so what answers is somebody else's container.
  if (!handle.alive()) {
    throw new PodmanSpecError(
      `container ${spec.container} came up without us: the name was taken while we started`,
    );
  }
  return { handle, conflict: null };
}

/** Let go of a container we hold. */
export async function stopContainer(handle: ContainerHandle): Promise<void> {
  await handle.stop();
}

/** Take down a container by name, whether or not we are holding it. */
export async function removeContainer(
  spec: ContainerSpec,
  options: ContainerLifeOptions = {},
): Promise<void> {
  await (options.runHost ?? runHost)(containerRemoveCommand(spec.container), "");
}
