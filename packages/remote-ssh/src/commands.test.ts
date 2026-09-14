// ── The commands into a host ───────────────────────────────────────────────
//
// The preparing channel is asserted exactly: an ssh, the host as it was given,
// and the shell behind it.  There is no host in this file by design — a command
// is data, and what it says is the whole contract with ssh.  The run's own argv
// is not built here (see bootstrap.ts), so it is asserted where it is built.

import { describe, expect, it } from "vitest";
import { sshEntry, sshStageCommand } from "./commands.js";
import type { SshSpec } from "./spec.js";

const SPEC: SshSpec = {
  host: "env.invalid",
  app: { name: "email-agent", version: "0.13.0" },
  payload: "build/env-payload.js",
};

describe("the commands into a host", () => {
  it("stages with one ssh and a shell, the script on stdin", () => {
    expect(sshStageCommand(SPEC)).toEqual(["ssh", "env.invalid", "sh", "-s"]);
  });

  it("takes the host exactly as ssh takes it", () => {
    expect(sshEntry("toolbox", ["true"])).toEqual(["ssh", "toolbox", "true"]);
    expect(sshEntry("u@box:2222", ["true"])).toEqual(["ssh", "u@box:2222", "true"]);
  });
});
