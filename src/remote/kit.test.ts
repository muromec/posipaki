// ── Kit ────────────────────────────────────────────────────────────────────
//
// The script is the artifact, so the tests run the artifact: real `sh`, a
// throwaway `$HOME`, and a stub runtime on PATH.  No ssh, no container, no host.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIB_VERSION } from "../version.js";
import {
  DEFAULT_RUNTIMES,
  KIT_LAYOUT,
  bootstrapScript,
  kitVersion,
  makeKit,
  parseBootstrapReport,
  sha256Hex,
  hostVersion,
  parseHostVersion,
  versionLine,
} from "./kit.js";

const APP = { name: "test-app", version: "1.2.3" };

const KIT_FILES = [
  { name: "payload.js", content: 'console.log("payload v1");\n' },
  { name: "gateway.js", content: 'console.log("gateway v1");\n' },
];

/** A script run the way a way in runs it: `sh -s`, the script on stdin. */
function runOnStdin(script: string, env: Record<string, string>) {
  const child = spawn("/bin/sh", ["-s"], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stdin.end(script);
  return collected(child);
}

/** The payload channel: a short argv command with stdin free for the wire. */
function runInArgv(script: string, env: Record<string, string>, stdin = "") {
  const child = spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stdin.end(stdin);
  return collected(child);
}

function collected(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => out.push(chunk));
  child.stderr?.on("data", (chunk: string) => err.push(chunk));
  return new Promise((settle) => {
    child.once("close", (code) => settle({ code, stdout: out.join(""), stderr: err.join("") }));
  });
}

/** A throwaway home. */
function scratchHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "posipaki-kit-home-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A `node` that is not node: records its argv and what it found on stdin. */
function stubRuntime(dir: string, name = "node"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nread -r line\nprintf "ran %s stdin=%s\\n" "$*" "$line"\n');
  chmodSync(path, 0o755);
  return path;
}

/** PATH with the stub runtime first and the real tools behind it. */
function pathWith(bin: string): string {
  return `${bin}:/usr/bin:/bin`;
}

