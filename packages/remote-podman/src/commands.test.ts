// ── The commands into a container ──────────────────────────────────────────
//
// Every command is asserted exactly: an `exec` into the named container, and the
// three that give the container its life.  No podman here by design — a command
// is data, and what it says is the whole contract with podman.

import { describe, expect, it } from "vitest";
import {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
  podmanEntry,
  podmanStageCommand,
} from "./commands.js";
import type { ContainerSpec } from "./spec.js";

const CONTAINER = "env-agent";
const SPEC: ContainerSpec = { image: "registry.example.org/team/toolbox:1.2", container: CONTAINER };

describe("the commands into a container", () => {
  it("enters by the name it was given, and takes nothing from the image", () => {
    expect(podmanEntry(CONTAINER, ["true"])).toEqual(["podman", "exec", "-i", "env-agent", "true"]);
    expect(podmanStageCommand(CONTAINER)).toEqual(["podman", "exec", "-i", "env-agent", "sh", "-s"]);
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

  it("names the artifacts inside the kit", () => {
    expect(PAYLOAD_ARTIFACT).toBe("payload.js");
    expect(GATEWAY_ARTIFACT).toBe("gateway.js");
  });
});
