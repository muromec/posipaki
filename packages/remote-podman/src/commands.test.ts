// ── The commands into a container ──────────────────────────────────────────
//
// Every command is asserted exactly: an `exec` into the named container, and the
// three that give the container its life.  No podman here by design — a command
// is data, and what it says is the whole contract with podman.

import { describe, expect, it } from "vitest";
import {
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
  podmanEntry,
} from "./commands.js";
import type { ContainerSpec } from "./spec.js";

const CONTAINER = "env-agent";
const SPEC: ContainerSpec = { image: "registry.example.org/team/toolbox:1.2", container: CONTAINER };

describe("the commands into a container", () => {
  it("enters by the name it was given, and takes nothing from the image", () => {
    expect(podmanEntry(CONTAINER, ["true"])).toEqual(["podman", "exec", "-i", "env-agent", "true"]);
    // The staging script and the gateway are commands like any other: `-i` because the
    // wire is on stdin, and the name because the container is already there.
    expect(podmanEntry(CONTAINER, ["sh", "-s"])).toEqual(["podman", "exec", "-i", "env-agent", "sh", "-s"]);
    expect(podmanEntry(CONTAINER, ["/usr/bin/node", "/k/gateway.js"])).toEqual([
      "podman",
      "exec",
      "-i",
      "env-agent",
      "/usr/bin/node",
      "/k/gateway.js",
    ]);
  });

  it("gives the container its life: a run held by stdin, a probe, a removal", () => {
    expect(containerKeepaliveCommand(SPEC)).toEqual([
      "podman",
      "run",
      "--rm",
      "-i",
      "--name",
      "env-agent",
      "registry.example.org/team/toolbox:1.2",
      "sh",
      "-c",
      "cat >/dev/null",
    ]);
    expect(containerExistsCommand(CONTAINER)).toEqual([
      "podman",
      "container",
      "exists",
      "env-agent",
    ]);
    expect(containerRemoveCommand(CONTAINER)).toEqual(["podman", "rm", "-f", "env-agent"]);
  });
});
