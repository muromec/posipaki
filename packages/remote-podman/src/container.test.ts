// ── A container, as an actor ───────────────────────────────────────────────
//
// Podman is handed in and nothing is really started: what is asserted is the
// actor's policy — it holds what it starts, it refuses a name that is taken
// unless it was told otherwise, it counts the consumers that retain it, and it
// lets the container go when the last one leaves or when it ends itself.

import { expect, it } from "vitest";
import { containerActor } from "./container.js";
import type { ContainerActorArgs, ContainerOut } from "./container.js";
import { containerKeepaliveCommand, containerRemoveCommand } from "./commands.js";
import type { HostRun } from "posipaki/remote/node";
import type { HostStart } from "./lifetime.js";

function spec(extra: Partial<ContainerActorArgs> = {}): ContainerActorArgs {
  return { image: "toolbox:1", container: "env-agent", watchMs: 10, pollMs: 1, ...extra };
}

/** A host runner where the probes answer as told and the rest is recorded. */
function probe(answers: number[]): { run: HostRun; commands: string[][] } {
  const commands: string[][] = [];
  const run: HostRun = async (command) => {
    commands.push(command);
    const code = answers.length > 1 ? answers.shift() : answers[0];
    return { code: code ?? 1, stdout: "", stderr: "" };
  };
  return { run, commands };
}

/** A start that records its command and can be told whether it is holding anything. */
function startFrom(
  record: string[][],
  options: { alive?: () => boolean; onStop?: () => void } = {},
): HostStart {
  return async (command) => {
    record.push(command);
    return {
      name: command[command.indexOf("--name") + 1] ?? "",
      alive: options.alive ?? (() => true),
      stop: async () => options.onStop?.(),
    };
  };
}

/** Wait for something the actor does on its own clock. */
async function waitFor(what: () => boolean, deadlineMs = 5_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (what()) return;
    await new Promise((settle) => setTimeout(settle, 5));
  }
  throw new Error("the actor never said it");
}

/**
 * Spawn the container actor and collect what it says.  The framework's own EXIT
 * is left out: it is how an actor reports that it is gone, not one of ours.
 */
async function spawnContainer(args: ContainerActorArgs) {
  const outs: ContainerOut[] = [];
  const proc = await containerActor.spawn(args, {
    name: args.container,
    toParent: (msg) => {
      if ((msg as { type: string }).type !== "EXIT") outs.push(msg as ContainerOut);
    },
  });
  return { proc, outs };
}

it("starts the container it was given and says it is up", async () => {
  const { run } = probe([1, 0]);
  const started: string[][] = [];
  const { proc, outs } = await spawnContainer(spec({ runHost: run, startHost: startFrom(started) }));
  await waitFor(() => outs.length > 0);

  expect(started).toEqual([containerKeepaliveCommand({ image: "toolbox:1", container: "env-agent" })]);
  expect(outs).toEqual([{ type: "UP", container: "env-agent", ours: true }]);
  proc.send({ type: "RETAIN" });
  proc.send({ type: "RELEASE" });
  await proc.wait();
});

it("refuses a name that is already taken, and says why it cannot have it", async () => {
  const { run } = probe([0]);
  const started: string[][] = [];
  const { proc, outs } = await spawnContainer(spec({ runHost: run, startHost: startFrom(started) }));
  await waitFor(() => outs.length > 0);

  expect(started).toEqual([]);
  expect(outs).toEqual([
    {
      type: "FAILED",
      container: "env-agent",
      reason: "container env-agent is already running, and is not ours to hold",
    },
  ]);
  await proc.wait();
});

it("reuses a container it did not start when told to, and holds nothing", async () => {
  const { run } = probe([0]);
  const started: string[][] = [];
  const { proc, outs } = await spawnContainer(
    spec({ runHost: run, startHost: startFrom(started), onConflict: "reuse", reapMs: 1 }),
  );
  await waitFor(() => outs.length > 0);

  expect(outs).toEqual([{ type: "UP", container: "env-agent", ours: false }]);
  expect(started).toEqual([]);
  proc.send({ type: "RELEASE" });
  await proc.wait();
});

it("counts its consumers and lets the container go when the last one leaves", async () => {
  const { run } = probe([1, 0]);
  const started: string[][] = [];
  let stopped = 0;
  const { proc, outs } = await spawnContainer(
    spec({ runHost: run, startHost: startFrom(started, { onStop: () => (stopped += 1) }) }),
  );

  await waitFor(() => outs.length > 0);
  proc.send({ type: "RETAIN" });
  proc.send({ type: "RETAIN" });
  proc.send({ type: "STATUS" });
  proc.send({ type: "RELEASE" });
  proc.send({ type: "RELEASE" });
  await proc.wait();

  expect(outs).toContainEqual({ type: "RETAINED", container: "env-agent", consumers: 2 });
  expect(outs).toContainEqual({
    type: "STATUS",
    container: "env-agent",
    ours: true,
    up: true,
    consumers: 2,
  });
  expect(outs).toContainEqual({ type: "RELEASED", container: "env-agent", consumers: 0 });
  expect(outs).toContainEqual({ type: "STOPPED", container: "env-agent" });
  expect(stopped).toBe(1);
});

it("says GONE when the container disappears under it", async () => {
  const { run } = probe([1, 0]);
  const started: string[][] = [];
  let alive = true;
  const { proc, outs } = await spawnContainer(
    spec({ runHost: run, startHost: startFrom(started, { alive: () => alive }) }),
  );
  await waitFor(() => outs.length > 0);

  expect(outs).toEqual([{ type: "UP", container: "env-agent", ours: true }]);
  alive = false;
  await proc.wait();
  expect(outs).toEqual([
    { type: "UP", container: "env-agent", ours: true },
    { type: "GONE", container: "env-agent" },
  ]);
});

it("takes its container with it when the actor ends", async () => {
  const { run } = probe([1, 0]);
  const started: string[][] = [];
  let stopped = 0;
  const { proc } = await spawnContainer(
    spec({ runHost: run, startHost: startFrom(started, { onStop: () => (stopped += 1) }) }),
  );

  proc.send({ type: "STOP" });
  await proc.wait();
  expect(stopped).toBe(1);
});

it("replaces what is there when the consumer says the container is theirs", async () => {
  // There; removed; gone; then up after our start.
  const { run, commands } = probe([0, 1, 0]);
  const started: string[][] = [];
  const { proc, outs } = await spawnContainer(
    spec({ runHost: run, startHost: startFrom(started), onConflict: "replace", reapMs: 100 }),
  );
  await waitFor(() => outs.length > 0);

  expect(commands[1]).toEqual(containerRemoveCommand("env-agent"));
  expect(outs).toEqual([{ type: "UP", container: "env-agent", ours: true }]);
  proc.send({ type: "RELEASE" });
  await proc.wait();
});
