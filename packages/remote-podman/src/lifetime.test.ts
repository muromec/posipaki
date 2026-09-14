// ── The container's life, with a host that is handed in ────────────────────
//
// Everything podman would do is injected: the probe answers, the container is a
// stand-in handle.  So what is asserted is the policy — start what is not there
// and hold it, and for a name that is taken: reuse it, replace it, or refuse.

import { expect, it } from "vitest";
import {
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
} from "./commands.js";
import type { HostResult, HostRun } from "./host.js";
import { containerExists, removeContainer, startContainer } from "./lifetime.js";
import type { ContainerHandle, HostStart } from "./lifetime.js";
import type { ContainerSpec } from "./spec.js";

/** A spec whose container name is its own, so one test cannot disturb another. */
function spec(name: string): ContainerSpec {
  return { image: "toolbox:1", container: name };
}

/** A host runner that answers the probe as told and records what it was asked. */
function probe(answers: number[]): { run: HostRun; commands: string[][] } {
  const commands: string[][] = [];
  const run: HostRun = async (command) => {
    commands.push(command);
    const code = answers.length > 1 ? answers.shift() : answers[0];
    return { code: code ?? 1, stdout: "", stderr: "" };
  };
  return { run, commands };
}

/** The podman we are not running: a handle that only says what it was told. */
function startFrom(record: string[][], alive: () => boolean = () => true): HostStart {
  return async (command) => {
    record.push(command);
    return {
      name: command[command.indexOf("--name") + 1] ?? "",
      alive,
      stop: async () => {},
    };
  };
}

it("asks whether a container is there, whoever started it", async () => {
  const there = probe([0]);
  expect(await containerExists("env-a", there.run)).toBe(true);
  expect(there.commands).toEqual([containerExistsCommand("env-a")]);

  const missing = probe([1]);
  expect(await containerExists("env-b", missing.run)).toBe(false);
});

it("starts one that is not there, waits for it, and hands back the handle", async () => {
  // "Not yet" once, then it answers.
  const { run } = probe([1, 0]);
  const started: string[][] = [];
  const result = await startContainer(spec("env-fresh"), {
    runHost: run,
    startHost: startFrom(started),
    pollMs: 1,
  });

  expect(started).toEqual([containerKeepaliveCommand(spec("env-fresh"))]);
  expect(result.handle?.name).toBe("env-fresh");
  expect(result.conflict).toBeNull();
});

it("refuses a name that is already taken, and touches nothing", async () => {
  const { run, commands } = probe([0]);
  const started: string[][] = [];
  await expect(
    startContainer(spec("env-taken"), { runHost: run, startHost: startFrom(started) }),
  ).rejects.toThrow(/container env-taken is already running, and is not ours to hold/);
  expect(started).toEqual([]);
  expect(commands).toEqual([containerExistsCommand("env-taken")]);
});

it("reuses a container somebody else holds when asked, and holds nothing itself", async () => {
  const { run, commands } = probe([0]);
  const started: string[][] = [];
  const result = await startContainer(spec("env-theirs"), {
    runHost: run,
    startHost: startFrom(started),
    onConflict: "reuse",
    reapMs: 1,
    pollMs: 1,
  });

  expect(result).toEqual({ handle: null, conflict: "reuse" });
  expect(started).toEqual([]);
  // All it did was ask, as often as the short reap window allowed.
  expect(commands[0]).toEqual(containerExistsCommand("env-theirs"));
  expect(commands.every((command) => command[1] === "container")).toBe(true);
});

it("waits out a container that is going away, then starts its own", async () => {
  // There, still there, gone, then up after our start.
  const { run } = probe([0, 0, 1, 0]);
  const started: string[][] = [];
  const result = await startContainer(spec("env-going"), {
    runHost: run,
    startHost: startFrom(started),
    onConflict: "reuse",
    reapMs: 100,
    pollMs: 1,
  });

  expect(result.handle?.name).toBe("env-going");
  expect(started).toHaveLength(1);
});

it("replaces what is there when asked, and holds what it started", async () => {
  const { run, commands } = probe([0, 1, 0]);
  const started: string[][] = [];
  const result = await startContainer(spec("env-replace"), {
    runHost: run,
    startHost: startFrom(started),
    onConflict: "replace",
    reapMs: 100,
    pollMs: 1,
  });

  expect(commands[0]).toEqual(containerExistsCommand("env-replace"));
  expect(commands[1]).toEqual(containerRemoveCommand("env-replace"));
  expect(started).toEqual([containerKeepaliveCommand(spec("env-replace"))]);
  expect(result.handle).not.toBeNull();
});

it("says so when it never comes up, and lets go of what it started", async () => {
  const { run } = probe([1]);
  let stopped = 0;
  const handle: ContainerHandle = {
    name: "env-never",
    alive: () => true,
    stop: async () => {
      stopped += 1;
    },
  };
  await expect(
    startContainer(spec("env-never"), {
      runHost: run,
      startHost: async () => handle,
      startTimeoutMs: 20,
      pollMs: 1,
    }),
  ).rejects.toThrow(/container env-never did not come up within 20ms/);
  expect(stopped).toBe(1);
});

it("hands back nothing when the name was taken while we were starting", async () => {
  // Not there, then it answers — but our client is already gone, so what
  // answers is somebody else's container.
  const { run } = probe([1, 0]);
  await expect(
    startContainer(spec("env-raced"), {
      runHost: run,
      startHost: startFrom([], () => false),
      pollMs: 1,
    }),
  ).rejects.toThrow(/container env-raced came up without us/);
});

it("takes down a container by name, whether or not we hold it", async () => {
  const { run, commands } = probe([0]);
  await removeContainer(spec("env-stale"), { runHost: run });
  expect(commands).toEqual([containerRemoveCommand("env-stale")]);
});
