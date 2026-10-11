// ── the unix socket: a listener and a client ───────────────────────────────
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineActor, defineMessages } from "../index.js";
import { isMsg, isState } from "./channel.js";
import { rootIdFor } from "./process-ref.js";
import { reactor, type ServedConnection, type Session } from "./reactor.js";
import { connectUnixSocket, unixSocketListener } from "./socket.js";
import { socketClientSpawner } from "./spawners/socket-client.js";
import { sleep } from "../util.js";

const ROOT = rootIdFor("even");
const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "posipaki-socket-"));
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

describe("unixSocketListener", () => {
  it("binds a path, serves a client over it, and hands the reactor the process", async () => {
    const dir = await scratch();
    const path = join(dir, "service.sock");
    const listener = await unixSocketListener({ path, identify: () => ({ who: "the client" }) });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const sessions: Session<{ who: string }>[] = [];
    const r = reactor(listener, makeEcho(), { onSession: (session) => sessions.push(session) });

    const channel = await socketClientSpawner<{ path: string }>((args) => args.path)({ path });
    await channel.send({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });
    await waitUntil(() => sessions.length === 1, "the session report");
    expect(sessions[0]!.meta).toEqual({ who: "the client" });
    expect(sessions[0]!.proc.pname).toBe("echo");

    const heard: Record<string, unknown>[] = [];
    channel.onMessage((frame) => heard.push(frame));
    await channel.send({ to: ROOT, $tune: { streams: ["message", "state"] } });
    await waitUntil(() => heard.some(isState), "the initial state");
    expect(heard.find(isState)!.$state).toEqual({ pings: 0 });

    await channel.send({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 7 } } });
    await waitUntil(() => heard.some(isMsg), "the reply");
    expect(heard.find(isMsg)!.$msg).toMatchObject({ body: { type: "PONG", count: 7 } });

    await r.stop();
    // The listener removed the socket file it made.
    await expect(stat(path)).rejects.toThrow();
  });

  it("refuses a path that is not a socket", async () => {
    const dir = await scratch();
    const path = join(dir, "not-a-socket");
    await writeFile(path, "a regular file");

    await expect(unixSocketListener({ path })).rejects.toThrow(/is not a socket/);
  });

  it("replaces a socket nobody listens on, and refuses a live one", async () => {
    const dir = await scratch();
    const path = join(dir, "service.sock");

    // A leftover of the kind a crash leaves: a process binds the path and is killed before it can unlink.
    const script = join(dir, "bind.js");
    await writeFile(script, 'import net from "node:net";\nnet.createServer().listen(process.argv[2]);\n');
    const child = spawn(process.execPath, [script, path], { stdio: "ignore" });
    await waitUntil(() => existsSync(path), "the socket the child bound");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect((await stat(path)).isSocket()).toBe(true);

    const replaced = await unixSocketListener({ path });
    await expect(unixSocketListener({ path, replaceStale: false })).rejects.toThrow(/listening/);
    await replaced.close();
    await expect(stat(path)).rejects.toThrow();
  });

  it("closes a pending accept when it is closed, and the connect says what happened", async () => {
    const dir = await scratch();
    const path = join(dir, "service.sock");
    const listener = await unixSocketListener({ path });

    // A pending accept is released by the close, and the caller hears why rather than waiting forever.
    const settled = listener.accept().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await listener.close();
    expect(await settled).toMatch(/closed|stopped/);

    // Nothing is listening at the path any more, and the client says so instead of hanging.
    const attempt = connectUnixSocket(path, { timeoutMs: 200 }).then(
      () => "connected",
      (error: Error) => error.message,
    );
    expect(await attempt).toMatch(/nothing answered|ENOENT/);
  });

  it("hands the far end's own output to the client's sink", async () => {
    const dir = await scratch();
    const path = join(dir, "service.sock");
    const listener = await unixSocketListener({ path });
    const held: { output: ServedConnection<unknown>["output"] | null } = { output: null };
    const r = reactor(listener, async (connection, init) => {
      held.output = connection.output;
      return { proc: await makeEcho().spawn(init.args, { name: init.rootName }) };
    });

    const printed: [number, string][] = [];
    const channel = await socketClientSpawner<{ path: string }>((args) => args.path, {
      onOutput: (fd, data) => printed.push([fd, data]),
    })({ path });

    // The client lifts the output frame before the protocol reads it, so it arrives at the sink and never
    // at the seam's dispatch.
    const heard: Record<string, unknown>[] = [];
    channel.onMessage((frame) => heard.push(frame));

    await channel.send({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });
    await waitUntil(() => held.output !== null, "the factory's connection");
    await held.output!(2, "a line of its own");

    await waitUntil(() => printed.length === 1, "the client's sink");
    expect(printed).toEqual([[2, "a line of its own"]]);
    expect(heard.some((frame) => "$fd" in frame)).toBe(false);

    await r.stop();
  });
});
