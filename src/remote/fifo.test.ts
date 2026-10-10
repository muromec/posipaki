// ── a fifo pair: a listener and a client ───────────────────────────────────
//
// Real named pipes in a scratch directory, because the whole of this medium is how the two ends open them:
// a fake would test the fiction rather than the open order.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineActor, defineMessages } from "../index.js";
import { isMsg, isState } from "./channel.js";
import { fifoClientSpawner, fifoListener, makeFifoPair, type FifoPair } from "./fifo.js";
import { rootIdFor } from "./process-ref.js";
import { reactor, type Session } from "./reactor.js";
import { sleep } from "../util.js";

const ROOT = rootIdFor("even");
const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "posipaki-fifo-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(1);
  }
}

function makeEcho() {
  return defineActor({
    name: "echo",
    inMessages: defineMessages<{ type: "PING"; count: number }>(),
    outMessages: defineMessages<{ type: "PONG"; count: number }>(),
    setup: () => ({ pings: 0 }),
    handlers: {
      async PING(msg: { type: "PING"; count: number }) {
        this.state.pings += 1;
        await this.emit({ type: "PONG", count: msg.count });
      },
    },
  });
}

function pairIn(dir: string): FifoPair {
  return { read: join(dir, "in"), write: join(dir, "out") };
}

describe("fifoListener", () => {
  it("makes the pair, serves the client that connects to it, and reports the process", async () => {
    const dir = await scratch();
    const pair = pairIn(dir);
    const listener = await fifoListener(pair, { identify: () => ({ who: "the client" }) });
    const sessions: Session<{ who: string }>[] = [];
    const r = reactor(listener, makeEcho(), { onSession: (session) => sessions.push(session) });

    const channel = await fifoClientSpawner<{ pair: FifoPair }>((args) => args.pair)({ pair });
    await channel.send({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });
    await waitUntil(() => sessions.length === 1, "the session report");
    expect(sessions[0]!.meta).toEqual({ who: "the client" });
    expect(sessions[0]!.proc.pname).toBe("echo");

    const heard: Record<string, unknown>[] = [];
    channel.onMessage((frame) => heard.push(frame));
    await channel.send({ to: ROOT, $tune: { streams: ["message", "state"] } });
    await waitUntil(() => heard.some(isState), "the initial state");
    await channel.send({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 5 } } });
    await waitUntil(() => heard.some(isMsg), "the reply");
    expect(heard.find(isMsg)!.$msg).toMatchObject({ body: { type: "PONG", count: 5 } });

    await r.stop();
  });

  it("carries one connection per lifetime", async () => {
    const dir = await scratch();
    const pair = pairIn(dir);
    const listener = await fifoListener(pair);
    const r = reactor(listener, makeEcho());

    const channel = await fifoClientSpawner<{ pair: FifoPair }>((args) => args.pair)({ pair });
    await channel.send({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });

    const again = listener.accept().then(
      () => "taken twice",
      (error: Error) => error.message,
    );
    expect(await again).toMatch(/one connection per lifetime/);

    await r.stop();
  });

  it("releases a wait that is parked on the pair when it closes", async () => {
    const dir = await scratch();
    const pair = pairIn(dir);
    const listener = await fifoListener(pair);

    const parked = listener.accept().then(
      () => "a connection arrived",
      (error: Error) => error.message,
    );
    await listener.close();

    expect(await parked).toMatch(/closed while waiting/);
  });

  it("refuses a path that is not a fifo", async () => {
    const dir = await scratch();
    const pair = pairIn(dir);
    await writeFile(pair.read, "a regular file");

    await expect(makeFifoPair(pair)).rejects.toThrow(/is not a fifo/);
  });
});
