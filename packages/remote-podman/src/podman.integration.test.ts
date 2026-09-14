// ── A real container ───────────────────────────────────────────────────────
//
// Opt-in, because it needs podman, an image, and a moment: set
// POSIPAKI_PODMAN_IMAGE to run it.  It is the only test here that touches a real
// container, and it exists because the container's *life* is podman's business and
// not ours: an attached keepalive held by its stdin, `exec -i` into it, and `--rm`
// when we let go.  The fakes assert the commands; this asserts the commands work.
//
// The payload is a shell script, since a runtime is whatever `command -v` finds —
// so the image only has to have a shell and this package never depends on node
// being inside it.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import type { ContainerSpec, KitSpec } from "./spec.js";
import { containerExistsCommand, containerRemoveCommand } from "./commands.js";
import { podmanEnvironment } from "./environment.js";
import type { HostRun } from "./host.js";
import { runHost, spawnChild as spawnOnHost } from "./host.js";
import { removeContainer } from "./lifetime.js";
import { podmanStage } from "./stage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(HERE, "fixtures", "sh-payload.sh");
const IMAGE = process.env.POSIPAKI_PODMAN_IMAGE ?? "";
const NAME = `posipaki-it-${process.pid}`;

/** The spec the container runs: a shell payload, so no runtime has to be installed. */
function spec(): ContainerSpec & KitSpec {
  return {
    image: IMAGE,
    container: NAME,
    app: { name: "posipaki-it", version: "0" },
    payload: PAYLOAD,
    runtime: ["node", "nodejs", "bun", "sh"],
  };
}

const maybe = IMAGE === "" ? it.skip : it;

/** Wait until the container is really gone, and say whether it ever was. */
async function waitForGone(container: string, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if ((await runHost(containerExistsCommand(container), "")).code !== 0) return true;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  return false;
}

afterAll(async () => {
  await removeContainer(spec());
});

maybe(
  "runs an actor in a container of its own, speaks the wire, and leaves nothing behind",
  async () => {
    const children: ChildProcess[] = [];
    const environment = podmanEnvironment<Record<string, never>>(spec(), {
      pollMs: 250,
      watchMs: 250,
      startTimeoutMs: 120_000,
      handshakeTimeoutMs: 120_000,
      spawnChild: (command, stdio) => {
        const child = spawnOnHost(command, stdio);
        children.push(child);
        return child;
      },
    });

    // The container is started for the actor, and the kit is staged into it.
    const channel = await environment({});
    const listing = await runHost(
      ["podman", "exec", "-i", NAME, "sh", "-c", 'ls "$HOME/bin/posipaki"'],
      "",
    );
    expect(listing.code).toBe(0);
    expect(listing.stdout.trim().split("\n")[0]).not.toBe("");

    const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
    await channel.send({ $msg: { fromName: "test", body: { echo: "hi" } } });
    expect(await heard).toEqual({ $msg: { fromName: "sh-payload", body: { echo: "pong" } } });

    // The actor goes; the container follows, because the last consumer left.
    await channel.close().catch(() => {});
    children[0]?.kill();
    // Letting go is not instantaneous: the container's main process has to see the
    // EOF, stop, and be reaped by podman before the name is free again.
    expect(await waitForGone(NAME, 30_000)).toBe(true);
  },
  180_000,
);

it("refuses a kit whose payload is not there, before it runs anything", async () => {
  const commands: string[][] = [];
  const run: HostRun = async (command) => {
    commands.push(command);
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect(
    podmanStage(`${NAME}-missing`, { app: { name: "posipaki-it", version: "0" }, payload: join(HERE, "nothing-here.js") }, run),
  ).rejects.toThrow(/ENOENT|no such file/);
  expect(commands).toEqual([]);
});

maybe(
  "reuses a container somebody else is holding when told to, and holds nothing itself",
  async () => {
    const children: ChildProcess[] = [];
    const options = {
      pollMs: 250,
      watchMs: 250,
      startTimeoutMs: 120_000,
      handshakeTimeoutMs: 120_000,
      spawnChild: (command: string[], stdio: Parameters<typeof spawnOnHost>[1]) => {
        const child = spawn(command[0], command.slice(1), { stdio });
        children.push(child);
        return child;
      },
    };
    const first = podmanEnvironment<Record<string, never>>(spec(), options);
    const held = await first({});

    const second = podmanEnvironment<Record<string, never>>(spec(), { ...options, onConflict: "reuse", reapMs: 5_000 });
    const guest = await second({});
    const heard = new Promise<Record<string, unknown>>((resolve) => guest.onMessage(resolve));
    await guest.send({ $msg: { fromName: "test", body: { echo: "again" } } });
    expect(await heard).toEqual({ $msg: { fromName: "sh-payload", body: { echo: "pong" } } });

    await guest.close().catch(() => {});
    await held.close().catch(() => {});
    for (const child of children) child.kill();
    expect(await waitForGone(NAME, 30_000)).toBe(true);
  },
  180_000,
);
