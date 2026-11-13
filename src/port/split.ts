// ── bytes into parts: the splitter ──────────────────────────────────────────
//
// Cuts a stream of bytes on 0x0a; what lies between two cuts is a line.  Every byte medium does this: a stdio pair,
// a socket, an HTTP body.
//
// Splitting on the byte is safe for UTF-8: a continuation byte is never 0x0a, so a character cannot be cut in
// half, and a line is decoded only when all of its octets are in hand.  A character that straddles two chunks
// waits in the buffer, which is why this file needs no decoder of its own — and no `node:` import, because
// `posipaki/port` is the entry a browser takes.

import type { Channel, Part } from "./channel.js";
import { held } from "./held.js";

const NL = 0x0a;
const CR = 0x0d;

const EMPTY = new Uint8Array(0);
const decoder = new TextDecoder();

/** Two octet strings as one: the one place this file would otherwise reach for `Buffer`. */
function joined(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const whole = new Uint8Array(first.length + second.length);
  whole.set(first, 0);
  whole.set(second, first.length);
  return whole;
}
/** Given a line, how many raw octets follow it.  Default: none, this is a plain line. */
export type Announcement = (line: string) => number | null;

const NOTHING: Announcement = () => null;

/**
 * One byte channel in, one channel of parts out.
 *
 * The returned channel's `send` is the same rule backwards: a part becomes its line, a terminator, and the
 * octets it carried.
 */
export function splitChannel<C = string>(
  inner: Channel<Uint8Array, C>,
  announced: Announcement = NOTHING,
): Channel<Part, C> {
  const readers = new Set<(part: Part) => void>();
  const closers = new Set<(reason: C) => void>();
  const failers = new Set<(error: unknown) => void>();

  /** Bytes that are not yet a frame: a line, or the octets a line announced. */
  let buffered: Uint8Array = EMPTY;
  /** The line whose announced octets are still arriving. */
  let pending: { line: string; bytes: number } | null = null;
  let ended = false;
  let reason: C | null = null;

  const emit = (part: Part): void => {
    for (const reader of [...readers]) reader(part);
  };

  /** The far end is gone: our own readers hear it. */
  const close = (why: C): void => {
    if (ended) return;
    ended = true;
    reason = why;
    for (const closer of [...closers]) closer(why);
  };

  /**
   * End it here: the far end hears a close, our own readers do not, because we are the one who asked.  The
   * reason stays null: a sentence from this side is not `C`, which is what the other end had to say.
   */
  const shut = (): void => {
    if (ended) return;
    ended = true;
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
      const text = decoder.decode(line);
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

  // Built and wrapped before the inner channel is read: the medium may have kept frames for its first
  // reader, and subscribing drains them at once — a part produced then must be a reader's to find, not the
  // wire's to lose.
  const parts: Channel<Part, C> = held<Part, C>({
    send: async (part: Part) => {
      const head = new TextEncoder().encode(`${part.line}\n`);
      await inner.send(part.bytes === null ? head : joined(head, part.bytes));
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
      shut();
      await inner.close(why);
    },
    info: inner.info,
    control: (command) => inner.control(command),
  });

  inner.onFrame((chunk) => {
    if (ended) return;
    buffered = joined(buffered, chunk);
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
      buffered = EMPTY;
      emit({ line: decoder.decode(rest), bytes: null });
    }
    close(why);
  });

  return parts;
}
