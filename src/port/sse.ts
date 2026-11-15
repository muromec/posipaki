// ── SSE: events out of lines ────────────────────────────────────────────────
//
// Server-sent events are a wire format, not a medium: one event is the `data:` lines that belong together,
// joined by a newline, and an empty line ends it.  Everything else on the wire belongs to the transport —
// `event:`, `id:`, `retry:`, and a comment that starts with `:`.
//
// So this is an adapter over lines, the way `json1` is an adapter over parts: bytes → `splitChannel` →
// here.  What the payload *means* (JSON-RPC, a task update) is the reader's business.

import type { Channel, Part } from "./channel.js";
import { held } from "./held.js";

/**
 * The `data` a line carries.
 *
 * `data:` is SSE's own field.  A2A also answers a subscription it will not serve with one JSON document
 * instead of a stream — a JSON-RPC refusal — so a whole line that is an object is taken as an event as well.
 * Everything else on the wire (`event:`, `id:`, `retry:`, a comment) belongs to the transport.
 */
function payloadOf(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('data:')) return trimmed.slice('data:'.length).trimStart();
  if (trimmed.startsWith('{')) return trimmed;
  return null;
}

/** A channel of lines, read as SSE events: one value per event, the empty ones skipped. */
export function sseChannel<C>(parts: Channel<Part, C>): Channel<string, C> {
  const readers = new Set<(event: string) => void>();
  const closers = new Set<(reason: C) => void>();
  const failers = new Set<(error: unknown) => void>();
  /** The `data` lines of the event being read, in the order they arrived. */
  let pending: string[] = [];
  let ended = false;
  let reason: C | null = null;

  const deliver = (event: string): void => {
    for (const reader of readers) reader(event);
  };

  /** An empty line ends an event; an event with no `data` line is not one and is dropped. */
  const boundary = (): void => {
    if (pending.length === 0) return;
    const event = pending.join('\n');
    pending = [];
    deliver(event);
  };

  const close = (why: C): void => {
    if (ended) return;
    ended = true;
    reason = why;
    for (const closer of closers) closer(why);
  };

  // Held before the lines are read: the medium may have kept what it produced for its first reader, and that
  // arrives the moment this subscribes.
  const events: Channel<string, C> = held<string, C>({
    send: () => Promise.reject(new Error('an event source has no input')),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      if (ended && reason !== null) {
        handler(reason);
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError(handler) {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: (why) => parts.close(why),
    info: parts.info,
    control: (command) => parts.control(command),
    // The events of a stream are read as they arrive: what is standing below is the transport's business.
    hasFrames: () => parts.hasFrames(),
  });

  parts.onFrame(({ line }) => {
    if (ended) return;
    if (line.trim() === '') {
      boundary();
      return;
    }
    const data = payloadOf(line);
    if (data !== null) pending.push(data);
  });
  parts.onError((error) => {
    for (const failer of failers) failer(error);
  });
  parts.onClose((why) => {
    // A peer that hangs up after writing its last field has said something: the event is flushed, not lost.
    boundary();
    close(why);
  });

  return events;
}

/**
 * The other direction: events into a body.
 *
 * An event's lines each become a `data:` field and a blank line ends it — the inverse of `sseChannel`, so a
 * server's answer and a client's reading are one vocabulary over the same bytes.
 */
export function sseWriter<C>(out: Channel<Uint8Array, C>): Channel<string, C> {
  const encoder = new TextEncoder();
  return {
    send: (event: string) => {
      const fields = event.split('\n').map((line) => `data: ${line}\n`);
      return out.send(encoder.encode(`${fields.join('')}\n`));
    },
    // An answer body is written, never read: a frame arriving on it is not this channel's business.
    onFrame: () => () => {},
    onClose: (handler) => out.onClose(handler),
    hasFrames: async () => false,
    onError: (handler) => out.onError(handler),
    close: (reason) => out.close(reason),
    // An answer body is written and never read, so nothing is ever standing on it.
    info: out.info,
    control: (command) => out.control(command),
  };
}
