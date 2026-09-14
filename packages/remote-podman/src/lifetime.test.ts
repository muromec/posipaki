// ── The container's life, with a host that is handed in ────────────────────
//
// Everything podman would do is injected: the probe answers, the container is a
// stand-in handle.  So what is asserted is the policy — start once, hold it,
// replace it if it died, let it go when it never came up.

import { expect, it } from "vitest";
import { containerKeepaliveCommand, containerRemoveCommand } from "./commands.js";
import type { HostResult, HostRun } from "./host.js";
import { ensureContainer, removeContainer, stopContainer } from "./lifetime.js";
import type { ContainerHandle, HostStart } from "./lifetime.js";
import type { PodmanSpec } from "./spec.js";

/** A spec whose container name is its own, so one test cannot disturb another. */
function spec(name: string): PodmanSpec {
  return {
    image: "toolbox:1",
    container: name,
    app: { name: "email-agent", version: "0.13.0" },
    payload: "build/env-payload.js",
  };
}

/** A host runner that answers the probe as told and records what it was asked. */
function probe(answers: Array<HostResult["code"]>): { run: HostRun; commands: string[][] } {
  const commands: string[][] = [];
  const run: HostRun = async (command) => {
    commands.push(command);
    const code = answers.length > 1 ? answers.shift() : answers[0];
    return { code: code ?? 1, stdout: "", stderr: "" };
  };
  return { run, commands };
}

/** The podman we are not running: a handle that only says what it was told. */
function startFrom(record: string[][]): HostStart {
  return async (command) => {
    record.push(command);
    return {
      name: command[command.indexOf("--name") + 1] ?? "",
      alive: () => true,
      stop: async () => {},
    };
  };
}

it("leaves a container that is already there exactly as it is", async () => {
  const { run, commands } = probe([0]);
  const started: string[][] = [];
  const held = await ensureContainer(spec("env-already"), { runHost: run, startHost: startFrom(started) });
  expect(held).toBeNull();
  expect(started).toEqual([]);
  expect(commands).toEqual([["podman", "container", "exists", "env-already"]]);
});

it("starts one when it is not there, waits for it, and holds it", async () => {
  // The probe says "not yet" twice before the container answers.
  const { run } = probe([1, 1, 0]);
  const started: string[][] = [];
  const held = await ensureContainer(spec("env-fresh"), {
    runHost: run,
    startHost: startFrom(started),
    pollMs: 1,
  });

  expect(started).toEqual([containerKeepaliveCommand(spec("env-fresh"))]);
  expect(held).not.toBeNull();
  // The same handle comes back on the next spawn: one container per process.
  const again = await ensureContainer(spec("env-fresh"), { runHost: run, startHost: startFrom(started) });
  expect(again).toBe(held);
  expect(started).toHaveLength(1);
  await stopContainer("env-fresh");
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
    ensureContainer(spec("env-never"), {
      runHost: run,
      startHost: async () => handle,
      startTimeoutMs: 20,
      pollMs: 1,
    }),
  ).rejects.toThrow(/container env-never did not come up within 20ms/);
  expect(stopped).toBe(1);
});

it("starts a fresh one when the container died under us", async () => {
  // Not there; up; gone; up again — the second start is the one being watched.
  const { run } = probe([1, 0, 1, 0]);
  let starts = 0;
  const startHost: HostStart = async (command) => {
    starts += 1;
    const generation = starts;
    return {
      name: command[command.indexOf("--name") + 1] ?? "",
      // The first container dies under us; its replacement lives.
      alive: () => generation > 1,
      stop: async () => {},
    };
  };
  await ensureContainer(spec("env-died"), { runHost: run, startHost, pollMs: 1 });
  expect(starts).toBe(1);
  await ensureContainer(spec("env-died"), { runHost: run, startHost, pollMs: 1 });
  expect(starts).toBe(2);
  await stopContainer("env-died");
});

it("takes down a container we are not holding", async () => {
  const { run, commands } = probe([0]);
  await removeContainer(spec("env-stale"), run);
  expect(commands).toEqual([containerRemoveCommand(spec("env-stale"))]);
});
