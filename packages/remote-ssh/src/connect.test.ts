// ── The way in, end to end ─────────────────────────────────────────────────
//
// The host is handed in, but the process on the far side is real: the fixture
// speaks the wire itself, so these tests exercise what a consumer gets — one ssh
// to prepare, a second to run, and a channel that answers.  A host that is not
// there is a real process that dies the way a refused connection does.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Channel } from "posipaki/remote";
import { sshConnector } from "./connect.js";
import type { SshConnectOptions } from "./connect.js";
import { sshBootstrap } from "./bootstrap.js";
import type { HostRun, SpawnChild } from "./host.js";
import type { SshSpec } from "./spec.js";

const FAR_END = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "staged-payload.js");
const KIT_DIR = "/home/agent/bin/posipaki/email-agent-0.13.0-posipaki-0.32.1-abcdef12";
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

/** A payload bundle on a throwaway path, and the spec that stages it. */
function kit(extra: Partial<SshSpec> = {}): SshSpec {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-ssh-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  return { host: "env.invalid", app: { name: "email-agent", version: "0.13.0" }, payload, ...extra };
}

/**
 * A preparing host: the staging command answers with the report, and what the
 * run command is handed is recorded.
 */
function stageOver(report: string): { run: HostRun; commands: string[][]; fed: string[] } {
  const commands: string[][] = [];
  const fed: string[] = [];
  const run: HostRun = async (command, stdin) => {
    commands.push(command);
    fed.push(stdin);
    return { code: 0, stdout: report, stderr: "" };
  };
  return { run, commands, fed };
}

/** A spawner whose commands are recorded and whose run command the fixture plays. */
function harness(
  spec: SshSpec,
  options: Partial<SshConnectOptions & { args: (args: { env: string }) => string[] }> = {},
) {
  const staged = stageOver(REPORT);
  const commands: string[][] = [];
  const output: Array<[number, string]> = [];
  const gone: number[] = [];

  const spawner = sshBootstrap<{ env: string }>(spec, {
    runHost: staged.run,
    spawnChild: (command, stdio) => {
      commands.push(command);
      const child = spawn(process.execPath, [FAR_END], { stdio });
      children.push(child);
      return child;
    },
    args: (args) => [`--env=${args.env}`],
    onOutput: (fd, data) => output.push([fd, data]),
    onGone: () => gone.push(1),
    ...options,
  });
  return { spawner, commands, stageCommands: staged.commands, fed: staged.fed, output, gone };
}

/** A host that refuses to be spoken to: what a host with nothing there looks like. */
const nothingToRun: HostRun = async () => {
  throw new Error("nothing should have been run to prepare");
};

/** What a refused connection looks like: a process that dies without a word on the wire. */
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

it("stages over one ssh and runs the actor over a second", async () => {
  const live = harness(kit());
  const channel = await live.spawner({ env: "agent" });

  expect(live.stageCommands).toEqual([["ssh", "env.invalid", "sh", "-s"]]);
  expect(live.fed[0]).toContain('kit_dir="$HOME/');
  expect(live.commands).toEqual([
    ["ssh", "env.invalid", "/usr/bin/node", `${KIT_DIR}/payload.js`, "--env=agent"],
  ]);

  const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
  await channel.send({ $msg: { fromName: "client", body: { echo: "hi" } } });
  expect(await heard).toEqual({ $msg: { fromName: "staged-payload", body: { echo: "hi" } } });
  // What the far end prints is output, never protocol.
  expect(live.output).toContainEqual([2, "the far end is ready\n"]);

  await stop(channel, children[0]);
});

it("runs the gateway with the payload as its worker when the spec relays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-ssh-"));
  scratchDirs.push(dir);
  const gateway = join(dir, "gateway.js");
  writeFileSync(gateway, "// the gateway\n");
  const live = harness(kit({ relay: true, gateway }));
  const channel = await live.spawner({ env: "agent" });

  expect(live.commands).toEqual([
    [
      "ssh",
      "env.invalid",
      "/usr/bin/node",
      `${KIT_DIR}/gateway.js`,
      "--env=agent",
      `--worker=${KIT_DIR}/payload.js`,
    ],
  ]);
  await stop(channel, children[0]);
});

it("runs what the host already has, with nothing to prepare", async () => {
  const commands: string[][] = [];
  const spawner = sshConnector<{ env: string }>(
    {
      host: "env.invalid",
      command: (args) => ["/usr/local/bin/worker", `--env=${args.env}`],
    },
    {
      runHost: nothingToRun,
      spawnChild: (command, stdio) => {
        commands.push(command);
        const child = spawn(process.execPath, [FAR_END], { stdio });
        children.push(child);
        return child;
      },
    },
  );

  const channel = await spawner({ env: "agent" });
  expect(commands).toEqual([
    ["ssh", "env.invalid", "/usr/local/bin/worker", "--env=agent"],
  ]);
  await stop(channel, children[0]);
});

it("fails the spawn with what a host that never speaks said", async () => {
  const spawner = sshConnector<{ env: string }>(
    { host: "env.invalid", command: () => ["/usr/local/bin/worker"] },
    { spawnChild: refused },
  );

  await expect(spawner({ env: "agent" })).rejects.toThrow(
    /ssh env\.invalid is not available:.*Connection refused/,
  );
});

it("fails before anything runs when the host has no runtime", async () => {
  const commands: string[][] = [];
  const spawner = sshBootstrap<{ env: string }>(kit(), {
    runHost: async () => ({ code: 75, stdout: "error no runtime among: node nodejs bun\n", stderr: "" }),
    spawnChild: (command) => {
      commands.push(command);
      throw new Error("nothing should have been started");
    },
  });
  await expect(spawner({ env: "agent" })).rejects.toThrow(/no runtime among: node nodejs bun/);
  expect(commands).toEqual([]);
});

it("tells the caller when the host's process is gone", async () => {
  const live = harness(kit());
  const channel = await live.spawner({ env: "agent" });
  expect(live.gone).toEqual([]);

  children[0].kill();
  const until = Date.now() + 5_000;
  while (live.gone.length === 0 && Date.now() < until) {
    await new Promise((settle) => setTimeout(settle, 20));
  }
  expect(live.gone).toEqual([1]);
  await channel.close().catch(() => {});
});
