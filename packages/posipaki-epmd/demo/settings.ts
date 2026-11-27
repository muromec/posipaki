// ── what a run needs that the machine already knows ────────────────────────
//
// `erl` needs no cookie on its command line: it reads `~/.erlang.cookie`, writes one when there is none, and claims a
// name from the host it runs on. A demo says the same facts the same way, and a flag is the knob when the file or the
// host is not what a run wants.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";

/** The file `erl` keeps its cookie in. */
const COOKIE_FILE = `${homedir()}/.erlang.cookie`;

/**
 * The cookie a run uses: the flag, then `POSIPAKI_COOKIE`, then the file `erl` reads.
 *
 * A file that does not exist is written, with the owner's read and write and nothing else, which is what `erl` does with
 * its first run. The value is never printed.
 */
export function cookieOf(given?: string): string {
  if (given !== undefined) return given;
  const fromEnv = process.env.POSIPAKI_COOKIE;
  if (fromEnv !== undefined) return fromEnv;
  try {
    return readFileSync(COOKIE_FILE, "utf8").trim();
  } catch {
    const made = randomBytes(15).toString("base64").replace(/[^A-Za-z0-9]/g, "");
    writeFileSync(COOKIE_FILE, `${made}\n`, { mode: 0o600 });
    console.error(`no cookie: wrote one to ${COOKIE_FILE}, as \`erl\` would`);
    return made;
  }
}

/** The name this side claims: the flag, or `posipaki` on the host it runs on. */
export function nameOf(given?: string): string {
  return given ?? `posipaki@${hostname()}`;
}
