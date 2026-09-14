// ── Staging into a container that is handed in ─────────────────────────────
//
// What podman would be asked to run, and what it would say back — including every
// way staging fails, and the container that has to be there first.  No podman, no
// container, no runtime: the commands are data and the report is a string.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bootstrapScript } from "posipaki/remote/node";
import { containerExistsCommand, podmanStageCommand } from "./commands.js";
import type { HostResult, HostRun } from "./host.js";
import { podmanKit } from "./kit.js";
import type { HostStart } from "./lifetime.js";
import type { PodmanSpec } from "./spec.js";
import { podmanStage } from "./stage.js";

const scratchDirs: string[] = [];
const KIT_DIR = "/home/agent/bin/posipaki/email-agent-0.13.0-posipaki-0.32.1-abcdef12";

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A payload bundle on a throwaway path, and the spec that stages it. */
function spec(extra: Partial<PodmanSpec> = {}): PodmanSpec {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const payload = join(dir, "payload.js");
  writeFileSync(payload, "// the payload\n");
  return {
    image: "toolbox:1",
    container: "env-agent",
    app: { name: "email-agent", version: "0.13.0" },
    payload,
    ...extra,
  };
}

/**
 * A host where the container is already there: the probe answers, everything else
 * is the staging command, which answers with the report.
 */
function host(answer: HostResult): { run: HostRun; commands: string[][]; fed: string[] } {
  const commands: string[][] = [];
  const fed: string[] = [];
  const run: HostRun = async (command, stdin) => {
    commands.push(command);
    if (command[1] === "container") return { code: 0, stdout: "", stderr: "" };
    fed.push(stdin);
    return answer;
  };
  return { run, commands, fed };
}

it("stages the kit into the container, feeding the script the core wrote", async () => {
  const container = spec();
  const { run, commands, fed } = host({
    code: 0,
    stdout: `staged\nkit ${KIT_DIR}\nruntime /usr/bin/node\n`,
    stderr: "",
  });
  const staged = await podmanStage(container, { runHost: run });

  expect(commands).toEqual([containerExistsCommand(container), podmanStageCommand(container)]);
  expect(commands[1]).toEqual(["podman", "exec", "-i", "env-agent", "sh", "-s"]);
  expect(fed[0]).toBe(bootstrapScript(await podmanKit(container)));
  expect(staged).toEqual({ kitDir: KIT_DIR, runtime: "/usr/bin/node" });
});

it("starts the container first when it is not there", async () => {
  const container = spec();
  const started: string[][] = [];
  const startHost: HostStart = async (command) => {
    started.push(command);
    return { name: "env-agent", alive: () => true, stop: async () => {} };
  };
  // Not there, then there; then the staging report.
  const answers: Array<HostResult["code"]> = [1, 0];
  const run: HostRun = async (command) => {
    if (command[1] === "container") {
      const code = answers.length > 1 ? answers.shift() : answers[0];
      return { code: code ?? 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: `present\nkit ${KIT_DIR}\nruntime node\n`, stderr: "" };
  };

  const staged = await podmanStage(container, { runHost: run, startHost, pollMs: 1 });
  expect(started).toHaveLength(1);
  expect(started[0]?.[1]).toBe("run");
  expect(staged.kitDir).toBe(KIT_DIR);
});

it("reports what the container said when no runtime is there", async () => {
  const { run } = host({
    code: 75,
    stdout: "error no runtime among: node nodejs bun\n",
    stderr: "",
  });
  await expect(podmanStage(spec(), { runHost: run })).rejects.toThrow(
    /staging into container env-agent failed: no runtime among: node nodejs bun/,
  );
});

it("quotes the container when it never reported at all", async () => {
  const { run } = host({
    code: 125,
    stdout: "",
    stderr: "Error: no such container: env-agent\n",
  });
  await expect(podmanStage(spec(), { runHost: run })).rejects.toThrow(
    /no report at all \(Error: no such container: env-agent\)/,
  );
});

it("refuses a relayed spec with no gateway before it reaches a container", async () => {
  const { run, commands } = host({ code: 0, stdout: "", stderr: "" });
  await expect(podmanStage(spec({ relay: true }), { runHost: run })).rejects.toThrow(/gateway/);
  expect(commands).toEqual([]);
});
