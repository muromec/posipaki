// ── The command onto a host ────────────────────────────────────────────────
//
// Asserted exactly: ssh, the host as it was given, and the command behind it.  There is no
// host in this file by design — a command is data, and what it says is the whole contract
// with ssh.

import { describe, expect, it } from "vitest";
import { sshEntry } from "./commands.js";

describe("the command onto a host", () => {
  it("puts the host first, then the command exactly as given", () => {
    expect(sshEntry("env.invalid", ["/usr/bin/node", "/home/u/payload.js"])).toEqual([
      "ssh",
      "env.invalid",
      "/usr/bin/node",
      "/home/u/payload.js",
    ]);
  });

  it("wraps the staging command like any other command: the script is fed to `sh -s`", () => {
    // The kit is written by a script, and the script arrives on stdin — so staging takes
    // a connection of its own, and the gateway gets the next one.
    expect(sshEntry("env.invalid", ["sh", "-s"])).toEqual(["ssh", "env.invalid", "sh", "-s"]);
  });

  it("takes whatever ssh takes, and passes it through untouched", () => {
    // An alias from `~/.ssh/config`, a port, a user: ssh's own business, not this
    // package's.
    expect(sshEntry("user@box:2222", ["sh", "-s"])).toEqual([
      "ssh",
      "user@box:2222",
      "sh",
      "-s",
    ]);
  });
});
