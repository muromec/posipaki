// ── the handshake: which protocol this connection speaks ────────────────────
//
// One frame each way, before anything else: `{"$proto":"json.v1"}`.  A connection that skipped it would be a
// connection whose words are guessed at, so both ends say what they speak and read what the other says.
//
// This is the one adapter that is asynchronous.  Every other adapter can wrap a channel and hand the wrapper
// back at once, because it only reshapes frames as they pass; the handshake cannot, because its answer — "the
// peer speaks what we speak" — is the thing the caller needs before it starts talking.  So it resolves to the
// channel rather than returning one, and a peer that is silent, wrong or gone is a rejection rather than a
// channel that fails quietly on its first frame.
//
// A frame that arrives before the handshake is answered is the far end talking out of turn: the peer's own
// output, on a medium where its prints share the wire.  The caller may claim those (`onEarly`) and carry them
// somewhere; a frame nobody claims is a refusal, because a peer that says something else first is a peer
// speaking something other than this protocol.

import type { Channel } from "./channel.js";
import type { Delivered } from "./json1.js";

/** The key that says which protocol a side speaks. */
export const PROTO_KEY = "$proto";

/** How long to wait for the far end's protocol frame before giving up. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Raised when a connection does not reach an agreed protocol: silence, a wrong version, a peer that went. */
export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

/** The version a delivered frame announces, or null when it announces none. */
export function protoVersion(value: Delivered): string | null {
  const version = value.frame[PROTO_KEY];
  return typeof version === "string" ? version : null;
}

/** The frame that announces a protocol. */
export function protoFrame(version: string): Delivered {
  return { frame: { [PROTO_KEY]: version }, bytes: null };
}

export interface HandshakeOptions {
  /** The protocol this side speaks. */
  version: string;
  /** How long to wait for the peer's announcement.  Defaults to {@link HANDSHAKE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** A frame that arrived before the announcement, for a caller that knows what it is.  Returning nothing
   *  leaves the handshake waiting; not setting this at all makes such a frame a refusal. */
  onEarly?(value: Delivered): void;
}

function head(frame: Record<string, unknown>): string {
  const line = JSON.stringify(frame);
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * Announce this side's protocol, read the peer's, and resolve to the channel above the handshake.
 *
 * Frames that arrive after the announcement and before anyone is reading are held and handed to the first
 * reader: the far end may answer the announcement and get on with its work in one turn.
 */
export function handshake(
  inner: Channel<Delivered>,
  options: HandshakeOptions,
): Promise<Channel<Delivered>> {
  const readers = new Set<(value: Delivered) => void>();
  const closers = new Set<(reason: string) => void>();
  const failers = new Set<(error: unknown) => void>();
  /** Frames that arrived after the announcement with no reader to take them yet. */
  let held: Delivered[] = [];
  let agreed = false;
  let reported: string | null = null;
  let refused: string | null = null;

  const announce = (): void => {
    void inner.send(protoFrame(options.version)).catch((error: unknown) => {
      refuse(`could not announce ${options.version}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  let resolveHandshake!: (channel: Channel<Delivered>) => void;
  let rejectHandshake!: (error: unknown) => void;
  const settling = new Promise<Channel<Delivered>>((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });

  const timer = setTimeout(() => {
    refuse(`no protocol frame within ${options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS}ms`);
  }, options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  timer.unref?.();

  /** End the handshake here: the caller hears why, and the frames above it are not this side's to deliver. */
  function refuse(reason: string): void {
    if (agreed || refused !== null) return;
    refused = reason;
    clearTimeout(timer);
    rejectHandshake(new HandshakeError(reason));
  }

  const channel: Channel<Delivered> = {
    send: (value) => inner.send(value),
    onFrame: (handler) => {
      readers.add(handler);
      // The far end may have answered and carried on before anyone was reading.  Those frames belong to the
      // first reader, which is the seam: there is one connection here and one conversation on it.
      if (held.length > 0) {
        const queued = held;
        held = [];
        for (const value of queued) handler(value);
      }
      return () => {
        readers.delete(handler);
      };
    },
    onClose: (handler) => {
      if (reported !== null) {
        handler(reported);
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
    close: (reason) => inner.close(reason),
  };

  inner.onFrame((value) => {
    if (refused !== null) return;
    if (!agreed) {
      const peer = protoVersion(value);
      if (peer === null) {
        if (options.onEarly !== undefined) {
          options.onEarly(value);
          return;
        }
        refuse(`the far end said ${head(value.frame)} before it said which protocol it speaks`);
        return;
      }
      if (peer !== options.version) {
        refuse(`the far end speaks ${peer}, and this side speaks ${options.version}`);
        return;
      }
      agreed = true;
      clearTimeout(timer);
      resolveHandshake(channel);
      return;
    }
    if (readers.size === 0) {
      held.push(value);
      return;
    }
    for (const reader of [...readers]) reader(value);
  });
  inner.onError((error) => {
    refuse(`the connection failed during the handshake: ${error instanceof Error ? error.message : String(error)}`);
    for (const failer of [...failers]) failer(error);
  });
  inner.onClose((reason) => {
    refuse(`the connection closed during the handshake: ${reason}`);
    reported = reason;
    for (const closer of [...closers]) closer(reason);
  });

  announce();
  return settling;
}
