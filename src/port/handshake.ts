// ── the handshake: which protocol this connection speaks ────────────────────
//
// The first frame on a connection, each way: `{"$proto":"json.v1"}`.  Each end sends its own and waits for the
// other's; nothing else may cross before the two agree.
//
// It is the only adapter here that is asynchronous, because its result — the peer speaks what we speak — has
// to be known before a caller can use the connection.  So it returns a promise, and a peer that stays silent,
// speaks another version, or goes away rejects with a sentence rather than returning a channel that fails on
// its first frame.
//
// A frame that arrives before the agreement is the far end talking out of turn.  On a medium where the peer's
// own output shares the wire that is its stdout, which `onEarly` may claim.  Unclaimed, it refuses the
// handshake: the first thing a peer says has to be its protocol.

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
  /** A frame that arrives before the announcement.  Claim it here and the handshake keeps waiting; leave this
   *  unset and such a frame refuses the connection. */
  onEarly?(value: Delivered): void;
  /** Settles when the medium can carry a frame.  Nothing is announced before it.  Unset leaves it announcing
   *  at once.  A WebSocket needs it: the socket exists before it can send. */
  ready?: Promise<void>;
}

function head(frame: Record<string, unknown>): string {
  const line = JSON.stringify(frame);
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * Announces this side's protocol, reads the peer's, and resolves to the channel above the handshake.
 *
 * It rejects instead when the peer stays silent for `timeoutMs`, speaks another version, says something other
 * than its protocol first, or goes away.  A frame that arrives after the agreement and before anyone subscribes
 * is held for the first reader.
 */
export function handshake(
  inner: Channel<Delivered>,
  options: HandshakeOptions,
): Promise<Channel<Delivered>> {
  const readers = new Set<(value: Delivered) => void>();
  const closers = new Set<(reason: string) => void>();
  const failers = new Set<(error: unknown) => void>();
  /** Frames that arrived with no reader to take them yet. */
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

  /** Refuses the handshake: the caller hears why, and nothing above it is delivered. */
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
      // Held frames go to the first subscriber and are then gone: one conversation runs on this channel.
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

  if (options.ready === undefined) {
    announce();
  } else {
    void options.ready.then(
      () => {
        if (refused === null) announce();
      },
      (error: unknown) => {
        refuse(`the medium was never ready: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
  return settling;
}
