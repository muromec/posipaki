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
  const args = gatewayArgs({ hostVersion: HOST, worker: PAYLOAD, ...boot });
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
    const boot: GatewayBoot = { hostVersion: HOST, worker: "/k/payload.js" };
    expect(gatewayBoot(gatewayArgs(boot))).toEqual(boot);
  });

  it("carries the host version verbatim: it neither reads nor judges the string", () => {
    const boot: GatewayBoot = { hostVersion: "not-a-host-version-at-all", worker: "w" };
    expect(gatewayBoot(gatewayArgs(boot))).toEqual(boot);
    expect(gatewayArgs(boot)).toEqual(["w", "--host-version=not-a-host-version-at-all"]);
  });

  it("passes nothing when it was given nothing", () => {
    // A caller that states no host version — the only case where a payload has none of its
    // own to check — builds an argv with no flag, and reads none back.  The gateway does not
    // invent a placeholder: what nobody said is not its to fill in.
    expect(gatewayArgs({ worker: "w" })).toEqual(["w"]);
    expect(gatewayBoot(["w"])).toEqual({ worker: "w" });
  });

  it("refuses to start without a payload", () => {
    expect(() => gatewayBoot(["--host-version=x"])).toThrow(/no <payload>/);
  });

  it("has no door of its own: `--version` is just an argument the payload may read", () => {
    expect(gatewayBoot(["w", "--version"])).toEqual({ worker: "w" });
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

  it("turns a payload that dies before its channel into a reason", async () => {
    const args = gatewayArgs({ hostVersion: HOST, worker: GIVES_UP });
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
