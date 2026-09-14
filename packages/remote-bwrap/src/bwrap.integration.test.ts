// ── A real sandbox ─────────────────────────────────────────────────────────
//
// Skips itself when bwrap is not on the machine, because that is the only thing
// it needs: no image, no host, no network.  It is the only test here that makes a
// real sandbox, and it exists because the policy is bwrap's business and not ours
// — a read-only machine, one writable directory, and a payload that speaks the
// wire through it.  The fakes assert the arguments; this asserts the arguments do
// what they say.
//
// The payload is a shell script, since a runtime is whatever `command -v` finds
// — so nothing here depends on node being inside the sandbox.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import type { BwrapSpec } from "./spec.js";
import { bwrapBootstrap } from "./bootstrap.js";
import { runHost } from "./host.js";
import { sandboxArgs } from "./sandbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(HERE, "fixtures", "sh-payload.sh");
const SCRATCH = mkdtempSync(join(tmpdir(), "posipaki-bwrap-it-"));

/** The sandbox the actor runs in: its own writable directory, nothing else. */
function spec(): BwrapSpec {
  return {
    name: `it-${process.pid}`,
    args: sandboxArgs({ home: SCRATCH, tmpfs: [] }),
    app: { name: "posipaki-it", version: "0" },
    payload: PAYLOAD,
    runtime: ["sh"],
  };
}

/** bwrap is the whole requirement — no image, no host, no network. */
const haveBwrap = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
const maybe = haveBwrap ? it : it.skip;

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

maybe(
  "runs an actor in a sandbox of its own, speaks the wire, and leaves nothing behind",
  async () => {
    const spawner = bwrapBootstrap<Record<string, never>>(spec(), { handshakeTimeoutMs: 60_000 });

    // The kit is staged into the sandbox's own home, which is a real directory
    // here: bwrap binds paths, it does not copy anything.
    const channel = await spawner({});
    const kitParent = join(SCRATCH, "bin", "posipaki");
    expect(existsSync(kitParent)).toBe(true);
    expect(readdirSync(kitParent).length).toBeGreaterThan(0);

    const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
    await channel.send({ $msg: { fromName: "test", body: { echo: "hi" } } });
    expect(await heard).toEqual({ $msg: { fromName: "sh-payload", body: { echo: "pong" } } });

    // And it is a sandbox: the one writable directory is the one we gave it.
    const outside = await runHost(
      ["bwrap", ...spec().args, "sh", "-c", "touch /usr/posipaki-it-should-fail"],
      "",
    );
    expect(outside.code).not.toBe(0);
    const inside = await runHost(
      ["bwrap", ...spec().args, "sh", "-c", `touch "${SCRATCH}/it-can-write" && echo ok`],
      "",
    );
    expect(inside.stdout.trim()).toBe("ok");

    await channel.close().catch(() => {});
  },
  120_000,
);
