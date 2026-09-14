// ── Kit ────────────────────────────────────────────────────────────────────
//
// Getting a payload onto a host we know nothing about.  A way in gives us a
// shell; from there one script runs everywhere: probe what is really there, write
// the kit only if it is not, and report every step as one machine-readable line.
// The script always arrives on stdin, never in argv — and since stdin *is* the
// script, the payload gets its own channel into the same environment (a second
// `ssh`, an `exec` on a container that is already running).
//
// The script assumes POSIX sh and nothing else: `command -v`, `mkdir -p`,
// `wc -c`, `base64 -d`.  A broken environment therefore reaches the client as a
// readable reason instead of a channel that just closes.
//
// A kit is named after the build that made it and the posipaki it speaks, so two
// consumers, two builds or two releases cannot land on each other's files.

import { createHash } from "node:crypto";
import { LIB_VERSION } from "../version.js";

/** Runtimes a kit is happy to be run with, best first.  A caller may override. */
export const DEFAULT_RUNTIMES = ["node", "nodejs", "bun"];

/** Layout of a staged kit — the contract's own version, recorded in `version.json`. */
export const KIT_LAYOUT = 1;

/** Where kits live on a host, relative to `$HOME`, unless the caller says otherwise. */
export const DEFAULT_KIT_PARENT = "bin/posipaki";

export interface KitFile {
  /** Name inside the kit directory, e.g. `payload.js`. */
  name: string;
  /** The file's bytes, base64 — what the script writes. */
  base64: string;
  /** Byte count, for the cheap presence check. */
  bytes: number;
  /** sha256 of the file, recorded in `version.json`. */
  sha256: string;
}

/** Who is staging this kit: the consumer's own name and build version. */
export interface KitApp {
  name: string;
  version: string;
}

export interface Kit {
  /** Directory name: `<app>-<app version>-posipaki-<posipaki version>-<manifest8>`. */
  name: string;
  /** sha256 over the manifest of the kit's own files. */
  manifestHash: string;
  /** Everything the kit installs, `version.json` last. */
  files: KitFile[];
  /** Runtime candidates, in order; the first one found wins. */
  runtimes: string[];
  /** Directory the kit lands in, relative to the host's `$HOME`. */
  parent: string;
  /** The consumer this kit belongs to. */
  app: KitApp;
}

export interface MakeKitOptions {
  /** Required: a kit with no owner cannot be told apart from another's. */
  app: KitApp;
  /** Defaults to {@link DEFAULT_RUNTIMES}. */
  runtimes?: string[];
  /** Defaults to {@link DEFAULT_KIT_PARENT}. */
  parent?: string;
}

export type BootstrapReport =
  | { kind: "ready"; kitDir: string; runtime: string; staged: boolean }
  | { kind: "error"; reason: string };

/** The part an artifact plays when it names itself. */
export type ArtifactRole = "gateway" | "payload";

/** Hex sha256 of some content. */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The directory name a kit with these contents, this owner and this posipaki gets. */
export function kitName(app: KitApp, manifestHash: string): string {
  return `${app.name}-${app.version}-posipaki-${LIB_VERSION}-${manifestHash.slice(0, 8)}`;
}

/**
 * One line naming a staged artifact: what it is, which posipaki it speaks, which
 * kit layout it was built for.  A client that staged it can judge compatibility
 * from this alone — nothing else is claimed.
 */
export function versionLine(app: KitApp, role: ArtifactRole, proto: string): string {
  return `${app.name}-${role} ${app.version} posipaki ${LIB_VERSION} proto ${proto} layout ${KIT_LAYOUT}`;
}

/** Wrap base64 at a comfortable width; `base64 -d` ignores the newlines. */
function wrapped(base64: string, width = 76): string {
  const lines: string[] = [];
  for (let at = 0; at < base64.length; at += width) lines.push(base64.slice(at, at + width));
  return lines.join("\n");
}

/**
 * Describe a kit around its files.  The manifest hash covers the files only, so
 * `version.json` — which records that hash — can be one of them without chasing
 * its own tail.
 */
