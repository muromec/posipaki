// ── The way in, end to end ─────────────────────────────────────────────────
//
// bwrap is handed in, but the process on the far side is real: the fixture speaks the wire
// itself — it stands in for the gateway — so these tests exercise what a consumer gets: one
// sandbox to stage in, a second to run in, and a channel that answers.  Whether bwrap
// honours the policy is the integration test's business; here the policy is data and the
// commands are asserted.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Channel } from "posipaki/remote";
import type { HostRun, SpawnChild } from "posipaki/remote/node";
import { bwrapRemote } from "./remote.js";
import { sandboxArgs } from "./sandbox.js";
import type { BwrapRemoteSpec } from "./spec.js";

const FAR_END = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "staged-payload.js");
const KIT_DIR = "/home/agent/bin/posipaki/email-agent-0.13.0-posipaki-0.34.0-abcdef12";
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

/** A payload bundle on a throwaway path, and a sandbox to run it in. */
function harness(extra: Partial<BwrapRemoteSpec<{ env: string }>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-bwrap-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  const args = sandboxArgs({ home: dir });

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

  const spawner = bwrapRemote<{ env: string }>({
    name: "tools",
    args,
    host: { name: "email-agent", version: "0.13.0" },
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

  return { spawner, args, stageCommands, fed, commands, output, gone };
}

/** A sandbox that refuses to be made: what a bind that is not there looks like. */
const refused: SpawnChild = (_command, stdio) =>
  spawn(
    "sh",
    ["-c", "echo \"bwrap: Can't find source path /nope: No such file or directory\" >&2; exit 1"],
    { stdio },
  );

/** Let a session go, whatever state it is in. */
async function stop(channel: Channel, child: ChildProcess): Promise<void> {
  await channel.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await new Promise<void>((settle) =>
    child.exitCode !== null ? settle() : child.once("exit", () => settle()),
  );
}

it("stages through the sandbox, runs the gateway in it, and speaks the wire", async () => {
  const live = harness();
  const channel = await live.spawner({ env: "agent" });
  const child = children[0]!;

  // The policy, then the shell that eats the script — and then the policy again with the
  // gateway behind it: the sandbox is made twice, and shared by nothing.
  expect(live.stageCommands).toEqual([["bwrap", ...live.args, "sh", "-s"]]);
  expect(live.fed[0]).toContain('kit_dir="$HOME/');
  expect(live.fed[0]).toContain("gateway.js");
  // The payload is the gateway's first argument, and what the consumer adds comes after
  // the gateway's own flags — so a positional of the payload's own can never be read as
  // the payload itself.
  expect(live.commands).toEqual([
    [
      "bwrap",
      ...live.args,
      "/usr/bin/node",
      `${KIT_DIR}/gateway.js`,
      `${KIT_DIR}/payload.js`,
      "--host-version=email-agent@0.13.0",
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

it("tells the caller when the sandbox's process is gone", async () => {
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

it("turns a sandbox that cannot be made into a reason, not a channel that never answers", async () => {
  const live = harness({ spawn: refused });

  await expect(live.spawner({ env: "agent" })).rejects.toThrow(
    /tools is not available: exited with code 1: bwrap: Can't find source path/,
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
