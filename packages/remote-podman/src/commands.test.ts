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
  podmanRunCommand,
  podmanStageCommand,
} from "./commands.js";
import { containerName } from "./spec.js";
import type { PodmanSpec, PodmanStaged } from "./spec.js";

const SPEC: PodmanSpec = {
  image: "registry.example.org/team/toolbox:1.2",
  app: { name: "email-agent", version: "0.13.0" },
  payload: "build/env-payload.js",
};

const STAGED: PodmanStaged = { kitDir: "/home/u/bin/posipaki/kit-1", runtime: "/usr/bin/node" };

describe("the commands into a container", () => {
  it("takes its name from the image unless the caller names it", () => {
    expect(containerName(SPEC)).toBe("posipaki-toolbox");
    expect(containerName({ ...SPEC, container: "env-agent" })).toBe("env-agent");
    expect(containerName({ ...SPEC, image: "localhost:5000/app_v2:edge" })).toBe("posipaki-app_v2");
  });

  it("stages with one exec and a shell, the script on stdin", () => {
    expect(podmanStageCommand(SPEC)).toEqual(["podman", "exec", "-i", "posipaki-toolbox", "sh", "-s"]);
  });

  it("runs the staged payload on the run's own stdin/stdout", () => {
    expect(podmanRunCommand(SPEC, STAGED, ["--env=agent"])).toEqual([
      "podman",
      "exec",
      "-i",
      "posipaki-toolbox",
      "/usr/bin/node",
      `${STAGED.kitDir}/${PAYLOAD_ARTIFACT}`,
      "--env=agent",
    ]);
  });

  it("runs the gateway, naming the payload as its worker, when the shape relays", () => {
    expect(podmanRunCommand({ ...SPEC, relay: true }, STAGED, ["--env=agent"])).toEqual([
      "podman",
      "exec",
      "-i",
      "posipaki-toolbox",
      "/usr/bin/node",
      `${STAGED.kitDir}/${GATEWAY_ARTIFACT}`,
      "--env=agent",
      `--worker=${STAGED.kitDir}/${PAYLOAD_ARTIFACT}`,
    ]);
  });

  it("enters whatever container it was given", () => {
    expect(podmanEntry({ ...SPEC, container: "env-agent" }, ["true"])).toEqual([
      "podman",
      "exec",
      "-i",
      "env-agent",
      "true",
    ]);
  });

  it("gives the container its life: a run held by stdin, a probe, a removal", () => {
    expect(containerKeepaliveCommand(SPEC)).toEqual([
      "podman",
      "run",
      "--rm",
      "-i",
      "--name",
      "posipaki-toolbox",
      "registry.example.org/team/toolbox:1.2",
      "sh",
      "-c",
      "cat >/dev/null",
    ]);
    expect(containerExistsCommand(SPEC)).toEqual([
      "podman",
      "container",
      "exists",
      "posipaki-toolbox",
    ]);
    expect(containerRemoveCommand(SPEC)).toEqual(["podman", "rm", "-f", "posipaki-toolbox"]);
  });
});
