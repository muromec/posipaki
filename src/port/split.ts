// ── bytes into parts: the splitter ──────────────────────────────────────────
//
// The adapter every byte medium needs, and the one rule that does not change between a stdio pair, a socket
// and an HTTP body: a stream of bytes is cut on 0x0a, and what comes between two cuts is a line.
//
// Splitting on the byte is safe for UTF-8 — a continuation byte is never 0x0a — so a character that straddles
// two chunks costs nothing but the buffer carrying it until the rest arrives.  The decode is the other
// direction of the same worry: what a caller reads is text, and a StringDecoder is what makes half a
// character wait rather than become two replacement marks.
//
// A line may announce octets after it.  That is not this file's vocabulary — the generic splitter announces
// nothing — so the rule travels in as a question: given a line, how many raw octets follow it?  The seam
// answers with `$chunk`, a protocol with something else, and a medium with no such thing answers none.

import { StringDecoder } from "node:string_decoder";

import type { Channel, Part } from "./channel.js";

const NL = 0x0a;
const CR = 0x0d;

/** Given a line, how many raw octets follow it.  Default: none, this is a plain line. */
export type Announcement = (line: string) => number | null;

const NOTHING: Announcement = () => null;

/**
 * One byte channel in, one channel of parts out.
 *
 * The returned channel's `send` is the same rule backwards: a part becomes its line, a terminator, and the
 * octets it carried.
 */
export function splitChannel(
  inner: Channel<Uint8Array>,
  announced: Announcement = NOTHING,
): Channel<Part> {
  const readers = new Set<(part: Part) => void>();
  const closers = new Set<(reason: string) => void>();
  const failers = new Set<(error: unknown) => void>();
  const decoder = new StringDecoder("utf8");
  /** Bytes that are not yet a frame: a line, or the octets a line announced. */
  let buffered = Buffer.alloc(0);
  /** The line whose announced octets are still arriving. */
  let pending: { line: string; bytes: number } | null = null;
  let ended = false;
  let reason: string | null = null;

  const emit = (part: Part): void => {
    for (const reader of [...readers]) reader(part);
  };

  /** The far end is gone: our own readers hear it. */
  const close = (why: string): void => {
    if (ended) return;
    ended = true;
    reason = why;
    for (const closer of [...closers]) closer(why);
  };

  /** End it here: the far end hears a close, our own readers do not — we are the ones who asked. */
  const shut = (why: string): void => {
    if (ended) return;
    ended = true;
    reason = why;
  };

  /** Hand over what the buffer holds, as far as the framing allows. */
  const drain = (): void => {
    while (!ended) {
      if (pending !== null) {
        if (buffered.length < pending.bytes) return;
        const bytes = buffered.subarray(0, pending.bytes);
        buffered = buffered.subarray(pending.bytes);
        const line = pending.line;
        pending = null;
        emit({ line, bytes: new Uint8Array(bytes) });
        continue;
      }
      const cut = buffered.indexOf(NL);
      if (cut === -1) return;
      const raw = buffered.subarray(0, cut);
      buffered = buffered.subarray(cut + 1);
      const line = raw.length > 0 && raw[raw.length - 1] === CR ? raw.subarray(0, raw.length - 1) : raw;
      const text = decoder.write(line);
      const count = announced(text);
      if (count === null) {
        emit({ line: text, bytes: null });
        continue;
      }
      pending = { line: text, bytes: count };
      if (count === 0) {
        pending = null;
        emit({ line: text, bytes: new Uint8Array(0) });
      }
    }
  };

  inner.onFrame((chunk) => {
    if (ended) return;
    buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, Buffer.from(chunk)]);
    drain();
  });
  inner.onError((error) => {
    for (const failer of [...failers]) failer(error);
  });
  inner.onClose((why) => {
    if (ended) return;
    // Whatever is left without a terminator is still a line: a peer that hangs up after writing has said
    // something, and dropping it would be the framing deciding to lose the last word.
    if (pending === null && buffered.length > 0) {
      const rest = buffered;
      buffered = Buffer.alloc(0);
      emit({ line: decoder.write(rest) + decoder.end(), bytes: null });
    } else {
      decoder.end();
    }
    close(why);
  });

  return {
    send: async (part: Part) => {
      const head = Buffer.from(`${part.line}\n`, "utf8");
      const body = part.bytes === null ? head : Buffer.concat([head, Buffer.from(part.bytes)]);
      await inner.send(new Uint8Array(body));
    },
    onFrame: (handler) => {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose: (handler) => {
      if (ended && reason !== null) {
        handler(reason);
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError: (handler) => {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: async (why = "closed here") => {
      shut(why);
      await inner.close(why);
    },
  };
}
