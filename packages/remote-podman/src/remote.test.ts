// ── The way in, end to end ─────────────────────────────────────────────────
//
// podman is handed in, but the process on the far side is real: the fixture speaks the wire
// itself — it stands in for the gateway — so these tests exercise what a consumer gets: one
// exec to stage over, a second to run the gateway over, and a channel that answers.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Channel } from "posipaki/remote";
import { hostVersion } from "posipaki/remote/node";
import type { HostRun } from "posipaki/remote/node";
import { podmanRemote } from "./remote.js";
import type { PodmanRemoteSpec } from "./spec.js";

const FAR_END = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "staged-payload.js");
const APP = { name: "email-agent", version: "0.13.0" };
/** The host version, rendered here so the kit's directory and the flag cannot go stale. */
const HOST = hostVersion(APP);
const KIT_DIR = `/home/agent/bin/posipaki/${HOST}`;
const REPORT = `staged\nkit ${KIT_DIR}\nruntime /usr/bin/node\n`;

const children: ChildProcess[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill();
    await new Promise<void>((settle) => child.once("exit", () => settle()));
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A payload bundle on a throwaway path, and a container to stage it into. */
function harness(extra: Partial<PodmanRemoteSpec<{ env: string }>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");

  const stageCommands: string[][] = [];
  const fed: string[] = [];
  const commands: string[][] = [];

  const run: HostRun = async (command, stdin) => {
    stageCommands.push(command);
    fed.push(stdin);
    return { code: 0, stdout: REPORT, stderr: "" };
  };

  const spawner = podmanRemote<{ env: string }>({
    image: "toolbox:1",
    container: "env-agent",
    hostVersion: APP,
    payload: { stage: payload },
    payloadArgs: (spawnArgs) => [`--env=${spawnArgs.env}`],
    run,
    spawn: (command, stdio) => {
      commands.push(command);
      const child = spawn(process.execPath, [FAR_END], { stdio });
      children.push(child);
      return child;
    },
    ...extra,
  });

  return { spawner, stageCommands, fed, commands };
}

/** Let a session go, whatever state it is in. */
async function stop(channel: Channel, child: ChildProcess): Promise<void> {
  await channel.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await new Promise<void>((settle) =>
    child.exitCode !== null ? settle() : child.once("exit", () => settle()),
  );
}

it("stages over one exec, runs the gateway over the next, and speaks the wire", async () => {
  const live = harness();
  const channel = await live.spawner({ env: "agent" });
  const child = children[0]!;

  expect(live.stageCommands).toEqual([["podman", "exec", "-i", "env-agent", "sh", "-s"]]);
  expect(live.fed[0]).toContain('kit_dir="$HOME/');
  expect(live.fed[0]).toContain("gateway.js");
  expect(live.commands).toEqual([
    [
      "podman",
      "exec",
      "-i",
      "env-agent",
      "/usr/bin/node",
      `${KIT_DIR}/gateway.js`,
      // The gateway is told what starts the payload instead of assuming a runtime: the same
      // one here, but stated by the client rather than borrowed from whatever runs the relay.
      "/usr/bin/node",
      `${KIT_DIR}/payload.js`,
      `--host-version=${HOST}`,
      "--env=agent",
    ],
  ]);

  const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
  await channel.send({ $msg: { fromName: "client", body: { echo: "hi" } } });
  expect(await heard).toEqual({ $msg: { fromName: "staged-payload", body: { echo: "hi" } } });

  await stop(channel, child);
});

it("turns a container that is not there into a reason, not a channel that never answers", async () => {
  const live = harness({
    spawn: (_command, stdio) =>
      spawn(
        "sh",
        // What podman itself says when the name is not there.
        ["-c", "echo 'Error: no container with name or ID \"env-agent\" found' >&2; exit 125"],
        { stdio },
      ),
  });

  await expect(live.spawner({ env: "agent" })).rejects.toThrow(
    /env-agent is not available: exited with code 125: Error: no container with name or ID/,
  );
});
