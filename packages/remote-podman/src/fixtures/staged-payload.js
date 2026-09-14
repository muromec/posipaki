// ── what a staged payload looks like from the outside ──────────────────────
//
// The process on the far side of the run channel: says hello on the wire, echoes
// what it is asked to echo, prints a line of its own so a test can watch output
// being kept out of the protocol, and leaves when it is told to.  Plain node, no
// imports beyond builtins — this stands in for `ssh`, which is never needed here.

import * as readline from "node:readline";

process.stdout.write('{"$proto":"json.v1"}\n');
process.stderr.write("the far end is ready\n");

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  const body = frame.$msg?.body;
  if (body?.type === "BYE") {
    process.stdout.write('{"$exit":{"code":0,"state":{"said":true}}}\n');
    process.exit(0);
  }
  process.stdout.write(
    `${JSON.stringify({ $msg: { fromName: "staged-payload", body: { echo: body?.echo ?? null } } })}\n`,
  );
});
