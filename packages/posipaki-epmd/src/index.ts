#!/usr/bin/env bun
/**
 * Sends a message to a name on an Erlang node over the distribution protocol.
 *
 * The layers this is built from, bottom up: a posipaki socket channel, `frame` for the length a packet announces,
 * `messages` for what a frame says, `handshake` for the cookie and the point where the wire widens, and `epmd` for
 * where the node listens. This file is the entry: it picks the names, sends one message and prints the answer.
 *
 *   erlc robot.erl
 *   erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
 *
 *   bun src/index.ts <host> <cookie>
 *
 * The flags are `args.ts`'s: two positionals, three flags, and a sentence for anything else.
 * POSIPAKI_EPMD_TRACE=1 prints what this side sends and receives.
 */

import { randomBytes } from "node:crypto";

import { socketChannel } from "posipaki/port/node";

import { parseArgs } from "./args.js";
import { writeControl, type Control } from "./control.js";
import { epmdPort } from "./epmd.js";
import { wrapEpmdFrame } from "./frame.js";
import { handshake } from "./handshake.js";
import { inbox, withMeaning, type WireMessage } from "./messages.js";
import { render, type Term } from "./terms.js";

const EPMD_PORT = 4369;

/** How long one step waits for the node before the script gives up. */
const TIMEOUT_MS = 10_000;

// dist.h's DFLAG_DIST_MANDATORY_25 and DFLAG_UNLINK_ID: a node refuses a connection that lacks any of them. The
// flags word is sixty-four bits, written high half first, so the two are not one number here.
const FLAGS_HIGH = 0x4;
const FLAGS_LOW =
  0x4 | 0x10 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x10000 | 0x20000 | 0x40000 | 0x1000000 | 0x2000000;


const trace = Boolean(process.env.POSIPAKI_EPMD_TRACE);

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const port = await epmdPort(await socketChannel({ host: options.host, port: EPMD_PORT }), {
    host: options.host,
    name: options.name,
  });

  const frames = wrapEpmdFrame(await socketChannel({ host: options.host, port }));
  const messages = withMeaning(frames);
  const heard = inbox(messages);
  const creation = randomBytes(4).readUInt32BE(0) || 1;
  const peer = await handshake(
    { frames, messages },
    {
      self: options.self,
      cookie: options.cookie,
      flags: [FLAGS_HIGH, FLAGS_LOW],
      creation,
      timeoutMs: TIMEOUT_MS,
    },
  );
  console.log(`${peer.name} at ${options.host}:${port}`);

  // Our own process id, so the other side has somewhere to answer: a pid is an address this connection carries,
  // and nothing there holds a process for it.
  const ourselves: Term = { kind: "pid", node: options.self, id: 1, serial: 0, creation };
  const control: Control = { kind: "regSend", from: ourselves, to: options.name };
  // {From, Text}: a bare term carries no sender, so nothing could answer it.
  const payload: Term = {
    kind: "tuple",
    items: [ourselves, { kind: "binary", bytes: Buffer.from(options.message, "utf8") }],
  };
  if (trace) console.error(`sending ${render(writeControl(control))} ${render(payload)}`);
  await messages.send({ kind: "message", control, payload });

  for (;;) {
    const said: WireMessage = await heard.next(TIMEOUT_MS, "no answer to the message");
    if (said.kind !== "message") continue;
    if (trace) console.error(`received ${render(writeControl(said.control))} ${said.payload === null ? "" : render(said.payload)}`);
    if (said.control.kind === "exit") {
      throw new Error(`the node closed the connection: ${render(said.control.reason)}`);
    }
    if (said.control.kind !== "send") continue;
    if (said.payload === null) throw new Error("a message for a process came with nothing after its control");
    console.log(render(said.payload));
    break;
  }

  await frames.close("the answer is printed");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
