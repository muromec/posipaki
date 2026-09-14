// ── A container of its own, for one actor ──────────────────────────────────
//
// The composite: podman is handed in and the far side is the fixture, so what is
// asserted is the whole shape — the container is started, the actor is staged and
// run in it, and when the actor's channel is gone the container is let go.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { containerKeepaliveCommand } from "./commands.js";
import { podmanEnvironment } from "./environment.js";
import type { PodmanEnvironmentOptions } from "./environment.js";
import type { HostRun, SpawnChild } from "./host.js";
import type { HostStart } from "./lifetime.js";
import type { ContainerSpec, KitSpec } from "./spec.js";

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

/** A payload bundle on a throwaway path, and the container it belongs to. */
function spec(extra: Partial<ContainerSpec & KitSpec> = {}): ContainerSpec & KitSpec {
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
  throw new Error("it never happened");
}

/**
 * A host where the container is not there yet, comes up when we start it, and
 * answers the staging with the report.  Starting and stopping are recorded.
 */
function host(container: ContainerSpec): {
  runHost: HostRun;
  startHost: HostStart;
  started: string[][];
  stopped: number[];
  spawnChild: SpawnChild;
} {
  const started: string[][] = [];
  const stopped: number[] = [];
  let up = false;
  const runHost: HostRun = async (command) => {
    if (command[1] === "container") return { code: up ? 0 : 1, stdout: "", stderr: "" };
    return { code: 0, stdout: REPORT, stderr: "" };
  };
  const startHost: HostStart = async (command) => {
    started.push(command);
    up = true;
    return {
      name: container.container,
      alive: () => true,
      stop: async () => {
        stopped.push(1);
        up = false;
      },
    };
  };
  const spawnChild: SpawnChild = (command, stdio) => {
    void command;
    const child = spawn(process.execPath, [FAR_END], { stdio });
    children.push(child);
    return child;
  };
  return { runHost, startHost, started, stopped, spawnChild };
}

it("starts a container for the actor, runs it in there, and lets the container go when it is done", async () => {
  const container = spec();
  const fake = host(container);
  const environment = podmanEnvironment<{ env: string }>(container, {
    runHost: fake.runHost,
    startHost: fake.startHost,
    spawnChild: fake.spawnChild,
    pollMs: 1,
    watchMs: 10,
    args: (args) => [`--env=${args.env}`],
  });

  const channel = await environment({ env: "agent" });
  expect(fake.started).toEqual([containerKeepaliveCommand(container)]);
  expect(fake.stopped).toEqual([]);

  // The actor goes; the container follows.
  children[0].kill();
  await waitFor(() => fake.stopped.length > 0);
  expect(fake.stopped).toEqual([1]);
  await channel.close().catch(() => {});
});

it("says the container is not available when it cannot be held", async () => {
  const container = spec();
  const fake = host(container);
  const environment = podmanEnvironment<{ env: string }>(container, {
    // Somebody else is holding it, and this environment did not ask to reuse.
    runHost: async (command) =>
      command[1] === "container" ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: REPORT, stderr: "" },
    startHost: fake.startHost,
    spawnChild: fake.spawnChild,
    pollMs: 1,
  });

  await expect(environment({ env: "agent" })).rejects.toThrow(
    /container env-agent is not available: container env-agent is already running/,
  );
  expect(fake.started).toEqual([]);
});

it("hands the actor's own arguments to the staged payload", async () => {
  const container = spec();
  const fake = host(container);
  const commands: string[][] = [];
  const environment = podmanEnvironment<{ env: string }>(container, {
    runHost: fake.runHost,
    startHost: fake.startHost,
    pollMs: 1,
    watchMs: 10,
    args: (args) => [`--env=${args.env}`],
    spawnChild: (command, stdio) => {
      commands.push(command);
      return fake.spawnChild(command, stdio);
    },
  } satisfies PodmanEnvironmentOptions<{ env: string }>);

  const channel = await environment({ env: "live" });
  expect(commands).toEqual([
    ["podman", "exec", "-i", "env-agent", "/usr/bin/node", `${KIT_DIR}/payload.js`, "--env=live"],
  ]);
  children[0].kill();
  await channel.close().catch(() => {});
});
