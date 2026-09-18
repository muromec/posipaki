// ── The client side of the gateway ─────────────────────────────────────────
//
// Two halves, tested the way they fail.  The staging path is asserted with a fake way in:
// what command is run, what script is fed to it, what the argv becomes, and what a way in
// that says no turns into.  Then the whole thing runs for real — this machine as the
// environment, the real bootstrap script, the real gateway program, a fifo payload —
// because that is the one thing a fake cannot stand in for.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayClient, hostRemote } from "./gateway-client.js";
import type { RemoteSpec } from "./gateway-client.js";
import { hostVersion } from "./kit.js";
import type { HostRun } from "./host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GATEWAY_SOURCE = join(HERE, "gateway-cli.ts");
const PAYLOAD = join(HERE, "fixtures", "echo-payload.js");
const APP = { name: "test-app", version: "1.2.3" };

const scratch: string[] = [];

/** A fresh scratch directory, removed when the file's tests are done. */
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Run `body` with `$HOME` somewhere else: a kit is staged under the home it is given. */
async function atHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return await body();
  } finally {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  }
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A gateway program built the way a consumer builds one: a bundle, because what is staged
 * into an environment is one file with its imports already inside it.  A copy of the
 * source entry would import a `./gateway.js` that is not there.
 */
function builtGateway(): string {
  const out = join(scratchDir("posipaki-client-build-"), "gateway.js");
  const built = spawnSync(process.execPath, [
    "build",
    "--target=node",
    `--outfile=${out}`,
    GATEWAY_SOURCE,
  ], { cwd: ROOT, encoding: "utf-8" });
  expect(built.status, built.stderr).toBe(0);
  return out;
}

/** The kit this host has staged, or the reason there is none: exactly one, by construction. */
function stagedKits(home: string): string[] {
  const parent = join(home, "bin", "posipaki");
  return readdirSync(parent).map((name) => join(parent, name));
}

describe("the client side of the gateway, over this machine", () => {
  it("stages the payload and posipaki's own gateway, runs the gateway, and speaks the wire", async () => {
    const home = scratchDir("posipaki-client-");
    const spawner = hostRemote({
      payload: { stage: PAYLOAD },
      hostVersion: APP,
      gateway: { stage: builtGateway() },
      runtime: [process.execPath],
    });

    const channel = await atHome(home, () => spawner({}));
    try {
      // The kit is the build's own directory, holding what the script writes there —
      // and the gateway program came from the caller, not from a path this package
      // worked out for itself.
      const kits = stagedKits(home);
      expect(kits).toHaveLength(1);
      // The directory *is* the host version the payload will be started for.
      expect(kits[0]).toContain(hostVersion(APP));
      expect(readdirSync(kits[0]!).sort()).toEqual(["gateway.js", "payload.js", "version.json"]);

      const heard = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
      await channel.send({ $msg: { body: { echo: "hi" } } });
      expect(await heard).toEqual({ $msg: { fromName: "payload", body: { echo: "hi" } } });
    } finally {
      await channel.close().catch(() => {});
    }
  }, 30_000);

  it("does not write the kit again when the same build is already staged", async () => {
    const home = scratchDir("posipaki-client-");
    const spawner = hostRemote({
      payload: { stage: PAYLOAD },
      hostVersion: APP,
      gateway: { stage: builtGateway() },
      runtime: [process.execPath],
    });

    const first = await atHome(home, () => spawner({}));
    await first.close().catch(() => {});
    const [kit] = stagedKits(home);
    const before = readdirSync(kit!).map((name) => [name, statSync(join(kit!, name)).mtimeMs]);

    const second = await atHome(home, () => spawner({}));
    await second.close().catch(() => {});

    // Same directory, same files, same bytes: the script probed and found them, so a
    // second spawn of one build costs one process and no copy.
    expect(stagedKits(home)).toEqual([kit]);
    expect(readdirSync(kit!).map((name) => [name, statSync(join(kit!, name)).mtimeMs])).toEqual(
      before,
    );
  }, 30_000);
});

