// ── A real container ───────────────────────────────────────────────────────
//
// Opt-in, because it needs podman, an image, and a moment: set
// POSIPAKI_PODMAN_IMAGE to run it.  It is the only test here that touches a real
// container, and it exists because the container's *life* is podman's business and
// not ours: an attached keepalive held by its stdin, `exec -i` into it, and `--rm`
// when we let go.  The fakes assert the commands; this asserts the commands work.
//
// The image has to have a runtime posipaki can use (`node`, `nodejs` or `bun`): the
// payload runs behind a gateway, and the gateway runs the payload with its own
// interpreter.  The payload itself is plain JavaScript on the fifos.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { runHost, spawnChild as spawnOnHost } from "posipaki/remote/node";
import type { HostRun } from "posipaki/remote/node";
import { containerExistsCommand } from "./commands.js";
import { podmanEnvironment } from "./environment.js";
import { removeContainer } from "./lifetime.js";
import { podmanRemote } from "./remote.js";
import type { PodmanRemoteSpec } from "./spec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const PAYLOAD = join(HERE, "fixtures", "fifo-payload.js");
/** A scratch directory for the bundle the image is given: nothing is built in the tree. */
const scratch = mkdtempSync(join(tmpdir(), "posipaki-podman-it-"));

/**
 * The gateway program, built the way a consumer builds one: a bundle, because what is
 * staged into a container is one file with its imports already inside it.
 */
function builtGateway(): string {
  const out = join(scratch, "gateway.js");
  const built = spawnSync(
    process.execPath,
    ["build", "--target=node", `--outfile=${out}`, join(ROOT, "src", "remote", "gateway-cli.ts")],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (built.status !== 0) throw new Error(`cannot build the gateway: ${built.stderr}`);
  return out;
}
const IMAGE = process.env.POSIPAKI_PODMAN_IMAGE ?? "";
const NAME = `posipaki-it-${process.pid}`;

/** The spec the container runs: a payload on the fifos, and the gateway to relay to it. */
function spec(): PodmanRemoteSpec<Record<string, never>> {
  return {
    image: IMAGE,
    container: NAME,
    hostVersion: { name: "posipaki-it", version: "0" },
    payload: PAYLOAD,
    gateway: builtGateway(),
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
  rmSync(scratch, { recursive: true, force: true });
});

maybe(
  "runs an actor in a container of its own, speaks the wire, and leaves nothing behind",
  async () => {
    const children: ChildProcess[] = [];
    const environment = podmanEnvironment<Record<string, never>>({
      ...spec(),
      pollMs: 250,
      watchMs: 250,
      startTimeoutMs: 120_000,
      handshakeTimeoutMs: 120_000,
      spawn: (command, stdio) => {
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
    expect(await heard).toEqual({ $msg: { fromName: "fifo-payload", body: { echo: "hi" } } });

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
  const missing = podmanRemote<Record<string, never>>({
    ...spec(),
    container: `${NAME}-missing`,
    payload: join(HERE, "nothing-here.js"),
    run,
  });
  await expect(missing({})).rejects.toThrow(/ENOENT|no such file/);
  expect(commands).toEqual([]);
});

maybe(
  "reuses a container somebody else is holding when told to, and holds nothing itself",
  async () => {
    const children: ChildProcess[] = [];
    // One fake spawn for both: a guest's channel is a real process, like anyone's.
    const spawnAsHost = (command: string[], stdio: StdioOptions) => {
      const child = spawnOnHost(command, stdio);
      children.push(child);
      return child;
    };
    const options = {
      pollMs: 250,
      watchMs: 250,
      startTimeoutMs: 120_000,
      handshakeTimeoutMs: 120_000,
      spawn: spawnAsHost,
    };
    const first = podmanEnvironment<Record<string, never>>({ ...spec(), ...options });
    const held = await first({});

    const second = podmanEnvironment<Record<string, never>>({
      ...spec(),
      ...options,
      onConflict: "reuse",
      reapMs: 5_000,
    });
    const guest = await second({});
    const heard = new Promise<Record<string, unknown>>((resolve) => guest.onMessage(resolve));
    await guest.send({ $msg: { fromName: "test", body: { echo: "again" } } });
    expect(await heard).toEqual({ $msg: { fromName: "fifo-payload", body: { echo: "hi" } } });

    await guest.close().catch(() => {});
    await held.close().catch(() => {});
    for (const child of children) child.kill();
    expect(await waitForGone(NAME, 30_000)).toBe(true);
  },
  180_000,
);
