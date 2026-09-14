// ── Putting the actor in the container ─────────────────────────────────────
//
// The container is handed in as a runner: the script goes out on the command's
// stdin, the report comes back on its stdout, and what the container said is the
// failure reason.  No podman and no container needed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PAYLOAD_ARTIFACT } from "./commands.js";
import type { HostResult, HostRun } from "./host.js";
import type { KitSpec } from "./spec.js";
import { podmanStage } from "./stage.js";

const KIT_DIR = "/home/agent/bin/posipaki/email-agent-0.13.0-posipaki-0.32.1-abcdef12";
const READY = `staged\nkit ${KIT_DIR}\nruntime /usr/bin/node\n`;

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A payload bundle on a throwaway path, and the spec that stages it. */
function kit(extra: Partial<KitSpec> = {}): KitSpec {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  return { app: { name: "email-agent", version: "0.13.0" }, payload, ...extra };
}

/** A runner that answers, and records what it was asked and fed. */
function host(answer: HostResult): { run: HostRun; commands: string[][]; fed: string[] } {
  const commands: string[][] = [];
  const fed: string[] = [];
  const run: HostRun = async (command, stdin) => {
    commands.push(command);
    fed.push(stdin);
    return answer;
  };
  return { run, commands, fed };
}

it("runs the bootstrap over one exec and answers with where the kit is and what runs it", async () => {
  const container = "env-agent";
  const staged = host({ code: 0, stdout: READY, stderr: "" });
  const result = await podmanStage(container, kit(), staged.run);

  expect(result).toEqual({ kitDir: KIT_DIR, runtime: "/usr/bin/node" });
  expect(staged.commands).toEqual([["podman", "exec", "-i", "env-agent", "sh", "-s"]]);
  expect(staged.fed[0]).toContain('kit_dir="$HOME/');
  expect(staged.fed[0]).toContain(PAYLOAD_ARTIFACT);
});

it("says what the container said when the report is an error", async () => {
  const staged = host({ code: 75, stdout: "error no runtime among: node nodejs bun\n", stderr: "" });
  await expect(podmanStage("env-agent", kit(), staged.run)).rejects.toThrow(
    /staging into container env-agent failed: no runtime among: node nodejs bun/,
  );
});

it("quotes the container when no report arrived at all", async () => {
  const staged = host({ code: 127, stdout: "", stderr: "sh: 1: base64: not found\n" });
  await expect(podmanStage("env-agent", kit(), staged.run)).rejects.toThrow(
    /staging into container env-agent failed: .*base64: not found/,
  );
});

it("fails before anything runs when the kit itself cannot be built", async () => {
  const staged = host({ code: 0, stdout: READY, stderr: "" });
  await expect(podmanStage("env-agent", kit({ relay: true }), staged.run)).rejects.toThrow(
    /a relayed kit needs a gateway bundle/,
  );
  expect(staged.commands).toEqual([]);
});
