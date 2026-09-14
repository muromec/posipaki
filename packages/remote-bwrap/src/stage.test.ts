// ── Staging in a sandbox that is handed in ─────────────────────────────────
//
// What bwrap would be asked to run, and what it would say back — including every
// way staging fails.  No bwrap, no sandbox, no runtime: the commands are data and
// the report is a string.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bootstrapScript } from "posipaki/remote/node";
import { bwrapStageCommand } from "./commands.js";
import type { HostResult, HostRun } from "./host.js";
import { bwrapKit } from "./kit.js";
import { bwrapStage } from "./stage.js";
import type { BwrapSpec } from "./spec.js";

const scratchDirs: string[] = [];
const KIT_DIR = "/home/agent/bin/posipaki/email-agent-0.13.0-posipaki-0.34.0-abcdef12";

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A payload bundle on a throwaway path, and the spec that stages it. */
function spec(extra: Partial<BwrapSpec> = {}): BwrapSpec {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-bwrap-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  return {
    name: "tools",
    args: ["--ro-bind", "/", "/"],
    app: { name: "email-agent", version: "0.13.0" },
    payload,
    ...extra,
  };
}

/** A sandbox runner that records what it was asked to run and answers as told. */
function sandbox(answer: HostResult): { run: HostRun; commands: string[][]; fed: string[] } {
  const commands: string[][] = [];
  const fed: string[] = [];
  const run: HostRun = async (command, stdin) => {
    commands.push(command);
    fed.push(stdin);
    return answer;
  };
  return { run, commands, fed };
}

it("stages through the sandbox, feeding the script the core wrote", async () => {
  const bwrap = spec();
  const { run, commands, fed } = sandbox({
    code: 0,
    stdout: `staged\nkit ${KIT_DIR}\nruntime /usr/bin/node\n`,
    stderr: "",
  });
  const staged = await bwrapStage(bwrap, bwrap, run);

  expect(commands).toEqual([bwrapStageCommand(bwrap)]);
  expect(fed[0]).toBe(bootstrapScript(await bwrapKit(bwrap)));
  expect(staged).toEqual({ kitDir: KIT_DIR, runtime: "/usr/bin/node" });
});

it("reports what the sandbox said when no runtime is there", async () => {
  const bwrap = spec();
  const { run } = sandbox({ code: 75, stdout: "error no runtime among: node nodejs bun\n", stderr: "" });
  await expect(bwrapStage(bwrap, bwrap, run)).rejects.toThrow(
    /staging into sandbox tools failed: no runtime among: node nodejs bun/,
  );
});

it("quotes the sandbox when it never reported at all", async () => {
  const bwrap = spec();
  const { run } = sandbox({
    code: 1,
    stdout: "",
    stderr: "bwrap: Can't find source path /nope: No such file or directory\n",
  });
  await expect(bwrapStage(bwrap, bwrap, run)).rejects.toThrow(
    /no report at all \(bwrap: Can't find source path/,
  );
});

it("refuses a relayed spec with no gateway before it reaches a sandbox", async () => {
  const bwrap = spec({ relay: true });
  const { run, commands } = sandbox({ code: 0, stdout: "", stderr: "" });
  await expect(bwrapStage(bwrap, bwrap, run)).rejects.toThrow(/gateway/);
  expect(commands).toEqual([]);
});
