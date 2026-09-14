// ── stdio wire tests ───────────────────────────────────────────────────────
//
// The wire is a pair of streams; two PassThroughs say more about it than a real
// process would.  The fd path gets one test of its own at the end.

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { execSync } from "node:child_process";
import { constants, openSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineTransport,
  OutputFilter,
  StdioWireError,
  clientChannel,
  errorFrame,
  errorReason,
  fdStreams,
  outputFrame,
  parseOutputFrame,
  serverChannel,
  stderrSink,
  type LineStreams,
} from "./stdio.js";

/** Two ends of one wire: what one end writes, the other reads. */
function wirePair(): [LineStreams, LineStreams] {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  return [
    { read: rightToLeft, write: leftToRight },
    { read: leftToRight, write: rightToLeft },
  ];
}

/** The next line to arrive. */
function nextLine(transport: LineTransport): Promise<string> {
  return new Promise((resolve) => transport.onMessage(resolve));
}

describe("LineTransport", () => {
  it("carries a frame from one end to the other", async () => {
    const [left, right] = wirePair();
    const from = new LineTransport(left);
    const to = new LineTransport(right);

    const arrived = nextLine(to);
    await from.send("hello");
    expect(await arrived).toBe("hello");
  });

  it("refuses a second handler", () => {
    const [left] = wirePair();
    const transport = new LineTransport(left);
    transport.onMessage(() => {});
    expect(() => transport.onMessage(() => {})).toThrow(StdioWireError);
  });

  it("closes twice without complaining, and is closed afterwards", async () => {
    const [left] = wirePair();
    const transport = new LineTransport(left);

    await transport.close();
    await transport.close();
    expect(transport.closed).toBe(true);
    await expect(transport.send("late")).resolves.toBeUndefined();
    expect(() => transport.onMessage(() => {})).toThrow(StdioWireError);
  });

  it("treats a write into a peer that hung up as done, not as an error", async () => {
    const [left] = wirePair();
    const transport = new LineTransport(left);

    const gone = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    left.write.destroy(gone);

    await expect(transport.send("into the void")).resolves.toBeUndefined();
  });
});

describe("output frames", () => {
  it("reads back what it writes", () => {
    expect(parseOutputFrame(outputFrame(1, "hi"))).toEqual({ fd: 1, data: "hi" });
    expect(parseOutputFrame(outputFrame(2, ""))).toEqual({ fd: 2, data: "" });
  });

  it("leaves protocol traffic and rubbish alone", () => {
    expect(parseOutputFrame('{"$proto":"json.v1"}')).toBeNull();
    expect(parseOutputFrame("not json at all")).toBeNull();
    expect(parseOutputFrame('{"$fd":3,"data":"out of range"}')).toBeNull();
    expect(parseOutputFrame('{"$fd":1')).toBeNull();
  });

  it("stringifies a payload that is not a string rather than losing it", () => {
    expect(parseOutputFrame('{"$fd":1,"data":{"a":1}}')).toEqual({ fd: 1, data: '{"a":1}' });
  });

  it("carries a reason", () => {
    expect(errorReason(JSON.parse(errorFrame("no runtime in there")))).toBe("no runtime in there");
    expect(errorReason({ $proto: "json.v1" })).toBeNull();
  });
});

describe("OutputFilter", () => {
  it("lifts output frames out and passes the rest through", async () => {
    const [left, right] = wirePair();
    const output: Array<[number, string]> = [];
    const filtered = new OutputFilter(new LineTransport(right), (fd, data) =>
      output.push([fd, data]),
    );

    const arrived = new Promise<string>((resolve) => filtered.onMessage(resolve));
    const peer = new LineTransport(left);
    await peer.send(outputFrame(1, "chatter"));
    await peer.send('{"$proto":"json.v1"}');

    expect(await arrived).toBe('{"$proto":"json.v1"}');
    expect(output).toEqual([[1, "chatter"]]);
  });
});

describe("stderrSink", () => {
  it("tags the far end's output with its name, and its errors as errors", () => {
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const sink = stderrSink("env");
      sink(1, "one\ntwo");
      sink(2, "bad");
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toBe("[env] one\n[env] two\n[env] err: bad\n");
  });
});

describe("handshakes", () => {
  it("the two ends of a session find each other", async () => {
    const [a, b] = wirePair();
    // Order matters: the client's handler is in place before the peer speaks,
    // because a line with no handler is a line nobody wanted.
    const started = clientChannel(a, { onOutput: () => {} });
    const server = await serverChannel(b);
    const client = await started;

    const arrived = new Promise<Record<string, unknown>>((resolve) => server.onMessage(resolve));
    await client.send({ $msg: { fromName: "whoever", body: {} } });
    expect(await arrived).toEqual({ $msg: { fromName: "whoever", body: {} } });
  });

  it("reports a failed start as its reason", async () => {
    const [a, b] = wirePair();
    const started = clientChannel(a, { onOutput: () => {} });
    await new LineTransport(b).send(errorFrame("no runtime in there"));
    await expect(started).rejects.toThrow("no runtime in there");
  });

  it("refuses a protocol it does not speak", async () => {
    const [a, b] = wirePair();
    const started = clientChannel(a, { onOutput: () => {} });
    await new LineTransport(b).send(JSON.stringify({ $proto: "json.v9" }));
    await expect(started).rejects.toThrow(/unsupported protocol json.v9/);
  });

  it("refuses a first frame that is not a protocol frame", async () => {
    const [a, b] = wirePair();
    const started = clientChannel(a, { onOutput: () => {} });
    await new LineTransport(b).send(JSON.stringify({ $state: {} }));
    await expect(started).rejects.toThrow(/unexpected first frame/);
  });

  it("gives up waiting for a peer that never speaks", async () => {
    const [a] = wirePair();
    await expect(clientChannel(a, { onOutput: () => {}, timeoutMs: 20 })).rejects.toThrow(
      /no protocol frame within 20ms/,
    );
  });
});

describe("fd streams", () => {
  it("carries frames over private fds", async () => {
    const base = join(tmpdir(), `posipaki-stdio-${Math.random().toString(36).slice(2)}`);
    const toLeft = `${base}.to-left`;
    const toRight = `${base}.to-right`;
    execSync(`mkfifo "${toLeft}" "${toRight}"`);
    // One fifo per direction, opened read-write: a holder never sees end of
    // stream, and no open blocks waiting for the other end to arrive.
    const leftRead = openSync(toLeft, constants.O_RDWR);
    const leftWrite = openSync(toRight, constants.O_RDWR);
    const rightRead = openSync(toRight, constants.O_RDWR);
    const rightWrite = openSync(toLeft, constants.O_RDWR);
    try {
      const left = new LineTransport(fdStreams(leftRead, leftWrite));
      const right = new LineTransport(fdStreams(rightRead, rightWrite));

      const arrived = nextLine(right);
      await left.send("over real fds");
      expect(await arrived).toBe("over real fds");

      // The transports own these fds: they were handed to the streams, and a
      // runtime closes them on teardown even with `autoClose: false`.  Closing
      // them here as well races that, so the test lets go.
      await left.close();
      await right.close();
    } finally {
      await unlink(toLeft).catch(() => {});
      await unlink(toRight).catch(() => {});
    }
  });
});
