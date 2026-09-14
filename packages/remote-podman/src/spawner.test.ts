// ── The way in, end to end ─────────────────────────────────────────────────
//
// Podman is handed in, but the process on the far side is real: the fixture speaks
// the wire itself, so these tests exercise what a consumer gets — the container
// probed (and started when missing), one `exec` to stage, a second to run, and a
// channel that answers.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Channel } from "posipaki/remote";
import type { HostRun, SpawnChild } from "./host.js";
import { containerKeepaliveCommand } from "./commands.js";
import type { HostStart } from "./lifetime.js";
import type { PodmanSpawnerOptions } from "./spawner.js";
import { podmanSpawner } from "./spawner.js";
import type { PodmanSpec } from "./spec.js";

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
function spec(extra: Partial<PodmanSpec> = {}): PodmanSpec {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  return {
    image: "toolbox:1",
    container: "env-agent",
    app: { name: "email-agent", version: "0.13.0" },
    payload,
    ...extra,
  };
}

/** Wait for something the far end does on its own clock. */
async function waitFor(what: () => boolean, deadlineMs = 5_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (what()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error("the far end never did it");
}

/** What a container that dies mid-exec looks like: a process with nothing to say. */
const refused: SpawnChild = (_command, stdio) =>
  spawn("sh", ["-c", "echo 'Error: no such container: env-agent' >&2; exit 125"], { stdio });

/**
 * A host where the container is already there: the probe answers, the staging
 * command answers with the report, and what the run command is handed is recorded.
 */
function stageOver(report: string): { run: HostRun; probes: string[][]; commands: string[][]; fed: string[] } {
  const probes: string[][] = [];
  const commands: string[][] = [];
  const fed: string[] = [];
  const run: HostRun = async (command, stdin) => {
    if (command[1] === "container") {
      probes.push(command);
      return { code: 0, stdout: "", stderr: "" };
    }
    commands.push(command);
    fed.push(stdin);
    return { code: 0, stdout: report, stderr: "" };
  };
  return { run, probes, commands, fed };
}

/** A spawner whose commands are recorded and whose run command the fixture plays. */
function harness(container: PodmanSpec, options: Partial<PodmanSpawnerOptions<{ env: string }>> = {}) {
  const staged = stageOver(REPORT);
  const commands: string[][] = [];
  const output: Array<[number, string]> = [];
  const gone: number[] = [];

  const spawner = podmanSpawner<{ env: string }>(container, {
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
  return {
    spawner,
    commands,
    probes: staged.probes,
    stageCommands: staged.commands,
    fed: staged.fed,
    output,
    gone,
  };
}

/** Let a session go, whatever state it is in. */
async function stop(channel: Channel, child: ChildProcess): Promise<void> {
  await channel.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await new Promise<void>((settle) =>
    child.exitCode !== null ? settle() : child.once("exit", () => settle()),
  );
}

it("probes the container, stages over one exec and runs the actor over a second", async () => {
  const live = harness(spec());
  const channel = await live.spawner({ env: "agent" });

  expect(live.probes).toEqual([["podman", "container", "exists", "env-agent"]]);
  expect(live.stageCommands).toEqual([["podman", "exec", "-i", "env-agent", "sh", "-s"]]);
  expect(live.fed[0]).toContain('kit_dir="$HOME/');
  expect(live.commands).toEqual([
    ["podman", "exec", "-i", "env-agent", "/usr/bin/node", `${KIT_DIR}/payload.js`, "--env=agent"],
  ]);

  const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
  await channel.send({ $msg: { fromName: "client", body: { echo: "hi" } } });
  expect(await heard).toEqual({ $msg: { fromName: "staged-payload", body: { echo: "hi" } } });
  // What the far end prints is output, never protocol.
  expect(live.output).toContainEqual([2, "the far end is ready\n"]);

  await stop(channel, children[0]);
});

it("starts the container, waits for it, and still stages into it", async () => {
  const container = spec();
  const started: string[][] = [];
  const startHost: HostStart = async (command) => {
    started.push(command);
    return { name: "env-agent", alive: () => true, stop: async () => {} };
  };
  const answers: number[] = [1, 0];
  const run: HostRun = async (command) => {
    if (command[1] === "container") {
      const code = answers.length > 1 ? answers.shift() : answers[0];
      return { code: code ?? 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: REPORT, stderr: "" };
  };
  const live = harness(container, { runHost: run, startHost, pollMs: 1 });
  const channel = await live.spawner({ env: "agent" });

  expect(started).toEqual([containerKeepaliveCommand(container)]);
  expect(live.commands[0]?.slice(0, 5)).toEqual([
    "podman",
    "exec",
    "-i",
    "env-agent",
    "/usr/bin/node",
  ]);
  await stop(channel, children[0]);
});

it("runs the gateway with the payload as its worker when the spec relays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const gateway = join(dir, "gateway.js");
  writeFileSync(gateway, "// the gateway\n");
  const live = harness(spec({ relay: true, gateway }));
  const channel = await live.spawner({ env: "agent" });

  expect(live.commands).toEqual([
    [
      "podman",
      "exec",
      "-i",
      "env-agent",
      "/usr/bin/node",
      `${KIT_DIR}/gateway.js`,
      "--env=agent",
      `--worker=${KIT_DIR}/payload.js`,
    ],
  ]);
  await stop(channel, children[0]);
});

it("fails the spawn with what a container that never speaks said", async () => {
  const spawner = podmanSpawner<{ env: string }>(spec(), {
    runHost: stageOver(REPORT).run,
    spawnChild: refused,
    args: () => [],
  });
  await expect(spawner({ env: "agent" })).rejects.toThrow(
    /container env-agent is not available:.*no such container/,
  );
});

it("fails before anything runs when the container has no runtime", async () => {
  const commands: string[][] = [];
  const spawner = podmanSpawner<{ env: string }>(spec(), {
    runHost: async (command) => {
      if (command[1] === "container") return { code: 0, stdout: "", stderr: "" };
      return { code: 75, stdout: "error no runtime among: node nodejs bun\n", stderr: "" };
    },
    spawnChild: (command) => {
      commands.push(command);
      throw new Error("nothing should have been started");
    },
  });
  await expect(spawner({ env: "agent" })).rejects.toThrow(/no runtime among: node nodejs bun/);
  expect(commands).toEqual([]);
});

it("tells the caller when the container's process is gone", async () => {
  const live = harness(spec());
  const channel = await live.spawner({ env: "agent" });
  expect(live.gone).toEqual([]);

  children[0].kill();
  await waitFor(() => live.gone.length > 0);
  expect(live.gone).toEqual([1]);
  await channel.close().catch(() => {});
});
