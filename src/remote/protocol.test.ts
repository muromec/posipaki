// ── Protocol encoding tests ────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { encode, decode, isProto, isInit, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";

describe("protocol encoding", () => {
  it("encodes and decodes $proto", () => {
    const line = encode("$proto", PROTO_VERSION);
    const msg = decode(line);
    expect(isProto(msg)).toBe(true);
    if (isProto(msg)) expect(msg.$proto).toBe(PROTO_VERSION);
  });

  it("encodes and decodes $init with parent info", () => {
    const line = encode("$init", {
      parentName: "root",
      parentIdName: "root",
      tools: ["tool1"],
    });
    const msg = decode(line);
    expect(isInit(msg)).toBe(true);
    if (isInit(msg)) {
      expect(msg.$init.parentName).toBe("root");
      expect(msg.$init.parentIdName).toBe("root");
      expect(msg.$init.tools).toEqual(["tool1"]);
    }
  });

  it("encodes and decodes $state", () => {
    const line = encode("$state", { pings: 5 });
    const msg = decode(line);
    expect(isState(msg)).toBe(true);
    if (isState(msg)) expect(msg.$state.pings).toBe(5);
  });

  it("encodes and decodes $msg", () => {
    const line = encode("$msg", { type: "PING", fromName: "host", body: { count: 1 } });
    const msg = decode(line);
    expect(isMsg(msg)).toBe(true);
    if (isMsg(msg)) {
      expect(msg.$msg.type).toBe("PING");
      expect(msg.$msg.fromName).toBe("host");
    }
  });

  it("encodes and decodes $exit", () => {
    const line = encode("$exit", { code: 0, state: { done: true } });
    const msg = decode(line);
    expect(isExit(msg)).toBe(true);
    if (isExit(msg)) {
      expect(msg.$exit.code).toBe(0);
    }
  });
});