describe("kit bootstrap", () => {
  it("stages a kit into a home that has nothing, then leaves it alone", async () => {
    const { home, cleanup } = scratchHome();
    try {
      const bin = join(home, "bin");
      stubRuntime(bin);
      const kit = makeKit(KIT_FILES, { app: APP });
      const env = { HOME: home, PATH: pathWith(bin) };

      const first = parseBootstrapReport((await runOnStdin(bootstrapScript(kit), env)).stdout);
      if (first.kind !== "ready") throw new Error(`expected a staged kit: ${first.reason}`);
      expect(first.staged).toBe(true);
      expect(first.kitDir).toBe(join(home, kit.parent, kit.name));
      for (const file of kit.files) {
        expect(statSync(join(first.kitDir, file.name)).size).toBe(file.bytes);
      }

      const second = parseBootstrapReport((await runOnStdin(bootstrapScript(kit), env)).stdout);
      if (second.kind !== "ready") throw new Error(`expected a ready kit: ${second.reason}`);
      expect(second.staged).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("re-installs a kit whose file was tampered with", async () => {
    const { home, cleanup } = scratchHome();
    try {
      const bin = join(home, "bin");
      stubRuntime(bin);
      const kit = makeKit(KIT_FILES, { app: APP });
      const env = { HOME: home, PATH: pathWith(bin) };

      const first = parseBootstrapReport((await runOnStdin(bootstrapScript(kit), env)).stdout);
      if (first.kind !== "ready") throw new Error(`expected a staged kit: ${first.reason}`);
      writeFileSync(join(first.kitDir, "payload.js"), "tampered");

      const again = parseBootstrapReport((await runOnStdin(bootstrapScript(kit), env)).stdout);
      if (again.kind !== "ready") throw new Error(`expected a ready kit: ${again.reason}`);
      expect(again.staged).toBe(true);
      expect(readFileSync(join(again.kitDir, "payload.js"), "utf-8")).toBe(
        'console.log("payload v1");\n',
      );
    } finally {
      cleanup();
    }
  });

  it("keeps two builds apart, so one consumer never writes over another", async () => {
    const { home, cleanup } = scratchHome();
    try {
      const bin = join(home, "bin");
      stubRuntime(bin);
      const env = { HOME: home, PATH: pathWith(bin) };
      const mine = makeKit(KIT_FILES, { app: APP });
      const theirs = makeKit([{ name: "payload.js", content: 'console.log("payload v2");\n' }], {
        app: { name: "other-app", version: "9.9.9" },
      });

      const first = parseBootstrapReport((await runOnStdin(bootstrapScript(mine), env)).stdout);
      const second = parseBootstrapReport((await runOnStdin(bootstrapScript(theirs), env)).stdout);
      if (first.kind !== "ready" || second.kind !== "ready") throw new Error("expected both staged");

      expect(first.kitDir).not.toBe(second.kitDir);
      expect(readFileSync(join(second.kitDir, "payload.js"), "utf-8")).toContain("payload v2");
    } finally {
      cleanup();
    }
  });

  it("says what the environment is missing instead of guessing", async () => {
    const { home, cleanup } = scratchHome();
    try {
      const kit = makeKit(KIT_FILES, { app: APP });

      const noRuntime = await runOnStdin(bootstrapScript(kit), { HOME: home, PATH: "" });
      expect(noRuntime.code).toBe(75);
      expect(noRuntime.stdout).toContain(`error no runtime among: ${DEFAULT_RUNTIMES.join(" ")}`);

      const noHome = await runOnStdin(bootstrapScript(kit), { PATH: "/usr/bin:/bin" });
      expect(noHome.code).toBe(74);
      expect(noHome.stdout).toContain("error HOME is not set");

      // A runtime, but nothing to decode the kit with.
      const bin = join(home, "bin");
      stubRuntime(bin);
      const noBase64 = await runOnStdin(bootstrapScript(kit), { HOME: home, PATH: bin });
      expect(noBase64.code).toBe(76);
      expect(noBase64.stdout).toContain("error base64 is missing");

      // A runtime nobody named is not a runtime we use.
      const other = join(home, "other");
      stubRuntime(other, "ruby");
      const wrongRuntime = await runOnStdin(bootstrapScript(kit), { HOME: home, PATH: other });
      expect(wrongRuntime.code).toBe(75);
    } finally {
      cleanup();
    }
  });

  it("stages on one channel, and the payload takes stdin on the next", async () => {
    const { home, cleanup } = scratchHome();
    try {
      const bin = join(home, "bin");
      const runtime = stubRuntime(bin);
      const kit = makeKit(KIT_FILES, { app: APP });
      const env = { HOME: home, PATH: pathWith(bin) };

      // Channel one: the script *is* stdin, so it can carry no wire — and it must
      // never exec, or it would look like the kit had taken the channel over.
      const script = bootstrapScript(kit);
      expect(script).not.toContain("exec ");
      const staged = parseBootstrapReport((await runOnStdin(script, env)).stdout);
      if (staged.kind !== "ready") throw new Error(`expected a staged kit: ${staged.reason}`);
      expect(staged.runtime).toBe(runtime);

      // Channel two: the staged payload runs with a stdin of its own.
      const run = await runInArgv(
        `exec "${staged.runtime}" "${staged.kitDir}/payload.js" --env=probe --stdio`,
        env,
        "wire\n",
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("ran ");
      expect(run.stdout).toContain("stdin=wire");
      expect(run.stdout).toContain("--env=probe --stdio");
    } finally {
      cleanup();
    }
  });

  it("lands where the caller says, with the runtimes it was given", () => {
    const kit = makeKit(KIT_FILES, { app: APP, runtimes: ["deno"], parent: "opt/kits" });
    expect(kit.runtimes).toEqual(["deno"]);
    expect(kit.parent).toBe("opt/kits");
    expect(bootstrapScript(kit)).toContain("opt/kits/");
    expect(bootstrapScript(kit)).toContain("for candidate in deno; do");
  });
});

describe("kit description", () => {
  it("names a kit after its owner, its build and its contents", () => {
    const kit = makeKit(KIT_FILES, { app: APP });
    expect(kit.name).toContain(APP.name);
    expect(kit.name).toContain(APP.version);
    expect(kit.name).toContain(LIB_VERSION);
    expect(kit.name).toContain(kit.manifestHash.slice(0, 8));

    expect(makeKit(KIT_FILES, { app: APP }).name).toBe(kit.name);
    expect(makeKit(KIT_FILES, { app: { name: APP.name, version: "2.0.0" } }).name).not.toBe(kit.name);
    expect(
      makeKit([{ name: "payload.js", content: "payload v2" }], { app: APP }).name,
    ).not.toBe(kit.name);
  });

  it("records who it is and what it holds in version.json", () => {
    const kit = makeKit(KIT_FILES, { app: APP });
    const file = kit.files.find((f) => f.name === "version.json");
    expect(file).toBeDefined();
    const bytes = Buffer.from(file!.base64, "base64");
    expect(sha256Hex(bytes)).toBe(file!.sha256);

    const version = JSON.parse(bytes.toString("utf-8")) as Record<string, unknown>;
    expect(version.kit).toBe(kit.name);
    expect(version.app).toEqual(APP);
    expect(version.posipaki).toBe(LIB_VERSION);
    expect(version.layout).toBe(KIT_LAYOUT);
    expect(version.manifestHash).toBe(kit.manifestHash);
    // The manifest lists what the caller staged; version.json cannot list itself.
    expect(version.files).toEqual(
      KIT_FILES.map((f) => ({
        name: f.name,
        sha256: sha256Hex(f.content),
        bytes: Buffer.byteLength(f.content),
      })),
    );
  });

  it("leaves the manifest hash out of its own tail: version.json is not in it", () => {
    const kit = makeKit(KIT_FILES, { app: APP });
    const filesOnly = KIT_FILES.map(
      (f) => `${f.name} ${sha256Hex(f.content)} ${Buffer.byteLength(f.content)}`,
    ).join("\n");
    expect(kit.manifestHash).toBe(sha256Hex(filesOnly));
    expect(kit.files.length).toBe(KIT_FILES.length + 1);
    expect(kitVersion(kit).manifestHash).toBe(kit.manifestHash);
  });

  it("names an artifact in one line a client can judge", () => {
    const line = versionLine(APP, "gateway", "json.v1");
    expect(line).toBe(`${APP.name}-gateway ${APP.version} posipaki ${LIB_VERSION} proto json.v1 layout ${KIT_LAYOUT}`);
  });

  it("names whose payload it is in one value, and reads that value back", () => {
    // What a consumer hands a way in, and the way in hands the gateway: one string,
    // because the app name and the build are one fact about the bytes.
    expect(hostVersion({ name: "email-agent", version: "1.0.0+d52ee13" })).toBe(
      "email-agent@1.0.0+d52ee13",
    );
    expect(parseHostVersion("email-agent@1.0.0+d52ee13")).toEqual({
      name: "email-agent",
      version: "1.0.0+d52ee13",
    });
  });

  it("refuses a value that names nothing, rather than guessing at its halves", () => {
    for (const text of ["", "email-agent", "@1.0.0", "email-agent@", "@"]) {
      expect(parseHostVersion(text)).toBeUndefined();
    }
  });
});

describe("bootstrap report", () => {
  it("reads the three lines the script prints", () => {
    expect(parseBootstrapReport("staged\nkit /home/x/bin/posipaki/k\nruntime /usr/bin/node\n")).toEqual(
      { kind: "ready", kitDir: "/home/x/bin/posipaki/k", runtime: "/usr/bin/node", staged: true },
    );
    expect(parseBootstrapReport("present\nkit /k\nruntime /r\n")).toEqual({
      kind: "ready",
      kitDir: "/k",
      runtime: "/r",
      staged: false,
    });
  });

  it("turns a broken environment into a reason, never a guess", () => {
    expect(parseBootstrapReport("error no runtime among: node\n")).toEqual({
      kind: "error",
      reason: "no runtime among: node",
    });
    expect(parseBootstrapReport("kit /k\nruntime /r\n")).toEqual({
      kind: "error",
      reason: "incomplete report: kit /k\nruntime /r",
    });
    expect(parseBootstrapReport("")).toEqual({ kind: "error", reason: "no report at all" });
    expect(parseBootstrapReport("something else entirely\n")).toEqual({
      kind: "error",
      reason: "incomplete report: something else entirely",
    });
  });
});
