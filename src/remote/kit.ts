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
// A kit is named after the *host version* it serves — the app, the build its bytes came from
// and the posipaki release that speaks to it — so two consumers, two builds or two releases
// cannot land on each other's files, and the directory a kit sits in cannot disagree with the
// identity the client then states on the wire.  A payload that is started for a host version
// other than its own refuses to serve (see `hostVersionAccepts`), so a name alone is never
// mistaken for the build behind it.

import { createHash } from "node:crypto";
import { LIB_VERSION } from "../version.js";

/** Runtimes a kit is happy to be run with, best first.  A caller may override. */
export const DEFAULT_RUNTIMES = ["node", "nodejs", "bun"];

/** Layout of a staged kit — the contract's own version, recorded in `version.json`. */
export const KIT_LAYOUT = 1;

/** Where kits live on a host, relative to `$HOME`, unless the caller says otherwise. */
export const DEFAULT_KIT_PARENT = "bin/posipaki";

/** The names a kit's two bundles get: the payload, and the gateway that relays to it. */
export const PAYLOAD_ARTIFACT = "payload.js";
export const GATEWAY_ARTIFACT = "gateway.js";

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
  /** Directory name: the host version this kit serves, as {@link hostVersion} renders it. */
  name: string;
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

/** Hex sha256 of some content. */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** What may stand as one fact in a host version: no `@`, no whitespace, no `/`. */
const FACT = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

/** The label posipaki's own field carries, so nobody has to guess which field it is. */
const POSIPAKI_FIELD = "posipaki-";

/** A host version read back: what a consumer stated, and the posipaki that rendered it. */
export interface HostVersion extends KitApp {
  posipaki: string;
}

/** A name or version that could not stand as one fact in a host version. */
export class HostVersionError extends Error {}

/**
 * The one value that says what a host is expected to run: whose payload it is, which build
 * those bytes came from, and the posipaki release that speaks to it —
 * `email-agent@1.0.0+d52ee13@posipaki-0.35.0`.
 *
 * One string rather than three flags because it is one fact: it names the kit directory, it
 * travels with every way in, and the payload compares it with its own before it serves.  A
 * consumer states the two facts only it knows; posipaki renders its own release, so that
 * field cannot be got wrong.  `@` separates, and no name or version may contain one.
 */
export function hostVersion(app: KitApp): string {
  const facts: [string, string][] = [
    ["name", app.name],
    ["version", app.version],
  ];
  for (const [what, value] of facts) {
    if (!FACT.test(value)) {
      throw new HostVersionError(
        `an app ${what} must match ${FACT.source}: ${JSON.stringify(value)}`,
      );
    }
  }
  return `${app.name}@${app.version}@${POSIPAKI_FIELD}${LIB_VERSION}`;
}

/** What a {@link hostVersion} string names, or undefined when it names nothing. */
export function parseHostVersion(text: string): HostVersion | undefined {
  const fields = text.split("@");
  if (fields.length !== 3) return undefined;
  const [name, version, posipaki] = fields as [string, string, string];
  if (!FACT.test(name) || !FACT.test(version)) return undefined;
  if (!posipaki.startsWith(POSIPAKI_FIELD)) return undefined;
  const release = posipaki.slice(POSIPAKI_FIELD.length);
  if (!FACT.test(release)) return undefined;
  return { name, version, posipaki: release };
}

/** Exit code a payload refuses a start with: it is not the build that was asked for. */
export const PAYLOAD_REFUSED = 78;

export type HostVersionVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a payload may serve what it was asked for.  `own` is what its bytes carry, `asked`
 * is what the caller said — two independent facts, and one of the four combinations is the
 * dangerous one: an artifact that knows what it is, started by a caller that never said which
 * host version it is for, is exactly the stale caller we refuse.
 *
 * No baked version, nothing to compare: an artifact that does not know what it is cannot be
 * wrong about it, and a caller that states a version for such a payload is only being helpful.
 */
export function hostVersionAccepts(
  own: string | undefined,
  asked: string | undefined,
): HostVersionVerdict {
  if (own === undefined) return { ok: true };
  if (asked === undefined) {
    return { ok: false, reason: `this artifact is ${own}, and no host version was asked for` };
  }
  if (!sameHostVersion(own, asked)) {
    return { ok: false, reason: `asked to serve ${asked}, but this artifact is ${own}` };
  }
  return { ok: true };
}

/**
 * Whether two host versions are the same build.  Equality for now: {@link hostVersionAccepts}
 * is the rule, and this is the one function that decides what "the same" means — so a range, a
 * compatibility table or a protocol-only comparison is a change here and nowhere else.
 */
export function sameHostVersion(own: string, asked: string): boolean {
  return own === asked;
}

/** Wrap base64 at a comfortable width; `base64 -d` ignores the newlines. */
function wrapped(base64: string, width = 76): string {
  const lines: string[] = [];
  for (let at = 0; at < base64.length; at += width) lines.push(base64.slice(at, at + width));
  return lines.join("\n");
}

/**
 * Describe a kit around its files.  Its name is the host version it serves, and `version.json`
 * — which records that name and every file's hash — is written as one of them: it describes
 * the payload and the gateway, never itself.
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
  const kit: Kit = {
    name: hostVersion(options.app),
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

/** What `version.json` says: the identity, the facts it was rendered from, and the hashes. */
export function kitVersion(kit: Kit): Record<string, unknown> {
  return {
    hostVersion: kit.name,
    app: kit.app,
    posipaki: LIB_VERSION,
    layout: KIT_LAYOUT,
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
