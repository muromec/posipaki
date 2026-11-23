// ── what a frame says ──────────────────────────────────────────────────────
//
// The fixtures are octets a running node sent: OTP 29, `robot@tomato`, started with -sname and -setcookie. What
// this file reads has to be what that node wrote.

import { describe, expect, it } from "vitest";

import { memoryChannelPair } from "posipaki/port";
import { decode, encode, withMeaning, type WireMessage } from "./messages.js";


const hex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));

describe("decode", () => {
  it("reads a status, refused and accepted", () => {
    expect(decode(hex("736e6f745f616c6c6f776564"))).toEqual({ kind: "status", status: "not_allowed" });
    expect(decode(hex("736f6b"))).toEqual({ kind: "status", status: "ok" });
  });

  it("reads the challenge the node asked with", () => {
    expect(decode(hex("4e0000006d07df7fbd62fd6bfe6b04a540000c726f626f7440746f6d61746f"))).toEqual({
      kind: "challenge",
      flags: [0x6d, 0x07df7fbd],
      challenge: 0x62fd6bfe,
      creation: 0x6b04a540,
      name: "robot@tomato",
    });
  });

  it("reads the ack that closed the handshake", () => {
    expect(decode(hex("61fdf236f34e5a402d9994f5a574530e49"))).toEqual({
      kind: "ack",
      digest: hex("fdf236f34e5a402d9994f5a574530e49"),
    });
  });

  it("reads a distribution message as its control and the message after it", () => {
    // {DOP_SEND, '', #PID<posipaki@tomato.1.0>} and <<"hello robot">>, as robot@tomato sent them.
    const said = decode(
      hex(
        "708368036102770058770f706f736970616b6940746f6d61746f00000001000000005bc4a774" +
          "836d0000000b68656c6c6f20726f626f74",
      ),
    );
    expect(said).toEqual({
      kind: "message",
      control: {
        kind: "send",
        to: { kind: "pid", node: "posipaki@tomato", id: 1, serial: 0, creation: 0x5bc4a774 },
      },
      payload: { kind: "binary", bytes: Buffer.from("hello robot", "utf8") },
    });
  });

  it("names the first byte it has no message for", () => {
    expect(() => decode(new Uint8Array([0x99]))).toThrow("the first byte 153 names no message");
  });

  it("refuses a frame that carried nothing", () => {
    expect(() => decode(new Uint8Array(0))).toThrow("a frame carried nothing");
  });
});

describe("encode", () => {
  it("writes what decode reads back, for every message this side sends", () => {
    const messages: WireMessage[] = [
      { kind: "challenge", flags: [0x6d, 0x7df7fbd], challenge: 99, creation: 8, name: "robot@tomato" },
      { kind: "status", status: "ok" },
      { kind: "reply", challenge: 99, digest: hex("00112233445566778899aabbccddeeff") },
      { kind: "ack", digest: hex("ffeeddccbbaa99887766554433221100") },
      {
        kind: "message",
        control: { kind: "regSend", from: { kind: "int", value: 1 }, to: "robot" },
        payload: { kind: "tuple", items: [{ kind: "binary", bytes: Buffer.from([1, 2]) }] },
      },
    ];
    for (const message of messages) expect(decode(encode(message))).toEqual(message);
  });

  it("writes a name that the other reading reads back", () => {
    const written = encode({ kind: "name", flags: [0x4, 0x1], creation: 7, name: "posipaki@host" });
    expect(decode(written, "acceptor")).toEqual({ kind: "name", flags: [0x4, 0x1], creation: 7, name: "posipaki@host" });
  });

  it("writes a message with no payload as one term", () => {
    const written = encode({
      kind: "message",
      control: { kind: "send", to: { kind: "atom", name: "" } },
      payload: null,
    });
    expect(written[0]).toBe(0x70);
    expect(written[1]).toBe(131);
    expect(decode(written)).toEqual({
      kind: "message",
      control: { kind: "send", to: { kind: "atom", name: "" } },
      payload: null,
    });
  });
});

describe("the other side of a connection", () => {
  it("reads the same 'N' as a name, and a status as a status either way", () => {
    const name = encode({ kind: "name", flags: [0x4, 0], creation: 5, name: "posipaki@host" });
    expect(decode(name, "acceptor")).toEqual({ kind: "name", flags: [0x4, 0], creation: 5, name: "posipaki@host" });
    expect(decode(hex("736f6b"), "acceptor")).toEqual({ kind: "status", status: "ok" });
  });

  it("reads a name as a challenge when the wrong side reads it, and says so with nonsense", () => {
    // The same octets, and a name that is not the one the frame carried: this is why the side is a parameter.
    const name = encode({ kind: "name", flags: [0x4, 0], creation: 5, name: "posipaki@host" });
    const asChallenge = decode(name, "initiator");
    expect(asChallenge.kind).toBe("challenge");
    expect(asChallenge.kind === "challenge" ? asChallenge.name : "posipaki@host").not.toBe("posipaki@host");
  });
});

describe("withMeaning", () => {
  it("writes one end of a memory pair and reads the other, both ways", async () => {
    const ends = memoryChannelPair<Uint8Array>();
    const here = withMeaning(ends.near);
    const there = withMeaning(ends.far);
    const said = new Promise<WireMessage>((resolve) => there.onFrame(resolve));
    await here.send({ kind: "status", status: "ok" });
    expect(await said).toEqual({ kind: "status", status: "ok" });

    const back = new Promise<WireMessage>((resolve) => here.onFrame(resolve));
    await there.send({ kind: "ack", digest: hex("00112233445566778899aabbccddeeff") });
    expect(await back).toEqual({ kind: "ack", digest: hex("00112233445566778899aabbccddeeff") });
  });
});
