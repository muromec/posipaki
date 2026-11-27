// ── the command line ──────────────────────────────────────────────────────
//
// What a run is asked to do, and what it says when it cannot tell. No process, no socket: the strings a shell would
// hand over, and the facts a run needs.

import { describe, expect, it } from "vitest";

import { parseArgs, USAGE } from "./args.js";

describe("parseArgs", () => {
  it("takes a host, and answers what the defaults are", () => {
    expect(parseArgs(["192.168.88.20", "--cookie", "pocookie"])).toEqual({
      host: "192.168.88.20",
      cookie: "pocookie",
      node: "robot",
      to: "robot",
      self: "posipaki@192.168.88.20",
      message: "robot",
    });
  });

  it("takes the flags, wherever they stand", () => {
    expect(parseArgs(["--node", "probe", "10.0.0.2", "--message", "ping", "--cookie", "pw", "--self", "me@there"])).toEqual({
      host: "10.0.0.2",
      cookie: "pw",
      node: "probe",
      to: "probe",
      self: "me@there",
      message: "ping",
    });
  });

  it("sends to the node's own name unless another is named", () => {
    expect(parseArgs(["10.0.0.2", "--cookie", "pw", "--node", "robot", "--to", "echo"]).to).toBe("echo");
  });

  it("asks for what it cannot work with", () => {
    expect(() => parseArgs([])).toThrow(USAGE);
  });

  it("refuses a flag it does not have, and says which it does", () => {
    expect(() => parseArgs(["10.0.0.2", "--cookie", "pw", "--nmae", "robot"])).toThrow(
      "there is no --nmae: this program has --cookie, --node, --to, --self, --message",
    );
  });

  it("refuses a flag with nothing after it", () => {
    expect(() => parseArgs(["10.0.0.2", "--cookie", "pw", "--to"])).toThrow("--to needs a value");
  });

  it("refuses a second positional", () => {
    expect(() => parseArgs(["10.0.0.2", "--cookie", "pw", "extra"])).toThrow("unexpected after the host: extra");
  });
});
