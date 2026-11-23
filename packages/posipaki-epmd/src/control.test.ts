// ── the control message ────────────────────────────────────────────────────
//
// The tuples below are the ones erts writes: opcode, a cookie slot nobody reads, and the fields of the signal. An
// opcode this client does not act on has to come back named, not skipped by an index.

import { describe, expect, it } from "vitest";

import { readControl, writeControl, type Control } from "./control.js";
import type { Term } from "./terms.js";

const pid = (node: string): Term => ({ kind: "pid", node, id: 1, serial: 0, creation: 7 });
const tuple = (...items: Term[]): Term => ({ kind: "tuple", items });
const int = (value: number): Term => ({ kind: "int", value });
const atom = (name: string): Term => ({ kind: "atom", name });

describe("readControl", () => {
  it("reads a message sent to a process", () => {
    expect(readControl(tuple(int(2), atom(""), pid("posipaki@host")))).toEqual({
      kind: "send",
      to: pid("posipaki@host"),
    });
  });

  it("reads a message sent to a registered name", () => {
    expect(readControl(tuple(int(6), pid("posipaki@host"), atom(""), atom("robot")))).toEqual({
      kind: "regSend",
      from: pid("posipaki@host"),
      to: "robot",
    });
  });

  it("reads the exit a node closes a connection with", () => {
    expect(readControl(tuple(int(3), pid("robot@tomato"), pid("posipaki@host"), atom("normal")))).toEqual({
      kind: "exit",
      from: pid("robot@tomato"),
      to: pid("posipaki@host"),
      reason: atom("normal"),
    });
  });

  it("names an opcode this client does not act on, with its number", () => {
    const items = [int(1), pid("robot@tomato"), pid("posipaki@host")];
    expect(readControl(tuple(...items))).toEqual({ kind: "other", opcode: 1, items });
  });

  it("refuses a control message without an opcode", () => {
    expect(() => readControl(tuple())).toThrow("a control message was an empty tuple, not a tuple headed by an opcode");
    expect(() => readControl(int(2))).toThrow("a control message was 2, not a tuple headed by an opcode");
    expect(() => readControl(tuple(atom("two")))).toThrow("began with atom, not an opcode");
  });

  it("refuses a registered send that names nothing", () => {
    expect(() => readControl(tuple(int(6), pid("posipaki@host"), atom("")))).toThrow(
      "a control message named nothing where the name to send to belonged",
    );
  });
});

describe("writeControl", () => {
  it("writes what readControl reads back", () => {
    const controls: Control[] = [
      { kind: "send", to: pid("posipaki@host") },
      { kind: "regSend", from: pid("posipaki@host"), to: "robot" },
      { kind: "exit", from: pid("robot@tomato"), to: pid("posipaki@host"), reason: atom("normal") },
    ];
    for (const control of controls) expect(readControl(writeControl(control))).toEqual(control);
  });

  it("writes the four fields of a registered send, the cookie slot included", () => {
    expect(writeControl({ kind: "regSend", from: pid("posipaki@host"), to: "robot" })).toEqual(
      tuple(int(6), pid("posipaki@host"), atom(""), atom("robot")),
    );
  });

  it("refuses to write a signal it does not act on", () => {
    expect(() => writeControl({ kind: "other", opcode: 1, items: [] })).toThrow(
      "a control message of opcode 1 is not one this side writes",
    );
  });
});
