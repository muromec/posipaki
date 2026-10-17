// ── the far end's own output ───────────────────────────────────────────────
//
// A program that prints says so in a stream it announces under a name — `stdout`, `stderr` — on the
// connection it speaks on, and the reader takes it like any other stream.  This is the layer between
// such a stream and a sink: decode the octets and hand them on, or write them tagged to our own
// stderr.
//
// Nothing here is a frame.  A stream is the wire's own carrier for bytes, so the reader that wants
// the output of something it spawned asks for the name and reads; there is nothing to strip off the
// frame stream, and no second way for a program's words to reach this side.

import type { Stream } from "./stream.js";

/** Where the far end's own output goes: the stream it came on, and the text it carried. */
export type OutputSink = (name: string, data: string) => void;

/** Write the far end's output to our stderr, tagged with the name of the process that printed. */
export function stderrSink(pname = ""): OutputSink {
  const tag = pname ? `[${pname}] ` : "";
  return (name, data) => {
    const lead = name === "stderr" ? `${tag}err: ` : tag;
    for (const line of data.split("\n")) {
      if (line.length > 0) process.stderr.write(`${lead}${line}\n`);
    }
  };
}

/**
 * Read a named stream into a sink, decoding the octets as text as they arrive.
 *
 * A stream that fails ends the pump quietly: the far end going away is the end of its output, not an
 * error to raise on this side.
 */
export function pumpOutput(stream: Stream, name: string, sink: OutputSink): void {
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of stream) sink(name, decoder.decode(chunk, { stream: true }));
      const tail = decoder.decode();
      if (tail.length > 0) sink(name, tail);
    } catch {
      /* the far end went: what it said is what arrived */
    }
  })();
}
