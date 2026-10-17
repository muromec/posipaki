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
  StdioWireError,
  clientChannel,
  errorFrame,
  errorReason,
  fdStreams,
  serverChannel,
  type LineStreams,
} from "./stdio.js";
import { outputFrame, outputOf } from "./channel.js";
import { stderrSink, withOutput } from "./output.js";
import { json1Channel, VERSION } from "./protocols/json1.js";

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
    expect(outputOf(outputFrame(1, "hi"))).toEqual({ fd: 1, data: "hi" });
    expect(outputOf(outputFrame(2, ""))).toEqual({ fd: 2, data: "" });
  });

  it("leaves protocol frames and rubbish alone", () => {
    expect(outputOf({ $proto: "json.v1" })).toBeNull();
    expect(outputOf({ $fd: 3, data: "out of range" })).toBeNull();
    expect(outputOf({ $fd: "1", data: "a stream is a number" })).toBeNull();
  });

  it("stringifies a payload that is not a string rather than losing it", () => {
    expect(outputOf({ $fd: 1, data: { a: 1 } })).toEqual({ fd: 1, data: '{"a":1}' });
  });

  it("carries a reason", () => {
    expect(errorReason(JSON.parse(errorFrame("no runtime in there")))).toBe("no runtime in there");
    expect(errorReason({ $proto: "json.v1" })).toBeNull();
  });
});

describe("withOutput", () => {
  it("takes the far end's own output off, and passes every other frame through", async () => {
    const [left, right] = wirePair();
    const output: Array<[number, string]> = [];
    const connection = withOutput(json1Channel(new LineTransport(right)), (fd, data) =>
      output.push([fd, data]),
    );

    const arrived = new Promise<Record<string, unknown>>((resolve) => connection.onMessage(resolve));
    const far = json1Channel(new LineTransport(left));
    await far.send(outputFrame(1, "chatter"));
    await far.send({ $proto: "json.v1" });

    expect(await arrived).toEqual({ $proto: "json.v1" });
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

  it("reads past the far end's own output while it waits for the protocol", async () => {
    const [a, b] = wirePair();
    const output: Array<[number, string]> = [];
    const started = clientChannel(a, { onOutput: (fd, data) => output.push([fd, data]) });
    const far = new LineTransport(b);
    await far.send(JSON.stringify(outputFrame(1, "before the handshake")));
    await far.send(JSON.stringify({ $proto: VERSION }));

    const client = await started;
    expect(output).toEqual([[1, "before the handshake"]]);
    await client.close();
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

describe("stdio wire, octets", () => {
  it("carries the octets a line announced, and reads lines again after them", async () => {
    const [left, right] = wirePair();
    const a = new LineTransport(left);
    const b = new LineTransport(right);
    const lines: string[] = [];
    let carry = 0;
    const heard = new Promise<Uint8Array>((resolve) => {
      b.onBytes(resolve);
    });
    const after = new Promise<string>((resolve) => {
      b.onMessage((line) => {
        lines.push(line);
        if (line.startsWith('{"$chunk"')) {
          carry = 6;
          return carry;
        }
        resolve(line);
      });
    });

    await a.send('{"$chunk":{"bytes":6}}');
    // A line ending and a carriage return inside the run: octets are not text and are not split.
    await a.sendBytes(Buffer.from([0x61, 0x0a, 0x62, 0x0d, 0x0a, 0x63]));
    await a.send('{"tail":true}');

    expect(Buffer.from(await heard)).toEqual(Buffer.from([0x61, 0x0a, 0x62, 0x0d, 0x0a, 0x63]));
    expect(await after).toBe('{"tail":true}');
    expect(lines).toEqual(['{"$chunk":{"bytes":6}}', '{"tail":true}']);
    await a.close();
    await b.close();
  });
});
