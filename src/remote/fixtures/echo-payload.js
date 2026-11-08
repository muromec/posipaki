// ── a payload for the gateway tests ────────────────────────────────────────
//
// Connects the fifos it was pointed at, speaks the wire, echoes every frame it
// is asked to echo, and prints a line of its own so a test can watch the gateway
// carry output frames.  Plain node, no imports beyond builtins: this is what the
// gateway relays to, and what a staged kit looks like from the inside.

import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as readline from "node:readline";

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);

const fifoIn = arg("fifo-in");
const fifoOut = arg("fifo-out");
if (!fifoIn || !fifoOut) process.exit(1);

const writeFd = await open(fifoIn, "w");
const readFd = await open(fifoOut, "r");

process.stdout.write("payload alive\n");
await writeFd.write('{"$proto":"json.v1"}\n');

const rs = createReadStream("", { fd: readFd.fd, encoding: "utf-8", autoClose: false });
const rl = readline.createInterface({ input: rs });

/**
 * The client's protocol frame, before anything else will be answered: a peer that serves speaks and
 * then waits, and a client that only listened leaves it waiting.  Anything else first is refused the
 * way a payload refuses it.
 */
let agreed = false;

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.$proto !== undefined) {
    agreed = true;
    return;
  }
  if (!agreed) {
    process.stderr.write(`payload: ${line} arrived before the protocol was named\n`);
    process.exit(78);
  }
  const body = msg.$msg?.body;
  if (body?.type === "BYE") {
    await writeFd.write('{"$exit":{"code":0,"state":{"echoed":true}}}\n');
    process.exit(0);
  }
  await writeFd.write(
    JSON.stringify({ $msg: { fromName: "payload", body: { echo: body?.echo ?? null } } }) + "\n",
  );
});
