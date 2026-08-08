// ── runChild integration tests ─────────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) {
    await unlink(p).catch(() => {});
  }
});

async function writeChildScript(): Promise<string> {
  const script = `import { defineActor, defineMessages } from "/home/muromec/src/posipaki/src/index.js";
import { runChild } from "/home/muromec/src/posipaki/src/remote/child.js";

const echoActor = defineActor({
  name: "echo",
  inMessages: defineMessages(),
  outMessages: defineMessages(),
  initialState: () => ({ pings: 0 }),
  handlers: {
    PING(msg: any) {
      this.state.pings++;
      this.emit({ type: "PONG", count: msg.count });
    },
  },
});

runChild(echoActor.fn);
`;
  const path = join(tmpdir(), `child-test-actor-${randomUUID()}.ts`);
  await writeFile(path, script);
  return path;
}

describe("runChild integration", () => {
  it("handshake + PING/PONG + STOP/exit with real actor", async () => {
    const childScriptPath = await writeChildScript();
    const basePath = join(tmpdir(), `child-test-${randomUUID()}`);
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    cleanupPaths.push(pathIn, pathOut, childScriptPath);

    execSync(`mkfifo "${pathIn}"`);
    execSync(`mkfifo "${pathOut}"`);

    const setup = FifoUtf8NlineTransport.beginConnect(pathIn, pathOut);

    const child = spawn("bun", ["run", childScriptPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`], {
      cwd: process.cwd(),
      stdio: ["inherit", "inherit", "inherit"],
    });

    const host = await setup.transport;

    const protoLine = await new Promise<string>((resolve) => {
      host.onMessage((line) => resolve(line));
    });
    expect(isProto(decode(protoLine))).toBe(true);
    expect(decode(protoLine).$proto).toBe(PROTO_VERSION);
    host.removeHandler();

    await host.send(encode("$init", {
      parentName: "test-host", parentIdName: "test-host", tools: [],
    }));

    const stateLine = await new Promise<string>((resolve) => {
      host.onMessage((line) => resolve(line));
    });
    const stateMsg = decode(stateLine);
    expect(isState(stateMsg)).toBe(true);
    expect((stateMsg.$state as Record<string, unknown>).pings).toBe(0);
    host.removeHandler();

    const messages: any[] = [];
    host.onMessage((line) => {
      const msg = decode(line);
      if (isMsg(msg)) messages.push(msg.$msg.body);
    });

    await host.send(encode("$msg", { type: "PING", fromName: "host", body: { type: "PING", count: 1 } }));
    await host.send(encode("$msg", { type: "PING", fromName: "host", body: { type: "PING", count: 2 } }));
    await host.send(encode("$msg", { type: "PING", fromName: "host", body: { type: "PING", count: 3 } }));
    await new Promise((r) => setTimeout(r, 200));

    const pongs = messages.filter((m: any) => m.type === "PONG");
    expect(pongs.length).toBeGreaterThanOrEqual(1);

    const origHandler = host.removeHandler()!;
    const exitResult = await new Promise<{ code: number | null; state: any }>((resolve) => {
      const timeout = setTimeout(() => resolve({ code: null, state: null }), 3000);
      host.onMessage((line) => {
        const msg = decode(line);
        if (isExit(msg)) {
          clearTimeout(timeout);
          resolve({ code: msg.$exit.code, state: msg.$exit.state });
        } else if (isMsg(msg)) {
          origHandler(line);
        }
      });
      host.send(encode("$msg", { type: "STOP", fromName: "host", body: { type: "STOP", count: 0 } }));
    });

    expect(exitResult.code).toBe(0);

    await host.close();
    child.kill();
  }, 15000);
});
