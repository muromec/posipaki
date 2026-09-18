// ── Gateway tests ──────────────────────────────────────────────────────────
//
// The gateway is a process, so the tests run the process: the real entry point,
// a fixture payload, and a client that speaks the wire to it.  No ssh, no
// container, no host.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATEWAY_FAILED, gatewayArgs, gatewayBoot } from "./gateway.js";
import type { GatewayBoot } from "./gateway.js";
import { hostVersion } from "./kit.js";
import type { Channel } from "./channel.js";
import { clientChannel } from "./stdio.js";
import type { LineStreams } from "./stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The program under test: this file's sibling, under our own extension. */
const GATEWAY = join(HERE, `gateway-cli${extname(fileURLToPath(import.meta.url)) || ".js"}`);
const PAYLOAD = join(HERE, "fixtures", "echo-payload.js");
const GIVES_UP = join(HERE, "fixtures", "give-up.js");
const SAYS_ARGV = join(HERE, "fixtures", "argv-payload.js");
const APP = { name: "test-app", version: "1.2.3" };
const HOST = hostVersion(APP);

interface Session {
  child: ChildProcess;
  channel: Channel;
  output: Array<[number, string]>;
  exit: Promise<number | null>;
}

/** Start the gateway the way a client does, and speak the wire to it. */
async function session(boot: Partial<GatewayBoot> = {}): Promise<Session> {
  const args = gatewayArgs({ passthrough: [`--host-version=${HOST}`], worker: PAYLOAD, ...boot });
  const child = spawn(process.execPath, [GATEWAY, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: Array<[number, string]> = [];
  const exit = new Promise<number | null>((settle) => child.once("exit", (code) => settle(code)));
  const streams = { read: child.stdout!, write: child.stdin! } as LineStreams;
  const channel = await clientChannel(streams, {
    onOutput: (fd, data) => output.push([fd, data]),
    timeoutMs: 20_000,
  });
  return { child, channel, output, exit };
}

/** Let a session go, whatever state it is in. */
async function stop(session: Session): Promise<void> {
  session.channel.close().catch(() => {});
  if (session.child.exitCode === null) session.child.kill();
  await session.exit;
}

describe("gateway boot", () => {
  it("reads back the argv it builds", () => {
    const boot: GatewayBoot = {
      passthrough: [`--host-version=${HOST}`, "--env=agent", "positional"],
      worker: "/k/payload.js",
    };
    expect(gatewayBoot(gatewayArgs(boot))).toEqual(boot);
  });

  it("owns no flag: it passes everything after the payload through, itself included", () => {
    // The host version is the client's argument like any other.  The gateway neither reads it
    // nor knows there is anything to read — which is why a caller's argument that looks like
    // one of ours cannot be eaten, re-ordered or re-spelled on the way to the payload.
    const args = gatewayArgs({
      passthrough: [
        "--host-version=not-a-host-version-at-all",
        "--env=agent",
        "positional",
        "--nonsense",
        "-x",
        "positional",
      ],
      worker: "w",
    });
    expect(args).toEqual([
      "w",
      "--host-version=not-a-host-version-at-all",
      "--env=agent",
      "positional",
      "--nonsense",
      "-x",
      "positional",
    ]);
    expect(gatewayBoot(args).passthrough).toEqual([
      "--host-version=not-a-host-version-at-all",
      "--env=agent",
      "positional",
      "--nonsense",
      "-x",
      "positional",
    ]);
  });

  it("passes nothing when it was given nothing", () => {
    // A caller that states no host version — the one case where the payload has none to check
    // its own bytes against — builds a line with no flag, and reads none back.  The gateway
    // does not invent a placeholder: what nobody said is not its to fill in.
    expect(gatewayArgs({ passthrough: [], worker: "w" })).toEqual(["w"]);
    expect(gatewayBoot(["w"])).toEqual({ passthrough: [], worker: "w" });
  });

  it("refuses to start without a payload", () => {
    expect(() => gatewayBoot(["--host-version=x"])).toThrow(/no <payload>/);
  });

  it("has no door of its own: a `--version` is just an argument the payload ends up with", () => {
    expect(gatewayBoot(["w", "--version"])).toEqual({ passthrough: ["--version"], worker: "w" });
  });
});

describe("gateway", () => {
  it("carries the payload's handshake and its chatter", async () => {
    const running = await session();
    try {
      // The handshake is why the session exists at all; the payload's own stdout
      // travels as an output frame, not as protocol.
      const sent = new Promise<Record<string, unknown>>((resolve) => running.channel.onMessage(resolve));
      await running.channel.send({ $msg: { body: { echo: "hi" } } });
      expect(await sent).toEqual({ $msg: { fromName: "payload", body: { echo: "hi" } } });
      expect(running.output).toContainEqual([1, "payload alive\n"]);
    } finally {
      await stop(running);
    }
  });

  it("relays frames both ways, more than once", async () => {
    const running = await session();
    try {
      for (const word of ["one", "two", "three"]) {
        const sent = new Promise<Record<string, unknown>>((resolve) =>
          running.channel.onMessage(resolve),
        );
        await running.channel.send({ $msg: { body: { echo: word } } });
        expect(await sent).toEqual({ $msg: { fromName: "payload", body: { echo: word } } });
        running.channel.removeHandler();
      }
    } finally {
      await stop(running);
    }
  });

  it("ends when the payload ends, and says how", async () => {
    const running = await session();
    try {
      const last = new Promise<Record<string, unknown>>((resolve) => running.channel.onMessage(resolve));
      await running.channel.send({ $msg: { body: { type: "BYE" } } });
      expect(await last).toEqual({ $exit: { code: 0, state: { echoed: true } } });
      expect(await running.exit).toBe(0);
    } finally {
      await stop(running);
    }
  });

  it("hands the payload the caller's own arguments, and the fifos last", async () => {
    const args = gatewayArgs({
      passthrough: [`--host-version=${HOST}`, "--env=agent", "positional", "--host-version=theirs"],
      worker: SAYS_ARGV,
    });
    const child = spawn(process.execPath, [GATEWAY, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((settle) => child.once("exit", (code) => settle(code)));
    const said: string[] = [];
    try {
      const streams = { read: child.stdout!, write: child.stdin! } as LineStreams;
      await expect(
        clientChannel(streams, {
          onOutput: (_fd, chunk) => said.push(chunk),
          timeoutMs: 20_000,
        }),
      ).rejects.toThrow(/exited with code 2 before it opened its channel/);

      // What the payload was actually started with: the gateway's own flag, then the caller's
      // arguments in the order and the spelling they were given, then the fifo pair the
      // gateway made — appended last, because they are its own addition to the line.
      const argv = JSON.parse(said.join("")) as string[];
      expect(argv.slice(0, 4)).toEqual([
        `--host-version=${HOST}`,
        "--env=agent",
        "positional",
        "--host-version=theirs",
      ]);
      expect(argv.slice(4).map((arg) => arg.split("=")[0])).toEqual(["--fifo-in", "--fifo-out"]);
    } finally {
      if (child.exitCode === null) child.kill();
      await exit;
    }
  });

  it("turns a payload that dies before its channel into a reason", async () => {
    const args = gatewayArgs({ passthrough: [`--host-version=${HOST}`], worker: GIVES_UP });
    const child = spawn(process.execPath, [GATEWAY, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((settle) => child.once("exit", (code) => settle(code)));
    try {
      const streams = { read: child.stdout!, write: child.stdin! } as LineStreams;
      await expect(clientChannel(streams, { onOutput: () => {}, timeoutMs: 20_000 })).rejects.toThrow(
        /exited with code 2 before it opened its channel/,
      );
      expect(await exit).toBe(GATEWAY_FAILED);
    } finally {
      if (child.exitCode === null) child.kill();
      await exit;
    }
  });
});
