// ── spawnRemote integration tests ──────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isMsg, isState, isExit } from "./protocol.js";
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

describe("spawnRemote handshake", () => {
  it("completes handshake and message exchange with child", async () => {
    const thisDir = dirname(import.meta.url.slice(7));
    const childScriptPath = join(thisDir, "./fixtures/manual.js");

    const basePath = join(tmpdir(), `host-test-${randomUUID()}`);
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    cleanupPaths.push(pathIn, pathOut);

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
    host.removeHandler();

    await host.send(
      encode("$init", { parentName: "test-host", parentIdName: "test-host", tools: [] }),
    );

    const stateLine = await new Promise<string>((resolve) => {
      host.onMessage((line) => resolve(line));
    });
    expect(isState(decode(stateLine))).toBe(true);
    host.removeHandler();

    const messages: Message[] = [];
    let messageWaiter = makeWaiter<null>();
    let exitWaiter = makeWaiter<number>();

    host.onMessage((line) => {
      const msg = decode(line);
      if (isMsg(msg)) {
        messages.push(msg.$msg.body);
        messageWaiter.resolve(messages);
      }
      if (isExit(msg)) {
        exitWaiter.resolve(msg.$exit.code);
      }
    });

    await host.send(encode("$msg", { fromName: "host", body: { type: "PING", count: 42 } }));
    expect(await messageWaiter.promise).toEqual([{ type: "PONG", count: 42 }]);

    host.send(encode("$msg", { type: "STOP", fromName: "host", body: { type: "STOP", count: 5 } }));

    const exitCode = await exitWaiter.promise;

    expect(exitCode).toBe(0);
    await host.close();
    child.kill();
  }, 10000);
});

describe("spawnRemote command construction", () => {
  it("passes fifo-in and fifo-out to spawned child", async () => {
    const basePath = join(tmpdir(), `host-test-${randomUUID()}`);
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    cleanupPaths.push(pathIn, pathOut);

    execSync(`mkfifo "${pathIn}"`);
    execSync(`mkfifo "${pathOut}"`);

    const reporterPath = join(tmpdir(), `host-test-reporter-${randomUUID()}.ts`);
    cleanupPaths.push(reporterPath);
    await writeFile(
      reporterPath,
      `
      const args = process.argv.slice(2);
      console.log(JSON.stringify(args));
      process.exit(0);
    `,
    );

    const child = spawn(
      "bun",
      ["run", reporterPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`],
      {
        cwd: process.cwd(),
        stdio: ["inherit", "pipe", "inherit"],
      },
    );

    const stdout = await new Promise<string>((resolve) => {
      let out = "";
      child.stdout?.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", () => resolve(out));
    });

    const args = JSON.parse(stdout.trim());
    expect(args).toContain(`--fifo-in=${pathIn}`);
    expect(args).toContain(`--fifo-out=${pathOut}`);
  }, 8000);
});
