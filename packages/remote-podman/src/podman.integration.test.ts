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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { runHost } from "./host.js";
import { containerExistsCommand, containerRemoveCommand } from "./commands.js";
import { removeContainer, stopContainer } from "./lifetime.js";
import { podmanSpawner } from "./spawner.js";
import { podmanStage } from "./stage.js";
import type { PodmanSpec } from "./spec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(HERE, "fixtures", "sh-payload.sh");
const IMAGE = process.env.POSIPAKI_PODMAN_IMAGE ?? "";
const NAME = `posipaki-it-${process.pid}`;

/** The spec the container runs: a shell payload, so no runtime has to be installed. */
function spec(): PodmanSpec {
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
async function waitForGone(container: PodmanSpec, deadlineMs: number): Promise<boolean> {
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
  "stages into a container it started, speaks the wire, and leaves nothing behind",
  async () => {
    const container = spec();
    // Staging is the first channel; the container is started for it.
    const staged = await podmanStage(container, { startTimeoutMs: 120_000 });
    expect(staged.runtime).not.toBe("");

    const listing = await runHost(
      ["podman", "exec", "-i", NAME, "sh", "-c", `ls "${staged.kitDir}"`],
      "",
    );
    expect(listing.code).toBe(0);
    const installed = listing.stdout.split("\n").filter(Boolean);
    expect(installed).toContain("payload.js");
    expect(installed).toContain("version.json");

    // The second channel: the payload, whose own stdin/stdout are the wire.
    const channel = await podmanSpawner<Record<string, never>>(container, {
      args: () => [],
      handshakeTimeoutMs: 120_000,
    })({});
    const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
    await channel.send({ $msg: { fromName: "test", body: { echo: "hi" } } });
    expect(await heard).toEqual({ $msg: { fromName: "sh-payload", body: { echo: "pong" } } });

    // Let go: the keepalive's stdin closes, the main process exits, `--rm` takes
    // the container away — and nothing has to remember to clean up.
    await channel.close().catch(() => {});
    await stopContainer(NAME);
    // Letting go is not instantaneous: the container's main process has to see the
    // EOF, stop, and be reaped by podman before the name is free again.
    const gone = await waitForGone(container, 15_000);
    expect(gone).toBe(true);
  },
  180_000,
);

maybe(
  "refuses a spec whose payload is not there, before it starts anything",
  async () => {
    const missing: PodmanSpec = { ...spec(), container: `${NAME}-missing`, payload: join(HERE, "nothing-here.js") };
    await expect(podmanStage(missing, { runHost })).rejects.toThrow(/ENOENT|no such file/);
    // Nothing was started on its behalf: the kit is read before the container.
    const exists = await runHost(containerExistsCommand(missing), "");
    expect(exists.code).not.toBe(0);
    await runHost(containerRemoveCommand(missing), "");
  },
  60_000,
);
