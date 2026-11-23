// ── the command line ────────────────────────────────────────────────────────
//
// Two positionals and three flags, and nothing else. A flag this program does not have is refused by name, and so
// is a third positional: a typo that is ignored is a run that does something other than what was asked, which is
// the expensive way to find out.

export interface Options {
  readonly host: string;
  readonly cookie: string;
  /** The registered name to send to. */
  readonly name: string;
  /** The node name this side claims. */
  readonly self: string;
  /** What to send. */
  readonly message: string;
}

/** What a command line that cannot be read is told. */
export const USAGE =
  "usage: posipaki-epmd <host> <cookie> [--name robot] [--self posipaki@<host>] [--message robot]";

/** The flags this program has. */
const FLAGS: readonly string[] = ["name", "self", "message"];

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

  const [host, cookie, ...rest] = positional;
  if (host === undefined || cookie === undefined) throw new Error(USAGE);
  if (rest.length > 0) throw new Error(`unexpected after the cookie: ${rest.join(" ")}\n${USAGE}`);

  return {
    host,
    cookie,
    name: flags.name ?? "robot",
    // A short node name carries no dot, so the default takes the peer's host: a node started with -sname refuses a
    // name that looks like a long one.
    self: flags.self ?? `posipaki@${host}`,
    message: flags.message ?? "robot",
  };
}
