// ── Staging on a host that is handed in ────────────────────────────────────
//
// What ssh would be asked to run, and what it would say back — including every
// way staging fails.  No ssh, no host, no runtime: the commands are data and the
// report is a string.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bootstrapScript } from "posipaki/remote/node";
import { sshStageCommand } from "./commands.js";
import { sshKit } from "./kit.js";
import type { HostResult, HostRun } from "./host.js";
import { sshStage } from "./stage.js";
import type { SshSpec } from "./spec.js";

const scratchDirs: string[] = [];
const KIT_DIR = "/home/agent/bin/posipaki/email-agent-0.13.0-posipaki-0.32.1-abcdef12";

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A payload bundle on a throwaway path, and the spec that stages it. */
function spec(extra: Partial<SshSpec> = {}): SshSpec {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-ssh-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  return { host: "env.invalid", app: { name: "email-agent", version: "0.13.0" }, payload, ...extra };
}

/** A host runner that records what it was asked to run and answers as told. */
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

it("stages the kit over ssh, feeding the script the core wrote", async () => {
  const ssh = spec();
  const { run, commands, fed } = host({
    code: 0,
    stdout: `staged\nkit ${KIT_DIR}\nruntime /usr/bin/node\n`,
    stderr: "",
  });
  const staged = await sshStage(ssh, { runHost: run });

  expect(commands).toEqual([sshStageCommand(ssh)]);
  expect(commands[0]).toEqual(["ssh", "env.invalid", "sh", "-s"]);
  expect(fed[0]).toBe(bootstrapScript(await sshKit(ssh)));
  expect(staged).toEqual({ kitDir: KIT_DIR, runtime: "/usr/bin/node" });
});

it("reports what the host said when no runtime is there", async () => {
  const { run } = host({
    code: 75,
    stdout: "error no runtime among: node nodejs bun\n",
    stderr: "",
  });
  await expect(sshStage(spec(), { runHost: run })).rejects.toThrow(
    /staging into ssh env\.invalid failed: no runtime among: node nodejs bun/,
  );
});

it("quotes the host when it never reported at all", async () => {
  const { run } = host({
    code: 1,
    stdout: "",
    stderr: "ssh: connect to host env.invalid port 22: Connection refused\n",
  });
  await expect(sshStage(spec(), { runHost: run })).rejects.toThrow(
    /no report at all \(ssh: connect to host env\.invalid port 22: Connection refused\)/,
  );
});

it("refuses a relayed spec with no gateway before it reaches a host", async () => {
  const { run, commands } = host({ code: 0, stdout: "", stderr: "" });
  await expect(sshStage(spec({ relay: true }), { runHost: run })).rejects.toThrow(/gateway/);
  expect(commands).toEqual([]);
});
