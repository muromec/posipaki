#!/usr/bin/env bun
/**
 * Sends a message to a name on an Erlang node over the distribution protocol.
 *
 * The connection is `connection.ts`'s; this file is the entry: it takes the command line, sends one
 * `{DOP_REG_SEND, FromPid, '', ToName}` carrying `{From, Text}`, and prints what comes back.
 *
 *   erlc robot.erl
 *   erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
 *
 *   bun src/index.ts <host> <cookie>
 *   bun src/index.ts <host> <cookie> --to echo --message ping
 *
 * The flags are `args.ts`'s. POSIPAKI_EPMD_TRACE=1 prints what this side sends and receives.
 */

import { randomBytes } from "node:crypto";

import { parseArgs } from "./args.js";
import { connect } from "./connection.js";
import { inbox, type WireMessage } from "./messages.js";
import { render, type Term } from "./terms.js";

/** How long the answer may take before the entry gives up on it. */
const TIMEOUT_MS = 10_000;

/** Whether to print what this side sends and receives: `POSIPAKI_EPMD_TRACE=1`. */
const trace = Boolean(process.env.POSIPAKI_EPMD_TRACE);

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  // The incarnation this node claims. Every pid it writes carries it, so it is decided here and passed down.
  const creation = randomBytes(4).readUInt32BE(0) || 1;
  const connection = await connect({
    host: options.host,
    node: options.node,
    cookie: options.cookie,
    self: options.self,
    creation,
    timeoutMs: TIMEOUT_MS,
  });
  console.log(`${connection.peer.name} at ${options.host}:${connection.port}`);

  const heard = inbox(connection.messages);
  // Our own process id, so the other side has somewhere to answer: a pid is an address this connection carries,
  // and nothing there holds a process for it.
  const ourselves: Term = { kind: "pid", node: options.self, id: 1, serial: 0, creation };
  // {From, Text}: a bare term carries no sender, so nothing could answer it.
  const payload: Term = {
    kind: "tuple",
    items: [ourselves, { kind: "binary", bytes: Buffer.from(options.message, "utf8") }],
  };
  if (trace) console.error(`sending to ${options.to}: ${render(payload)}`);
  await connection.messages.send({
    kind: "message",
    control: { kind: "regSend", from: ourselves, to: options.to },
    payload,
  });

  for (;;) {
    const said: WireMessage = await heard.next(TIMEOUT_MS, "no answer to the message");
    if (said.kind !== "message") continue;
    if (trace) console.error(`received a ${said.control.kind}${said.payload === null ? "" : `: ${render(said.payload)}`}`);
    if (said.control.kind === "exit") {
      throw new Error(`the node closed the connection: ${render(said.control.reason)}`);
    }
    if (said.control.kind !== "send") continue;
    if (said.payload === null) throw new Error("a message for a process came with nothing after its control");
    console.log(render(said.payload));
    break;
  }

  await connection.messages.close("the answer is printed");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
