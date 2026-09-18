// ── The payload's door: what it is asked for, and what it is ────────────────
//
// The check is a decision taken before anything is opened, so the test takes it where it is
// taken: argv in, exit code and reason out, with no fifo, no wire and no second process.  What
// a real start looks like end to end is the gateway's own test's business.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../channel.js";
import { decode, VERSION } from "../protocols/json1.js";
import { FifoUtf8NlineTransport } from "../transports/fifo.js";
import { PAYLOAD_REFUSED, hostVersion } from "../kit.js";
import { fifoArgvSpawner } from "./fifo-argv.js";

const OWN = hostVersion({ name: "test-app", version: "1.2.3" });
const OTHER = hostVersion({ name: "test-app", version: "1.2.4" });

/** What a mocked exit throws, so the caller's flow stops exactly where the process would. */
class Exited extends Error {}

/** How a start ended: with our refusal, with the environment's own answer, or not at all. */
interface Ending {
  refused: boolean;
  message: string;
}

let argv: string[];
let said: string[];
let codes: number[];

beforeEach(() => {
  argv = [...process.argv];
  said = [];
  codes = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    said.push(String(line));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    codes.push(code ?? 0);
    throw new Exited("exit");
  }) as never);
});

afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

/**
 * Start the payload with these arguments, and say how it ended — or hand back the channel it
 * served on, when it got that far.
 */
async function serve(own: string | undefined, args: string[]): Promise<Ending & { channel?: Channel }> {
  process.argv = ["node", "payload.js", ...args];
  try {
    const channel = await fifoArgvSpawner(own);
    return { refused: false, message: "served", channel };
  } catch (err) {
    return {
      refused: err instanceof Exited,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("the payload's door", () => {
  it("refuses another build, before it opens anything", async () => {
    // The fifos are nonsense on purpose: a payload that checked its version *after*
    // connecting would fail on them instead, and say the wrong thing.
    const ending = await serve(OWN, [
      `--host-version=${OTHER}`,
      "--fifo-in=/nowhere/in",
      "--fifo-out=/nowhere/out",
    ]);
    expect(ending.refused).toBe(true);
    expect(codes).toEqual([PAYLOAD_REFUSED]);
    expect(said.join("\n")).toContain(`asked to serve ${OTHER}`);
    expect(said.join("\n")).toContain(OWN);
  });

  it("refuses a start that names no version, when its own bytes carry one", async () => {
    const ending = await serve(OWN, ["--fifo-in=/nowhere/in", "--fifo-out=/nowhere/out"]);
    expect(ending.refused).toBe(true);
    expect(codes).toEqual([PAYLOAD_REFUSED]);
    expect(said.join("\n")).toContain("no host version was asked for");
    expect(said.join("\n")).toContain(OWN);
  });

  it("serves an artifact that carries no version, whatever the caller says", async () => {
    // Nothing to compare against, so the caller's version is not ours to judge: the start
    // goes on and fails where it really fails — on the fifos.
    for (const args of [[], [`--host-version=${OWN}`]]) {
      codes = [];
      said = [];
      const ending = await serve(undefined, [...args, "--fifo-in=/nowhere/in"]);
      expect(ending.refused).toBe(true);
      expect(codes).toEqual([1]);
      expect(said.join("\n")).toContain("--fifo-in=<path> and --fifo-out=<path> required");
    }
  });

  it("serves the version it was asked for, and speaks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "posipaki-fifo-argv-"));
    const fifoIn = join(dir, "in");
    const fifoOut = join(dir, "out");
    try {
      // The peer is the gateway: it reads what the payload writes and writes what it reads.
      for (const path of [fifoIn, fifoOut]) execSync(`mkfifo "${path}"`);
      const gateway = FifoUtf8NlineTransport.beginConnect(fifoIn, fifoOut).transport;

      const ending = await serve(OWN, [
        `--host-version=${OWN}`,
        `--fifo-in=${fifoIn}`,
        `--fifo-out=${fifoOut}`,
      ]);
      const { channel } = ending;
      expect(ending.message).toBe("served");
      expect(typeof channel?.send).toBe("function");
      expect(codes).toEqual([]);

      // Past the door and connected: what arrives first is the payload's own handshake.
      const line = await new Promise<string>((resolve) => {
        void gateway.then((peer) => peer.onMessage(resolve));
      });
      expect(decode(line)).toEqual({ $proto: VERSION });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
