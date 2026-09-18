// ── The way in, end to end ─────────────────────────────────────────────────
//
// ssh is handed in, but the process on the far side is real: the fixture speaks the wire
// itself — it stands in for the gateway — so these tests exercise what a consumer gets: a
// connection to stage over, a second to run the gateway over, and a channel that answers.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Channel } from "posipaki/remote";
import { hostVersion } from "posipaki/remote/node";
import type { HostRun, SpawnChild } from "posipaki/remote/node";
import { sshRemote } from "./remote.js";
import type { SshRemoteSpec } from "./spec.js";

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

/** A payload bundle on a throwaway path, and a host to stage it onto. */
function harness(extra: Partial<SshRemoteSpec<{ env: string }>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-ssh-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");

  const stageCommands: string[][] = [];
  const fed: string[] = [];
  const commands: string[][] = [];
  const output: Array<[number, string]> = [];
  const gone: number[] = [];

  const run: HostRun = async (command, stdin) => {
    stageCommands.push(command);
    fed.push(stdin);
    return { code: 0, stdout: REPORT, stderr: "" };
  };

  const spawner = sshRemote<{ env: string }>({
    host: "env.invalid",
    hostVersion: APP,
    payload,
    payloadArgs: (spawnArgs) => [`--env=${spawnArgs.env}`],
    run,
    spawn: (command, stdio) => {
      commands.push(command);
      const child = spawn(process.execPath, [FAR_END], { stdio });
      children.push(child);
      return child;
    },
    onOutput: (fd, data) => output.push([fd, data]),
    onGone: () => gone.push(1),
    ...extra,
  });

  return { spawner, stageCommands, fed, commands, output, gone };
}

/** A host that refuses the connection: what ssh itself says when it cannot get in. */
const refused: SpawnChild = (_command, stdio) =>
  spawn("sh", ["-c", "echo 'ssh: connect to host env.invalid: Connection refused' >&2; exit 255"], {
    stdio,
  });

/** Let a session go, whatever state it is in. */
async function stop(channel: Channel, child: ChildProcess): Promise<void> {
  await channel.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await new Promise<void>((settle) =>
    child.exitCode !== null ? settle() : child.once("exit", () => settle()),
  );
}

it("stages over one connection, runs the gateway over the next, and speaks the wire", async () => {
  const live = harness();
  const channel = await live.spawner({ env: "agent" });
  const child = children[0]!;

  expect(live.stageCommands).toEqual([["ssh", "env.invalid", "sh", "-s"]]);
  expect(live.fed[0]).toContain('kit_dir="$HOME/');
  expect(live.fed[0]).toContain("gateway.js");
  // The payload is the gateway's first argument, and what the consumer adds follows the
  // gateway's own flags.
  expect(live.commands).toEqual([
    [
      "ssh",
      "env.invalid",
      "/usr/bin/node",
      `${KIT_DIR}/gateway.js`,
      `${KIT_DIR}/payload.js`,
      `--host-version=${HOST}`,
      "--env=agent",
    ],
  ]);

  const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
  await channel.send({ $msg: { fromName: "client", body: { echo: "hi" } } });
  expect(await heard).toEqual({ $msg: { fromName: "staged-payload", body: { echo: "hi" } } });
  // What the far end prints is output, never protocol.
  expect(live.output).toContainEqual([2, "the far end is ready\n"]);

  await stop(channel, child);
});

it("tells the caller when the host's process is gone", async () => {
  const live = harness();
  const channel = await live.spawner({ env: "agent" });
  const child = children[0]!;
  try {
    const last = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
    await channel.send({ $msg: { body: { type: "BYE" } } });
    expect(await last).toEqual({ $exit: { code: 0, state: { said: true } } });
    await new Promise<void>((settle) =>
      child.exitCode !== null ? settle() : child.once("exit", () => settle()),
    );
    expect(live.gone).toHaveLength(1);
  } finally {
    await stop(channel, child);
  }
});

it("turns a host that refuses the connection into a reason, not a channel that never answers", async () => {
  const live = harness({ spawn: refused });

  await expect(live.spawner({ env: "agent" })).rejects.toThrow(
    /env\.invalid is not available: exited with code 255: ssh: connect to host env\.invalid: Connection refused/,
  );
});

it("reads the payload before it runs a command about it", async () => {
  let ran = false;
  const live = harness({
    payload: join(dirname(fileURLToPath(import.meta.url)), "fixtures", "absent.js"),
    run: async () => {
      ran = true;
      return { code: 0, stdout: REPORT, stderr: "" };
    },
  });

  await expect(live.spawner({ env: "agent" })).rejects.toThrow(/absent\.js/);
  expect(ran).toBe(false);
});
