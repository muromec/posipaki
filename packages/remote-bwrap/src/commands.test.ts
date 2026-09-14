// ── The commands into a sandbox ────────────────────────────────────────────
//
// Both channels are asserted exactly: bwrap, the policy as it was given, and the
// shell or runtime behind it.  There is no sandbox in this file by design — a
// command is data, and what it says is the whole contract with bwrap.

import { describe, expect, it } from "vitest";
import {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  bwrapEntry,
  bwrapStageCommand,
} from "./commands.js";
import type { BwrapSpec } from "./spec.js";

const SPEC: BwrapSpec = {
  name: "tools",
  args: ["--ro-bind", "/", "/"],
  app: { name: "email-agent", version: "0.13.0" },
  payload: "build/env-payload.js",
};

describe("the commands into a sandbox", () => {
  it("stages with the policy and a shell, the script on stdin", () => {
    expect(bwrapStageCommand(SPEC)).toEqual(["bwrap", "--ro-bind", "/", "/", "sh", "-s"]);
  });

  it("puts the policy before the command, and the command exactly as given", () => {
    expect(bwrapEntry(SPEC, ["/usr/bin/node", "/home/u/payload.js"])).toEqual([
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "/usr/bin/node",
      "/home/u/payload.js",
    ]);
  });

  it("names the artifacts a staged kit carries", () => {
    expect([PAYLOAD_ARTIFACT, GATEWAY_ARTIFACT]).toEqual(["payload.js", "gateway.js"]);
  });
});
