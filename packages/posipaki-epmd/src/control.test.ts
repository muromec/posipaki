// ── the control message ────────────────────────────────────────────────────
//
// The tuples below are the ones erts writes: opcode, a cookie slot nobody reads, and the fields of the signal. An
// opcode this client does not act on has to come back named, not skipped by an index.

import { describe, expect, it } from "vitest";

import { readControl, writeControl, type Control } from "./control.js";
import { atom, integer as int, pid as pidTerm, reference, TermReader, tuple, type Term, write } from "./terms.js";

/** A pid on `node`, which is all these cases need to say about one. */
const pid = (node: string): Term => pidTerm(node, 1, 0, 7);

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

  it("reads a watch set on a process, and on a name", () => {
    const ref = reference("robot@tomato", 7);
    expect(readControl(tuple(int(19), pid("robot@tomato"), pid("posipaki@host"), ref))).toEqual({
      kind: "monitor",
      from: pid("robot@tomato"),
      to: pid("posipaki@host"),
      ref,
    });
    // A watch names a registered process or a pid, and the field is called a proc for that reason.
    expect(readControl(tuple(int(19), pid("robot@tomato"), atom("relay"), ref))).toEqual({
      kind: "monitor",
      from: pid("robot@tomato"),
      to: atom("relay"),
      ref,
    });
  });


  it("reads a monitor a node wrote, and writes the same octets back", () => {
    // `term_to_binary({19, self(), self(), make_ref()})`, from a node: a real pid, a real reference and its three
    // words — a shape this side has to hand back byte for byte, since the id in it is the watcher's own.
    const octets = Buffer.from(
      "836804611358770D6E6F6E6F6465406E6F686F73740000000A0000000000000000" +
        "58770D6E6F6E6F6465406E6F686F73740000000A0000000000000000" +
        "5A0003770D6E6F6E6F6465406E6F686F7374000000000003610DB6D80003C89FE17A",
      "hex",
    );
    const control = readControl(new TermReader(octets.subarray(1)).term());
    expect(control.kind).toBe("monitor");
    if (control.kind !== "monitor") return;
    expect(control.to).toEqual(control.from);
    expect(write(writeControl(control))).toEqual(octets.subarray(1));
  });
  it("reads a cancelled watch, and the answer a watched process's end carries", () => {
    const ref = reference("robot@tomato", 7);
    expect(readControl(tuple(int(20), pid("robot@tomato"), atom("relay"), ref))).toEqual({
      kind: "demonitor",
      from: pid("robot@tomato"),
      to: atom("relay"),
      ref,
    });
    expect(readControl(tuple(int(21), atom("relay"), pid("robot@tomato"), ref, atom("normal")))).toEqual({
      kind: "monitorExit",
      from: atom("relay"),
      to: pid("robot@tomato"),
      ref,
      reason: atom("normal"),
    });
  });
  it("names an opcode this client does not act on, with its number", () => {
    // Group leader is a signal erts still speaks and this side does not act on.
    const items: Term[] = [int(7), pid("robot@tomato"), pid("posipaki@host")];
    expect(readControl(tuple(...items))).toEqual({ kind: "other", opcode: 7, items });
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
      { kind: "monitor", from: pid("robot@tomato"), to: pid("posipaki@host"), ref: reference("robot@tomato", 7) },
      { kind: "demonitor", from: pid("robot@tomato"), to: atom("relay"), ref: reference("robot@tomato", 7) },
      {
        kind: "monitorExit",
        from: atom("relay"),
        to: pid("robot@tomato"),
        ref: reference("robot@tomato", 7),
        reason: atom("noproc"),
      },
    ];
    for (const control of controls) expect(readControl(writeControl(control))).toEqual(control);
  });
  it("writes the five fields of a watch that ended, the ref the watcher minted included", () => {
    expect(
      writeControl({
        kind: "monitorExit",
        from: atom("relay"),
        to: pid("robot@tomato"),
        ref: reference("robot@tomato", 7),
        reason: atom("normal"),
      }),
    ).toEqual(tuple(int(21), atom("relay"), pid("robot@tomato"), reference("robot@tomato", 7), atom("normal")));
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
