// ── the command line ────────────────────────────────────────────────────────
//
// One positional and five flags, and nothing else. A flag this program does not have is refused by name, and so is a
// second positional: a typo that is ignored is a run that did something other than what was asked, which is the expensive
// way to find out.

import { cookieOf } from "./settings.js";

export interface Options {
  readonly host: string;
  readonly cookie: string;
  /** The node's name in epmd, without a host: `robot` for `robot@tomato`. */
  readonly node: string;
  /** The name to send to on that node. A node usually answers for its own name, so that is the default. */
  readonly to: string;
  /** The node name this side claims. */
  readonly self: string;
  /** What to send. */
  readonly message: string;
}

/** What a command line that cannot be read is told. */
export const USAGE =
  "usage: posipaki-epmd <host> [--cookie <cookie>] [--node robot] [--to robot] [--self posipaki@<host>] [--message robot]";

/** The flags this program has. */
const FLAGS: readonly string[] = ["cookie", "node", "to", "self", "message"];

/** A command line as the facts a run needs, or a sentence saying what is wrong with it. */
export function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const flag = item.slice(2);
    if (!FLAGS.includes(flag)) {
      throw new Error(`there is no --${flag}: this program has --${FLAGS.join(", --")}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    flags[flag] = value;
    index += 1;
  }

  const [host, ...rest] = positional;
  if (host === undefined) throw new Error(USAGE);
  if (rest.length > 0) throw new Error(`unexpected after the host: ${rest.join(" ")}\n${USAGE}`);

  const node = flags.node ?? "robot";
  return {
    host,
    // The cookie is not an argument unless a run insists: `erl` reads the same file, and a value on a command line is a
    // value in `ps`.
    cookie: cookieOf(flags.cookie),
    node,
    to: flags.to ?? node,
    // A short node name carries no dot, so the default takes the peer's host: a node started with -sname refuses a
    // name that looks like a long one.
    self: flags.self ?? `posipaki@${host}`,
    message: flags.message ?? "robot",
  };
}
