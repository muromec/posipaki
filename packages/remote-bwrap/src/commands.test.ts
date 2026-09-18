// ── The command into a sandbox ─────────────────────────────────────────────
//
// Asserted exactly: bwrap, the policy as it was given, and the command behind it.  There
// is no sandbox in this file by design — a command is data, and what it says is the whole
// contract with bwrap.

import { describe, expect, it } from "vitest";
import { bwrapEntry } from "./commands.js";

const POLICY = ["--ro-bind", "/", "/"];

describe("the command into a sandbox", () => {
  it("puts the policy before the command, and the command exactly as given", () => {
    expect(bwrapEntry(POLICY, ["/usr/bin/node", "/home/u/payload.js"])).toEqual([
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "/usr/bin/node",
      "/home/u/payload.js",
    ]);
  });

  it("wraps the staging command like any other command: the script is fed to `sh -s`", () => {
    // The kit is written by a script, and the script arrives on stdin — so the same
    // policy shapes the sandbox it writes in.
    expect(bwrapEntry(POLICY, ["sh", "-s"])).toEqual(["bwrap", "--ro-bind", "/", "/", "sh", "-s"]);
  });

  it("is the whole of what this package says about a command", () => {
    // Nothing about the payload, the gateway or the wire lives here: a way in says how a
    // command is reached, and everything inside it is posipaki's.
    expect(bwrapEntry([], ["/usr/bin/node", "/k/gateway.js"])).toEqual([
      "bwrap",
      "/usr/bin/node",
      "/k/gateway.js",
    ]);
  });
});
