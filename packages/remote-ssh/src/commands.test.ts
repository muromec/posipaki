// ── The commands into a host ───────────────────────────────────────────────
//
// Both channels are asserted exactly: an ssh, the host as it was given, and the
// shell or runtime behind it.  There is no host in this file by design — a
// command is data, and what it says is the whole contract with ssh.

import { describe, expect, it } from "vitest";
import {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  sshEntry,
  sshRunCommand,
  sshStageCommand,
} from "./commands.js";
import type { SshSpec, SshStaged } from "./spec.js";

const SPEC: SshSpec = {
  host: "env.invalid",
  app: { name: "email-agent", version: "0.13.0" },
  payload: "build/env-payload.js",
};

const STAGED: SshStaged = { kitDir: "/home/u/bin/posipaki/kit-1", runtime: "/usr/bin/node" };

describe("the commands into a host", () => {
  it("stages with one ssh and a shell, the script on stdin", () => {
    expect(sshStageCommand(SPEC)).toEqual(["ssh", "env.invalid", "sh", "-s"]);
  });

  it("runs the staged payload on the run's own stdin/stdout", () => {
    expect(sshRunCommand(SPEC, STAGED, ["--env=agent"])).toEqual([
      "ssh",
      "env.invalid",
      "/usr/bin/node",
      `${STAGED.kitDir}/${PAYLOAD_ARTIFACT}`,
      "--env=agent",
    ]);
  });

  it("runs the gateway, naming the payload as its worker, when the shape relays", () => {
    expect(sshRunCommand({ ...SPEC, relay: true }, STAGED, ["--env=agent"])).toEqual([
      "ssh",
      "env.invalid",
      "/usr/bin/node",
      `${STAGED.kitDir}/${GATEWAY_ARTIFACT}`,
      "--env=agent",
      `--worker=${STAGED.kitDir}/${PAYLOAD_ARTIFACT}`,
    ]);
  });

  it("takes the host exactly as ssh takes it", () => {
    expect(sshEntry({ ...SPEC, host: "toolbox" }, ["true"])).toEqual(["ssh", "toolbox", "true"]);
    expect(sshEntry({ ...SPEC, host: "u@box:2222" }, ["true"])).toEqual([
      "ssh",
      "u@box:2222",
      "true",
    ]);
  });
});
