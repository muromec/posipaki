// ── a spawned command as a port ─────────────────────────────────────────────
//
// A real `/bin/sh` on the other end: the frames are what it wrote, the exit is what it exited with, and a kill
// is a signal rather than a code.  Nothing here fakes a process.

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessEnd } from "./spawn.js";
import { spawnPort, spawnPorts, type SpawnPortOptions } from "./spawn.js";

const sh = (script: string): string[] => ["/bin/sh", "-c", script];

/** Every port this file opened, so the floor can close what a case forgot. */
const opened: Array<{ close(reason?: string): Promise<void> }> = [];

afterEach(async () => {
  for (const port of opened.splice(0)) await port.close().catch(() => undefined);
});

/** `spawnPort`, recorded: each test cleans up after itself, and this is the floor under it. */
async function port(command: string[], options?: SpawnPortOptions) {
  const spawned = await spawnPort(command, options);
  opened.push(spawned);
  return spawned;
}
/** Everything a port said, and how it ended. */
async function drain(port: {

  onFrame(handler: (bytes: Uint8Array) => void): unknown;
  onClose(handler: (end: ProcessEnd) => void): unknown;
}): Promise<{ said: string; end: ProcessEnd }> {
  const parts: string[] = [];
  port.onFrame((bytes) => parts.push(Buffer.from(bytes).toString("utf8")));
  const end = await new Promise<ProcessEnd>((resolve) => port.onClose(resolve));
  return { said: parts.join(""), end };
}

describe("spawnPort", () => {
  it("carries what the child wrote, and how it ended", async () => {
    const used = await port(sh("printf hello; exit 3"));
    expect(await drain(used)).toEqual({ said: "hello", end: { kind: "exit", code: 3 } });
  });

  it("writes to the child's stdin, and closes its end of it", async () => {
    const used = await port(sh("cat"));
    const said = drain(used);
    await used.send(Buffer.from("ping\n"));
    await used.close();
    expect(await said).toEqual({ said: "ping\n", end: { kind: "exit", code: 0 } });
  });

  it("discards the child's stderr", async () => {
    const used = await port(sh("printf quiet; printf loud 1>&2"));
    expect((await drain(used)).said).toBe("quiet");
  });

  it("kills a child that outlives its stdin", async () => {
    const used = await port(sh("sleep 60"), { killAfterMs: 50 });
    const ending = drain(used);
    await used.close();
    expect((await ending).end).toEqual({ kind: "signal", signal: "SIGKILL" });
  });

  it("refuses a command that cannot be started", async () => {
    await expect(spawnPort(["/nonexistent-program-7f3a"])).rejects.toThrow(/could not start/);
  });
});

describe("spawnPorts", () => {
  it("gives both streams, each ending with the same exit", async () => {
    const ports = await spawnPorts(sh("printf out; printf err 1>&2; exit 4"));
    const both = await Promise.all([drain(ports.stdout), drain(ports.stderr)]);
    expect(both[0].said).toBe("out");
    expect(both[1].said).toBe("err");
    expect(both[0].end).toEqual({ kind: "exit", code: 4 });
    expect(both[1].end).toEqual(both[0].end);
  });

  it("has no input on stderr", async () => {
    const ports = await spawnPorts(sh("printf x"));
    await expect(ports.stderr.send(Buffer.from("nope"))).rejects.toThrow(/has no input/);
    await ports.stdout.close();
  });
});
