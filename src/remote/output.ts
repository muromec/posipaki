// ── the far end's own output ───────────────────────────────────────────────
//
// A process that prints says so in a frame of the connection (`outputFrame`, channel.ts): the
// number is the stream a program knows, and the payload is what it wrote.  This is the layer
// that routes those frames — above the protocol step, on whichever end holds the connection —
// so both ends carry the far end's own words the same way, and nothing below the frames knows
// they exist.  Where they go is the holder's business: `stderrSink` for a plain client, a
// terminal for one that has an operator in front of it.

import { channelThrough, type Channel } from "./channel.js";
import { outputOf, type OutputFd } from "./channel.js";

/** Where the far end's own output goes. */
export type OutputSink = (fd: OutputFd, data: string) => void;

/** Write the far end's output to our stderr, tagged with its name. */
export function stderrSink(name = ""): OutputSink {
  const tag = name ? `[${name}] ` : "";
  return (fd, data) => {
    const lead = fd === 2 ? `${tag}err: ` : tag;
    for (const line of data.split("\n")) {
      if (line.length > 0) process.stderr.write(`${lead}${line}\n`);
    }
  };
}

/**
 * A connection whose far end's output goes to `sink`, and whose other frames go on as they did.
 *
 * Every frame the far side sends arrives at this side's holder; the ones that are the far end's
 * own print are not the protocol's, so they are taken off here rather than handed to the seam.
 */
export function withOutput(channel: Channel, sink: OutputSink): Channel {
  return channelThrough(channel, (frame) => {
    const output = outputOf(frame);
    if (!output) return false;
    sink(output.fd, output.data);
    return true;
  });
}
