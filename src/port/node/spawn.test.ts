// ── a spawned command as a port ─────────────────────────────────────────────
//
// A real `/bin/sh` on the other end: the frames are what it wrote, the exit is what it exited with, and a kill
// is a signal rather than a code.  Nothing here fakes a process.

import { describe, expect, it } from "vitest";

import type { ProcessExit } from "./spawn.js";
import { spawnPort, spawnPorts } from "./spawn.js";

const sh = (script: string): string[] => ["/bin/sh", "-c", script];

/** Everything a port said, and how it ended. */
async function drain(port: {
  onFrame(handler: (bytes: Uint8Array) => void): unknown;
  onClose(handler: (exit: ProcessExit) => void): unknown;
}): Promise<{ said: string; exit: ProcessExit }> {
  const parts: string[] = [];
  port.onFrame((bytes) => parts.push(Buffer.from(bytes).toString("utf8")));
  const exit = await new Promise<ProcessExit>((resolve) => port.onClose(resolve));
  return { said: parts.join(""), exit };
}

describe("spawnPort", () => {
  it("carries what the child wrote, and how it ended", async () => {
    const port = await spawnPort(sh("printf hello; exit 3"));
    expect(await drain(port)).toEqual({ said: "hello", exit: { code: 3, signal: null } });
  });

  it("writes to the child's stdin, and closes its end of it", async () => {
    const port = await spawnPort(sh("cat"));
    const said = drain(port);
    await port.send(Buffer.from("ping\n"));
    await port.close();
    expect(await said).toEqual({ said: "ping\n", exit: { code: 0, signal: null } });
  });

  it("discards the child's stderr", async () => {
    const port = await spawnPort(sh("printf quiet; printf loud 1>&2"));
    expect((await drain(port)).said).toBe("quiet");
  });

  it("kills a child that outlives its stdin", async () => {
    const port = await spawnPort(sh("sleep 60"), { killAfterMs: 50 });
    const ending = drain(port);
    await port.close();
    expect((await ending).exit.signal).toBe("SIGKILL");
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
    expect(both[0].exit).toEqual({ code: 4, signal: null });
    expect(both[1].exit).toEqual(both[0].exit);
  });

  it("has no input on stderr", async () => {
    const ports = await spawnPorts(sh("printf x"));
    await expect(ports.stderr.send(Buffer.from("nope"))).rejects.toThrow(/has no input/);
    await ports.stdout.close();
  });
});
