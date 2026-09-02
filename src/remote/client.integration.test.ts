// ── FIFO spawn + handshake integration (manual beginConnect) ───────────────

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isMsg, isState, isExit } from "./protocol.js";
import type { Message } from "../types.js";
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

describe("FIFO handshake", () => {
  it("completes handshake and message exchange with server", async () => {
    const thisDir = dirname(import.meta.url.slice(7));
    const serverScriptPath = join(thisDir, "./fixtures/manual.js");

    const basePath = join(tmpdir(), `client-test-${randomUUID()}`);
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    cleanupPaths.push(pathIn, pathOut);

    execSync(`mkfifo "${pathIn}"`);
    execSync(`mkfifo "${pathOut}"`);

    const setup = FifoUtf8NlineTransport.beginConnect(pathIn, pathOut);

    const server = spawn(
      getRuntime(),
      [serverScriptPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`],
      {
        cwd: process.cwd(),
        stdio: ["inherit", "inherit", "inherit"],
      },
    );

    const client = await setup.transport;

    const protoLine = await new Promise<string>((resolve) => {
      client.onMessage((line) => resolve(line));
    });
    expect(isProto(decode(protoLine))).toBe(true);
    client.removeHandler();

    await client.send(
      encode("$init", { parentName: "test-client", parentIdName: "test-client", tools: [] }),
    );

    const stateLine = await new Promise<string>((resolve) => {
      client.onMessage((line) => resolve(line));
    });
    expect(isState(decode(stateLine))).toBe(true);
    client.removeHandler();

    const messages: Message[] = [];
    let messageWaiter = makeWaiter<Message[]>();
    let exitWaiter = makeWaiter<number>();

    client.onMessage((line) => {
      const msg = decode(line);
      if (isMsg(msg)) {
        messages.push(msg.$msg.body);
        messageWaiter.resolve(messages);
      }
      if (isExit(msg)) {
        exitWaiter.resolve(msg.$exit.code);
      }
    });

    await client.send(encode("$msg", { fromName: "client", body: { type: "PING", count: 42 } }));
    expect(await messageWaiter.promise).toEqual([{ type: "PONG", count: 42 }]);

    client.send(encode("$msg", { type: "STOP", fromName: "client", body: { type: "STOP", count: 5 } }));

    const exitCode = await exitWaiter.promise;

    expect(exitCode).toBe(0);
    await client.close();
    server.kill();
  }, 10000);
});

describe("FIFO spawn command construction", () => {
  it("passes fifo-in and fifo-out to spawned server", async () => {
    const basePath = join(tmpdir(), `client-test-${randomUUID()}`);
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    cleanupPaths.push(pathIn, pathOut);

    execSync(`mkfifo "${pathIn}"`);
    execSync(`mkfifo "${pathOut}"`);

    const reporterPath = join(tmpdir(), `client-test-reporter-${randomUUID()}.ts`);
    cleanupPaths.push(reporterPath);
    await writeFile(
      reporterPath,
      `
      const args = process.argv.slice(2);
      console.log(JSON.stringify(args));
      process.exit(0);
    `,
    );

    const server = spawn(
      "bun",
      ["run", reporterPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`],
      {
        cwd: process.cwd(),
        stdio: ["inherit", "pipe", "inherit"],
      },
    );

    const stdout = await new Promise<string>((resolve) => {
      let out = "";
      server.stdout?.on("data", (d) => {
        out += d.toString();
      });
      server.on("close", () => resolve(out));
    });

    const args = JSON.parse(stdout.trim());
    expect(args).toContain(`--fifo-in=${pathIn}`);
    expect(args).toContain(`--fifo-out=${pathOut}`);
  }, 8000);
});
