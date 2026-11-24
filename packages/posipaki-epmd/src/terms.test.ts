// ── the external term format ───────────────────────────────────────────────
//
// Bytes in and terms out, and the other way round: the tags this file writes are the ones it must read back,
// and the fixtures below are what a running node actually sent.

import { describe, expect, it } from "vitest";

import {
  atom,
  binary,
  integer,
  pid,
  render,
  TermReader,
  tuple,
  list,
  map,
  type Term,
  write,
} from "./terms.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "utf8"));

/** One term, read out of the octets it encodes to. */
function read(encoded: Uint8Array): Term {
  return new TermReader(Buffer.from(encoded)).term();
}

describe("terms", () => {
  it("writes an atom in its short form, and a long one in its wide form", () => {
    expect([...write(atom("hi"))]).toEqual([119, 2, 0x68, 0x69]);
    expect([...write(atom("x".repeat(300))).subarray(0, 3)]).toEqual([118, 1, 0x2c]);
  });

  it("writes a small integer in one byte and a big one in five", () => {
    expect([...write(integer(6))]).toEqual([97, 6]);
    expect([...write(integer(70_000))]).toEqual([98, 0, 1, 0x11, 0x70]);
  });

  it("writes a binary with a four-byte length whatever its size", () => {
    expect([...write(binary(text("hi")))]).toEqual([109, 0, 0, 0, 2, 0x68, 0x69]);
  });

  it("writes a pid as its node, then its id, serial and creation", () => {
    const encoded = write(pid("n@h", 1, 0, 0x3039));
    expect([...encoded.subarray(0, 9)]).toEqual([88, 119, 3, 0x6e, 0x40, 0x68, 0, 0, 0]);
    expect([...encoded.subarray(9)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0x30, 0x39]);
  });

  it("reads back what it writes", () => {
    const written = write(tuple(integer(6), pid("posipaki@tomato", 1, 0, 12_345), atom("robot")));
    expect(read(written)).toEqual({
      kind: "tuple",
      items: [
        { kind: "int", value: 6 },
        { kind: "pid", node: "posipaki@tomato", id: 1, serial: 0, creation: 12_345 },
        { kind: "atom", name: "robot" },
      ],
    });
  });

  it("reads a send the node measured on the wire", () => {
    // {DOP_SEND, '', #PID<posipaki@tomato.1.0>}, from robot@tomato answering a message.
    const sent = bytes(
      131, 104, 3, 97, 2, 119, 0, 88, 119, 15, ...text("posipaki@tomato"), 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    );
    expect(read(sent.subarray(1))).toEqual({
      kind: "tuple",
      items: [
        { kind: "int", value: 2 },
        { kind: "atom", name: "" },
        { kind: "pid", node: "posipaki@tomato", id: 1, serial: 0, creation: 0 },
      ],
    });
  });

  it("reads a map and a string", () => {
    expect(read(bytes(116, 0, 0, 0, 1, 119, 1, 0x61, 97, 1))).toEqual({
      kind: "map",
      pairs: [[{ kind: "atom", name: "a" }, { kind: "int", value: 1 }]],
    });
    expect(read(bytes(107, 0, 3, 0x61, 0x62, 0x63))).toEqual({ kind: "string", value: "abc" });
  });

  it("names a tag it does not know, and where it stood", () => {
    expect(() => read(bytes(0xff))).toThrow("the term format tag 255 at byte 0 is not read by this script");
  });

  it("refuses a list that does not end in []", () => {
    expect(() => read(bytes(108, 0, 0, 0, 1, 97, 1, 97, 2))).toThrow("proper lists only");
  });

  it("refuses a binary whose last byte is partly used", () => {
    expect(() => read(bytes(77, 0, 0, 0, 1, 0x61, 7))).toThrow("7 of 8 bits");
  });

  it("prints a term the way the wire spells it", () => {
    expect(render({ kind: "tuple", items: [{ kind: "int", value: 2 }, { kind: "atom", name: "robot" }] })).toBe(
      "{2, robot}",
    );
  });
});
