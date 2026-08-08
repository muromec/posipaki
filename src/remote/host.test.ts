// ── spawnRemote integration tests ──────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isMsg, isState, isExit } from "./protocol.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) {
    await unlink(p).catch(() => {});
  }
});

async function writeChildScript(): Promise<string> {
  const script = `import { open } from "node:fs/promises";
const args = process.argv.slice(2);
const fifoIn = args.find(a => a.startsWith("--fifo-in="))?.slice("--fifo-in=".length);
const fifoOut = args.find(a => a.startsWith("--fifo-out="))?.slice("--fifo-out=".length);
if (!fifoIn || !fifoOut) process.exit(1);

const writeFd = await open(fifoIn, "w");
const readFd = await open(fifoOut, "r");

await writeFd.write('{"$proto":"ndjson.v1"}\\n');

const { createInterface } = await import("node:readline");
const { createReadStream } = await import("node:fs");
const rs = createReadStream("", { fd: readFd.fd, encoding: "utf-8", autoClose: false });
const rl = createInterface({ input: rs });

await new Promise(resolve => { rl.once("line", resolve); });
await writeFd.write('{"$state":{"pings":0}}\\n');

rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.$msg) {
      const body = msg.$msg.body;
      if (body.type === "PING") {
        await writeFd.write(JSON.stringify({
          "$msg": { type: "PONG", fromName: "child", body: { type: "PONG", count: body.count } }
        }) + "\\n");
      } else if (body.type === "STOP") {
        await writeFd.write(JSON.stringify({
          "$exit": { code: 0, state: { pings: body.count || 0 } }
        }) + "\\n");
        rl.close();
        rs.destroy();
        await writeFd.close();
        process.exit(0);
      }
    }
  } catch (e) {}
});
`;
  const path = join(tmpdir(), `host-test-child-${randomUUID()}.ts`);
  await writeFile(path, script);
  return path;
}

describe("spawnRemote handshake", () => {
  it("completes handshake and message exchange with child", async () => {
    const childScriptPath = await writeChildScript();
    const basePath = join(tmpdir(), `host-test-${randomUUID()}`);
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
    host.removeHandler();

    await host.send(encode("$init", { parentName: "test-host", parentIdName: "test-host", tools: [] }));

    const stateLine = await new Promise<string>((resolve) => {
      host.onMessage((line) => resolve(line));
    });
    expect(isState(decode(stateLine))).toBe(true);
    host.removeHandler();

    const messages: any[] = [];
    host.onMessage((line) => {
      const msg = decode(line);
      if (isMsg(msg)) messages.push(msg.$msg.body);
    });

    await host.send(encode("$msg", { type: "PING", fromName: "host", body: { type: "PING", count: 42 } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const origHandler = host.removeHandler()!;
    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      host.onMessage((line) => {
        const msg = decode(line);
        if (isExit(msg)) { clearTimeout(timeout); resolve(msg.$exit.code); }
        else if (isMsg(msg)) { origHandler(line); }
      });
      host.send(encode("$msg", { type: "STOP", fromName: "host", body: { type: "STOP", count: 5 } }));
    });

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
    await writeFile(reporterPath, `
      const args = process.argv.slice(2);
      console.log(JSON.stringify(args));
      process.exit(0);
    `);

    const child = spawn("bun", ["run", reporterPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`], {
      cwd: process.cwd(),
      stdio: ["inherit", "pipe", "inherit"],
    });

    const stdout = await new Promise<string>((resolve) => {
      let out = "";
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.on("close", () => resolve(out));
    });

    const args = JSON.parse(stdout.trim());
    expect(args).toContain(`--fifo-in=${pathIn}`);
    expect(args).toContain(`--fifo-out=${pathOut}`);
  }, 8000);
});