export function makeKit(
  files: { name: string; content: string | Uint8Array }[],
  options: MakeKitOptions,
): Kit {
  const raw = files.map((file) => ({
    name: file.name,
    bytes: Buffer.byteLength(file.content),
    sha256: sha256Hex(file.content),
    base64: Buffer.from(file.content).toString("base64"),
  }));
  const manifestHash = sha256Hex(raw.map((f) => `${f.name} ${f.sha256} ${f.bytes}`).join("\n"));
  const kit: Kit = {
    name: kitName(options.app, manifestHash),
    manifestHash,
    files: raw,
    runtimes: [...(options.runtimes ?? DEFAULT_RUNTIMES)],
    parent: options.parent ?? DEFAULT_KIT_PARENT,
    app: options.app,
  };
  const version = Buffer.from(`${JSON.stringify(kitVersion(kit), null, 2)}\n`);
  return {
    ...kit,
    files: [
      ...kit.files,
      {
        name: "version.json",
        bytes: version.byteLength,
        sha256: sha256Hex(version),
        base64: version.toString("base64"),
      },
    ],
  };
}

/** What `version.json` says: identity, versions, and the exact content hashes. */
export function kitVersion(kit: Kit): Record<string, unknown> {
  return {
    kit: kit.name,
    app: kit.app,
    posipaki: LIB_VERSION,
    layout: KIT_LAYOUT,
    manifestHash: kit.manifestHash,
    files: kit.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
  };
}

/** The `[ -f … ] && [ "$(wc -c < …)" -eq … ]` test for one file. */
function presentTest(file: KitFile): string {
  return `[ -f "$kit_dir/${file.name}" ] && [ "$(wc -c < "$kit_dir/${file.name}")" -eq ${file.bytes} ]`;
}

/** One file: write it to a temp name, then move it into place. */
function writeFile(file: KitFile): string {
  return [
    `  base64 -d > "$tmp" <<'KIT_FILE'`,
    wrapped(file.base64),
    "KIT_FILE",
    `  mv "$tmp" "$kit_dir/${file.name}" || { echo "error cannot install ${file.name}"; exit 73; }`,
  ].join("\n");
}

/**
 * The bootstrap, as one POSIX sh script.
 *
 * Staging is the whole job.  The script always arrives on stdin, never in argv,
 * and that is also why it cannot carry the wire: the caller runs the payload on a
 * second channel into the same environment once this one has reported.
 */
export function bootstrapScript(kit: Kit): string {
  const checks = kit.files.map(presentTest).join(" && \\\n  ");
  const lines = [
    "# ── kit bootstrap ─────────────────────────────────────────────────────────",
    "# probe, stage what is missing, report every step as one machine-readable line.",
    "set -u",
    "",
    'if [ -z "${HOME:-}" ]; then echo "error HOME is not set"; exit 74; fi',
    `kit_dir="$HOME/${kit.parent}/${kit.name}"`,
    "",
    'runtime=""',
    `for candidate in ${kit.runtimes.join(" ")}; do`,
    '  if command -v "$candidate" >/dev/null 2>&1; then runtime="$(command -v "$candidate")"; break; fi',
    "done",
    `if [ -z "$runtime" ]; then echo "error no runtime among: ${kit.runtimes.join(" ")}"; exit 75; fi`,
    'if ! command -v base64 >/dev/null 2>&1; then echo "error base64 is missing"; exit 76; fi',
    "",
    `if ${checks}; then`,
    '  echo "present"',
    "else",
    `  mkdir -p "$kit_dir" || { echo "error cannot create $kit_dir"; exit 73; }`,
    '  tmp="$kit_dir/.staging.$$"',
    ...kit.files.map(writeFile),
    '  echo "staged"',
    "fi",
    'echo "kit $kit_dir"',
    'echo "runtime $runtime"',
  ];
  return `${lines.join("\n")}\n`;
}

/** Read the script's report back.  Missing or unknown lines are an error. */
export function parseBootstrapReport(stdout: string): BootstrapReport {
  let kitDir = "";
  let runtime = "";
  let staged: boolean | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("error ")) return { kind: "error", reason: line.slice("error ".length) };
    if (line === "staged") {
      staged = true;
      continue;
    }
    if (line === "present") {
      staged = false;
      continue;
    }
    if (line.startsWith("kit ")) {
      kitDir = line.slice("kit ".length);
      continue;
    }
    if (line.startsWith("runtime ")) {
      runtime = line.slice("runtime ".length);
      continue;
    }
  }
  if (kitDir === "" || runtime === "" || staged === null) {
    const seen = stdout.trim();
    return {
      kind: "error",
      reason: seen === "" ? "no report at all" : `incomplete report: ${seen}`,
    };
  }
  return { kind: "ready", kitDir, runtime, staged };
}
