// ── runChild integration tests ─────────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";
import { makeWaiter } from "../util.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) {
    await unlink(p).catch(() => {});
  }
});

function getRuntime() {
  return process.argv[0];
}

describe("runChild integration", () => {
  it("handshake + PING/PONG + STOP/exit with real actor", async () => {
    const thisDir = dirname(import.meta.url.slice(7));
    const childScriptPath = join(thisDir, "./fixtures/pong.js");
    const basePath = join(tmpdir(), `child-test-${randomUUID()}`);
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    cleanupPaths.push(pathIn, pathOut);

    /*
    Yes, there is no fs.mkfifo in nodejs as of version 26.7.0
    */
    execSync(`mkfifo "${pathIn}"`);
    execSync(`mkfifo "${pathOut}"`);

    const setup = FifoUtf8NlineTransport.beginConnect(pathIn, pathOut);

    const child = spawn(
      getRuntime(),
      [childScriptPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`],
      {
        cwd: process.cwd(),
        stdio: ["inherit", "inherit", "inherit"],
      },
    );

    const host = await setup.transport;

    const protoLine = await new Promise<string>((resolve) => {
      host.onMessage((line) => resolve(line));
    });
    expect(isProto(decode(protoLine))).toBe(true);
    expect(decode(protoLine).$proto).toBe(PROTO_VERSION);
    host.removeHandler();

    await host.send(
      encode("$init", {
        parentName: "test-host",
        parentIdName: "test-host",
        tools: [],
      }),
    );

    const stateLine = await new Promise<string>((resolve) => {
      host.onMessage((line) => resolve(line));
    });
    const stateMsg = decode(stateLine);
    expect(isState(stateMsg)).toBe(true);
    expect((stateMsg.$state as Record<string, unknown>).pings).toBe(0);
    host.removeHandler();

    const messages: Message[] = [];
    const exitWaiter = makeWaiter<{ code: number; state: unknown }>();
    let messageWaiter = makeWaiter<null>();
    let expectedMessageCount = 2;

    host.onMessage((line) => {
      const msg = decode(line);
      if (isExit(msg)) {
        return exitWaiter.resolve({ code: msg.$exit.code, state: msg.$exit.state });
      }

      messages.push(msg);
      if (messages.length === expectedMessageCount) {
        messageWaiter.resolve(messages);

        // wait for next 2
        messageWaiter = makeWaiter<null>();
        expectedMessageCount += 2;
      }
    });

    await host.send(
      encode("$msg", {
        type: "PING",
        fromName: "host",
        body: { type: "PING", count: 1 },
      }),
    );

    await expect(await messageWaiter.promise);
    await host.send(
      encode("$msg", {
        type: "PING",
        fromName: "host",
        body: { type: "PING", count: 2 },
      }),
    );

    await expect(await messageWaiter.promise);
    await host.send(
      encode("$msg", {
        type: "PING",
        fromName: "host",
        body: { type: "PING", count: 3 },
      }),
    );
    await expect(await messageWaiter.promise).toEqual([
      { $msg: { body: { type: "PONG", count: 1 }, fromName: "remote" } },
      { $state: { pings: 1 } },
      { $msg: { body: { type: "PONG", count: 2 }, fromName: "remote" } },
      { $state: { pings: 2 } },

      { $msg: { body: { type: "PONG", count: 3 }, fromName: "remote" } },
      { $state: { pings: 3 } },
    ]);

    host.send(
      encode("$msg", {
        type: "STOP",
        fromName: "host",
        body: { type: "STOP", count: 0 },
      }),
    );
    expect(await exitWaiter.promise).toMatchObject({ code: 0 });

    await host.close();
    child.kill();
  }, 15000);
});
