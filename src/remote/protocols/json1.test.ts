// ── json1 protocol tests ───────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { encode, decode, VERSION } from "./json1.js";
import { isProto, isInit, isState, isMsg, isExit } from "../channel.js";

describe("json1 protocol", () => {
  it("round-trips frames", () => {
    expect(decode(encode({ $proto: VERSION }))).toEqual({ $proto: VERSION });
    expect(decode(encode({ $init: { start: 0, parentName: "root", parentIdName: "root" } }))).toEqual({
      $init: { start: 0, parentName: "root", parentIdName: "root" },
    });
    expect(decode(encode({ $state: { pings: 5 } }))).toEqual({ $state: { pings: 5 } });
    expect(
      decode(encode({ $msg: { fromName: "client", body: { type: "PING", count: 1 } } })),
    ).toEqual({ $msg: { fromName: "client", body: { type: "PING", count: 1 } } });
    expect(decode(encode({ $exit: { code: 0, state: { done: true } } }))).toEqual({
      $exit: { code: 0, state: { done: true } },
    });
  });

  it("guards narrow decoded frames", () => {
    expect(isProto(decode(encode({ $proto: VERSION })))).toBe(true);
    expect(isInit(decode(encode({ $init: {} })))).toBe(true);
    expect(isState(decode(encode({ $state: {} })))).toBe(true);
    expect(isMsg(decode(encode({ $msg: { fromName: "x", body: { type: "T" } } })))).toBe(true);
    expect(isExit(decode(encode({ $exit: { code: 0, state: null } })))).toBe(true);
  });
});
