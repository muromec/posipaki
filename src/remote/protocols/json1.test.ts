// ── json1 protocol tests ───────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { encode, decode, json1Channel, VERSION } from "./json1.js";
import { BAD_PREFIX_LIMIT, badReason, channelThrough, isProto, isInit, isState, isMsg, isExit } from "../channel.js";
import type { StringTransport } from "../channel.js";

/** As much of a transport as reading a frame needs: the handler the codec installs, and a way to
 *  call it the way a socket's `message` event does — which is the call an unreadable frame used to
 *  escape through, as an uncaught exception with nobody to catch it. */
function lineTransport() {
  let handler: ((line: string) => number | void) | null = null;
  let octets: ((bytes: Uint8Array) => void) | null = null;
  /** Everything this side wrote, lines and octets alike, in the order it was written. */
  const writes: Array<string | Uint8Array> = [];
  const linesWritten = (): string[] => writes.filter((w): w is string => typeof w === "string");
  const octetsWritten = (): Uint8Array[] => writes.filter((w): w is Uint8Array => typeof w !== "string");
  const transport: StringTransport = {
    send(frame) {
      writes.push(frame);
    },
    async sendBytes(bytes) {
      writes.push(bytes);
    },
    onMessage(h) {
      handler = h;
    },
    onBytes(h) {
      octets = h;
    },
    removeHandler() {
      handler = null;
    },
    onClose() {},
    async close() {},
  };
  return {
    transport,
    writes,
    linesWritten,
    octetsWritten,
    /** A line as the far side would send it; the answer is how many octets it announced. */
    deliver: (line: string) => handler!(line),
    /** The octets the far side sends after a line that announced them. */
    deliverBytes: (bytes: Uint8Array) => octets!(bytes),
  };
}

function readLines(lines: string[]): Record<string, unknown>[] {
  const { transport, deliver } = lineTransport();
  const frames: Record<string, unknown>[] = [];
  json1Channel(transport).onMessage((frame) => frames.push(frame));
  for (const line of lines) deliver(line);
  return frames;
}

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

