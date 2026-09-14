// ── The container's life ───────────────────────────────────────────────────
//
// A container environment is not a process we spawn per call: it has to exist,
// stay up between calls, and be removable.  The policy is one sentence — the
// environment is a process-tree child of whoever holds it:
//
//   we start an *attached* `podman run` whose main process only reads its stdin;
//   while we live that read blocks, so `podman exec` can open as many channels as
//   we like; when we go, by any route, the write end closes, the reader sees EOF,
//   the main process exits, and `--rm` takes the container with it.
//
// So nothing has to remember to clean up — and a container that is already there
// (another persona's, or one we are re-entering) is left exactly as it is.

import { spawn } from "node:child_process";
import {
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
} from "./commands.js";
import { runHost } from "./host.js";
import type { HostRun } from "./host.js";
import { PodmanSpecError } from "./spec.js";
import type { PodmanSpec } from "./spec.js";
import { containerName } from "./spec.js";

/** How long a container may take to appear before we call it failed. */
export const CONTAINER_START_MS = 30_000;

/** How often to ask whether it is there yet. */
const CONTAINER_POLL_MS = 50;

/** How long a stopped container's client gets to reap it before we kill it. */
const STOP_GRACE_MS = 5_000;

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

/** Containers we started in this process, by name. */
const started = new Map<string, ContainerHandle>();

/** Let go of one container, whether or not we started it. */
export async function stopContainer(name: string): Promise<void> {
  const handle = started.get(name);
  if (!handle) return;
  started.delete(name);
  await handle.stop();
}

/** Take down a container we are not holding — a stale one from an older process. */
export async function removeContainer(spec: PodmanSpec, run: HostRun = runHost): Promise<void> {
  await stopContainer(containerName(spec));
  await run(containerRemoveCommand(spec), "");
}

/** Everything about the container's life that a caller may want to control. */
export interface PodmanLifetimeOptions {
  /** How host commands run — the probe and the removal.  Injectable. */
  runHost?: HostRun;
  /** How the container's own process is started.  Injectable. */
  startHost?: HostStart;
  /** How long a container may take to appear.  Defaults to 30s. */
  startTimeoutMs?: number;
  /** How often to ask whether it is there yet.  Defaults to 50ms. */
  pollMs?: number;
}

/** Wait until the container answers, or say why it never did. */
async function waitForContainer(
  spec: PodmanSpec,
  run: HostRun,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await run(containerExistsCommand(spec), "")).code === 0) return;
    await new Promise((settle) => setTimeout(settle, pollMs));
  }
  throw new PodmanSpecError(`container ${containerName(spec)} did not come up within ${timeoutMs}ms`);
}

/**
 * The container is there, or we start it — once per process, held by its stdin.
 * Returns the handle when this process holds it, and null when the container was
 * already there: this does not own what it did not start.
 */
export async function ensureContainer(
  spec: PodmanSpec,
  options: PodmanLifetimeOptions = {},
): Promise<ContainerHandle | null> {
  const run = options.runHost ?? runHost;
  const name = containerName(spec);
  const held = started.get(name);
  if (held) {
    if (held.alive()) return held;
    // The container died under us — killed from outside, or the host restarted.
    // Let the handle go and start a fresh one: `podman exec` into a name that is
    // gone fails, and failing is not what "it is there, or we start it" means.
    started.delete(name);
  }

  if ((await run(containerExistsCommand(spec), "")).code === 0) return null;

  const handle = await (options.startHost ?? startHost)(containerKeepaliveCommand(spec));
  started.set(name, handle);
  const timeoutMs = options.startTimeoutMs ?? CONTAINER_START_MS;
  try {
    await waitForContainer(spec, run, timeoutMs, options.pollMs ?? CONTAINER_POLL_MS);
  } catch (err) {
    await stopContainer(name);
    throw err;
  }
  return handle;
}