describe("a way in that says no", () => {
  /** A consumer's two bundles, on this machine, and nothing else. */
  function files(): { payload: string; gateway: string } {
    const dir = scratchDir("posipaki-client-files-");
    const payload = join(dir, "payload.js");
    const gateway = join(dir, "gateway.js");
    writeFileSync(payload, "// the payload\n");
    writeFileSync(gateway, "// the gateway\n");
    return { payload, gateway };
  }

  it("carries the environment's own reason out, and never starts anything after it", async () => {
    const { payload, gateway } = files();
    const run: HostRun = async (command, stdin) => {
      // The way in wraps the staging command like any other: it is the one place a
      // command becomes reachable somewhere else.
      expect(command).toEqual(["into", "sh", "-s"]);
      // The script is fed, not passed: the kit's bytes are in it.
      expect(stdin).toContain("kit_dir=");
      return { code: 75, stdout: "error no runtime among: node bun\n", stderr: "" };
    };
    const spawner = gatewayClient<Record<string, never>>({
      name: "a way in that says no",
      entry: (command) => ["into", ...command],
      payload: { stage: payload },
      hostVersion: APP,
      gateway: { stage: gateway },
      run,
      spawn: () => {
        throw new Error("nothing may be started after a failed staging");
      },
    });

    await expect(spawner({})).rejects.toThrow(
      /staging into a way in that says no failed: no runtime among: node bun/,
    );
  });

  it("quotes what the environment said when its report never arrived", async () => {
    const { payload, gateway } = files();
    const run: HostRun = async () => ({
      code: 127,
      stdout: "",
      stderr: "bwrap: execvp sh: No such file or directory\n",
    });
    const spawner = gatewayClient<Record<string, never>>({
      name: "a way in that never spoke",
      entry: (command) => command,
      payload: { stage: payload },
      hostVersion: APP,
      gateway: { stage: gateway },
      run,
    });

    await expect(spawner({})).rejects.toThrow(
      /staging into a way in that never spoke failed: no report at all \(bwrap: execvp sh/,
    );
  });

  it("refuses a payload that is not on this machine before running a command about it", async () => {
    const { gateway } = files();
    let ran = false;
    const spawner = gatewayClient<Record<string, never>>({
      name: "a way in that is never reached",
      entry: (command) => command,
      payload: { stage: join(scratchDir("posipaki-client-"), "absent.js") },
      hostVersion: APP,
      gateway: { stage: gateway },
      run: async () => {
        ran = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await expect(spawner({})).rejects.toThrow(/absent\.js/);
    expect(ran).toBe(false);
  });
});

describe("the two programs, wherever the caller says they are", () => {
  /** A client that stops at the command it would run, and hands it back instead. */
  async function commandFor(
    spec: Omit<RemoteSpec<{ env: string }>, "entry" | "run" | "spawn">,
  ): Promise<string[]> {
    const commands: string[][] = [];
    const spawner = gatewayClient<{ env: string }>({
      ...spec,
      entry: (command) => ["into", ...command],
      run: async () => {
        throw new Error("nothing may be staged: no program said it had to be copied");
      },
      spawn: (command) => {
        commands.push(command);
        throw new Error("stop here: the command is the whole assertion");
      },
    });
    await expect(spawner({ env: "agent" })).rejects.toThrow(/stop here/);
    return commands[0]!;
  }

  it("starts what is already installed, and stages nothing at all", async () => {
    // Both programs are where the deployment put them: no bootstrap runs, no runtime is
    // probed, and posipaki touches the environment only by starting the relay there.
    expect(
      await commandFor({
        name: "a host with both installed",
        payload: { run: ["/usr/local/bin/agent-payload"] },
        gateway: { run: ["/usr/local/bin/posipaki-gateway"] },
        hostVersion: APP,
        payloadArgs: (args) => [`--env=${args.env}`],
      }),
    ).toEqual([
      "into",
      "/usr/local/bin/posipaki-gateway",
      "/usr/local/bin/agent-payload",
      `--host-version=${hostVersion(APP)}`,
      "--env=agent",
    ]);
  });

  it("says nothing about a version it was never given", async () => {
    // A payload whose bytes carry no version of their own: there is nothing to check, so the
    // client states nothing rather than passing a placeholder the far end would judge itself by.
    expect(
      await commandFor({
        name: "a host with an unversioned payload",
        payload: { run: ["bun", "/srv/agent/payload.js"] },
        gateway: { run: ["bun", "/srv/agent/gateway.js"] },
      }),
    ).toEqual(["into", "bun", "/srv/agent/gateway.js", "bun", "/srv/agent/payload.js"]);
  });

  it("refuses to stage a kit that nothing names", async () => {
    // A staged kit's directory *is* the host version, so a caller that stages without one is
    // asking for a directory whose name is a guess — and the payload would refuse it anyway.
    const spawner = gatewayClient<{ env: string }>({
      name: "a host that wants a kit",
      entry: (command) => command,
      payload: { stage: join(scratchDir("posipaki-client-"), "payload.js") },
    });
    await expect(spawner({ env: "agent" })).rejects.toThrow(
      /nothing names the kit to stage into a host that wants a kit: state hostVersion/,
    );
  });

  it("refuses a command with nothing to run", async () => {
    const spawner = gatewayClient<{ env: string }>({
      name: "a host with an empty command",
      entry: (command) => command,
      payload: { run: [] },
      gateway: { run: ["posipaki-gateway"] },
    });
    await expect(spawner({ env: "agent" })).rejects.toThrow(
      /a host with an empty command: the payload is a command with nothing to run/,
    );
  });
});