describe("json1 channel readers", () => {
  it("hands every frame to every reader, and one reader leaving is not the others' business", () => {
    const { transport, deliver } = lineTransport();
    const channel = json1Channel(transport);
    const first: Record<string, unknown>[] = [];
    const second: Record<string, unknown>[] = [];
    const off = channel.onMessage((frame) => first.push(frame));
    channel.onMessage((frame) => second.push(frame));

    deliver(encode({ $proto: VERSION }));
    expect(first).toEqual([{ $proto: VERSION }]);
    expect(second).toEqual([{ $proto: VERSION }]);

    off();
    deliver(encode({ $state: { pings: 1 } }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("installs one handler on the transport, however many readers come and go", () => {
    // A transport holds one handler and reports a second one as a mistake, so a channel that let its
    // readers install their own would break the moment the first of them left.
    let installs = 0;
    let handler: ((line: string) => void) | null = null;
    const transport: StringTransport = {
      send() {},
      onMessage(h) {
        installs += 1;
        if (installs > 1) throw new Error("a transport holds one handler");
        handler = h;
      },
      removeHandler() {
        handler = null;
      },
      onBytes() {},
      sendBytes() {},
      onClose() {},
      async close() {},
    };
    const channel = json1Channel(transport);
    const seen: Record<string, unknown>[] = [];
    const off = channel.onMessage((frame) => seen.push(frame));
    off();
    channel.onMessage((frame) => seen.push(frame));

    expect(installs).toBe(1);
    handler!(encode({ $proto: VERSION }));
    expect(seen).toEqual([{ $proto: VERSION }]);
  });
});

describe("json1 reading a line", () => {
  it("hands a frame through as it is", () => {
    const [frame, ...rest] = readLines([encode({ $state: { pings: 1 } })]);
    expect(frame).toEqual({ $state: { pings: 1 } });
    expect(rest).toEqual([]);
  });

  it("reports a line that is not JSON instead of throwing at the transport", () => {
    // The throw would land in the transport's own callback — a socket's message event — where
    // nothing owns it: one unreadable frame would take the host process, and every other
    // connection in it, down.  What comes back instead is the frame that says so.
    const frames = readLines(["not json at all"]);
    expect(frames).toHaveLength(1);
    expect(badReason(frames[0])).toBeTruthy();
    expect(frames[0].$bad).toEqual({
      reason: expect.any(String),
      length: "not json at all".length,
      prefix: "not json at all",
    });
  });

  it("reports a line that is JSON but not a frame", () => {
    // Parsing is not framing: a document that is a number, a string, an array or null reads as a
    // frame further up (`"$init" in 7` throws) just as surely as a line that never parsed.
    const frames = readLines(["7", '"hello"', "[1,2]", "null"]);
    expect(frames.map(badReason)).toEqual([
      expect.stringContaining("a number"),
      expect.stringContaining("a string"),
      expect.stringContaining("an array"),
      expect.stringContaining("null"),
    ]);
    for (const frame of frames) {
      expect(typeof (frame.$bad as { reason: string }).reason).toBe("string");
    }
  });

  it("keeps a short head of what it could not read, and says how long it was", () => {
    const long = "x".repeat(500);
    const [frame] = readLines([long]);
    expect(frame.$bad).toEqual({
      reason: expect.any(String),
      length: 500,
      prefix: "x".repeat(BAD_PREFIX_LIMIT) + "…",
    });
  });

  it("says nothing more about a line than what it was", () => {
    // A line that failed to parse is the one line nobody vouched for: what it holds is not this
    // protocol's business, and must not be carried whole into a log, a transcript or a context.
    const secret = `token=${"s".repeat(80)}`;
    const [frame] = readLines([secret]);
    const kept = (frame.$bad as { prefix: string }).prefix;
    expect(kept.length).toBe(BAD_PREFIX_LIMIT + 1);
    expect(secret.startsWith(kept.slice(0, -1))).toBe(true);
  });
});

describe("a frame that carries octets", () => {
  const head = { $chunk: { id: 7, seq: 1, bytes: 4 } };

  it("gives the octets to the reader that asked, and the head to no frame reader", () => {
    const io = lineTransport();
    const channel = json1Channel(io.transport);
    const frames: Record<string, unknown>[] = [];
    const segments: Array<{ frame: Record<string, unknown>; bytes: Uint8Array }> = [];
    channel.onMessage((frame) => frames.push(frame));
    channel.onSegment!((frame, bytes) => segments.push({ frame, bytes }));

    // The answer to the line is the length the transport must then hand over.
    expect(io.deliver(encode(head))).toBe(4);
    io.deliverBytes(Buffer.from("abcd"));

    expect(segments).toHaveLength(1);
    expect(segments[0]!.frame).toEqual(head);
    expect(Buffer.from(segments[0]!.bytes).toString("utf8")).toBe("abcd");
    expect(frames).toEqual([]);
  });

  it("writes a segment as its line and then its octets", async () => {
    const io = lineTransport();
    const channel = json1Channel(io.transport);
    const bytes = Buffer.from([0x61, 0x0a, 0x62]);

    await channel.sendSegment!(head, bytes);

    expect(io.writes).toHaveLength(2);
    expect(io.writes[0]).toBe(encode(head));
    // Not a line, not encoded: the octets as they are, straight after the line that announced them.
    expect(io.writes[1]).toBe(bytes);
  });

  it("carries a run of no octets", () => {
    const io = lineTransport();
    const channel = json1Channel(io.transport);
    const segments: Uint8Array[] = [];
    channel.onSegment!((_frame, bytes) => segments.push(bytes));

    expect(io.deliver(encode({ $chunk: { id: 1, seq: 1, bytes: 0 } }))).toBe(0);
    io.deliverBytes(new Uint8Array(0));

    expect(segments).toHaveLength(1);
    expect(segments[0]!.length).toBe(0);
  });

  it("says so when octets arrive that no frame announced", () => {
    const io = lineTransport();
    const channel = json1Channel(io.transport);
    const frames: Record<string, unknown>[] = [];
    channel.onMessage((frame) => frames.push(frame));

    io.deliverBytes(Buffer.from("xy"));

    expect(frames).toHaveLength(1);
    expect(badReason(frames[0]!)).toContain("2 octets");
  });

  it("is a channel without segments when the transport is wrapped", async () => {
    // Every wrapper above a protocol goes through `channelThrough`, and a wrapped connection keeps
    // carrying what it carried: losing the octets there would kill a stream one layer above the wire.
    const io = lineTransport();
    const channel = json1Channel(io.transport);
    const wrapped = channelThrough(channel, () => false);
    const segments: number[] = [];
    wrapped.onSegment!((_frame, bytes) => segments.push(bytes.length));

    io.deliver(encode(head));
    io.deliverBytes(Buffer.from("abcd"));
    await wrapped.sendSegment!(head, Buffer.from("wxyz"));

    expect(segments).toEqual([4]);
    expect(io.octetsWritten()).toHaveLength(1);
  });
});
