// ── the command line ──────────────────────────────────────────────────────
//
// What a run is asked to do, and what it says when it cannot tell. No process, no socket: the strings a shell would
// hand over, and the facts the run needs.

import { describe, expect, it } from "vitest";

import { parseArgs, USAGE } from "./args.js";

describe("parseArgs", () => {
  it("takes a host and a cookie, and answers what the defaults are", () => {
    expect(parseArgs(["192.168.88.20", "pocookie"])).toEqual({
      host: "192.168.88.20",
      cookie: "pocookie",
      name: "robot",
      self: "posipaki@192.168.88.20",
      message: "robot",
    });
  });

  it("takes the three flags, wherever they stand", () => {
    expect(
      parseArgs(["--name", "probe", "10.0.0.2", "--message", "ping", "pw", "--self", "me@there"]),
    ).toEqual({
      host: "10.0.0.2",
      cookie: "pw",
      name: "probe",
      self: "me@there",
      message: "ping",
    });
  });

  it("asks for what it cannot work with", () => {
    expect(() => parseArgs([])).toThrow(USAGE);
    expect(() => parseArgs(["10.0.0.2"])).toThrow(USAGE);
  });

  it("refuses a flag it does not have, and says which it does", () => {
    expect(() => parseArgs(["10.0.0.2", "pw", "--nmae", "robot"])).toThrow(
      "there is no --nmae: this program has --name, --self, --message",
    );
  });

  it("refuses a flag with nothing after it", () => {
    expect(() => parseArgs(["10.0.0.2", "pw", "--name"])).toThrow("--name needs a value");
  });

  it("refuses a third positional", () => {
    expect(() => parseArgs(["10.0.0.2", "pw", "extra"])).toThrow("unexpected after the cookie: extra");
  });
});
