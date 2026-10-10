// ── the server reactor ─────────────────────────────────────────────────────
//
// One loop for every medium: accept a connection, serve one actor for it, report what is being served,
// and stop when asked.  What a medium is lives in a Listener, so nothing here knows a transport.

import type { ActorDefinition } from "../actor-types.js";
import type { Channel, StringTransport } from "./channel.js";
import { json1Channel, VERSION } from "./protocols/json1.js";
import { serveRemoteActor, type ServedProcess, type Spawner } from "./server.js";

/** Any actor definition: the reactor serves it, and does not care which one it is. */
export type AnyActorDefinition = ActorDefinition<any, any, any, any, any>;

/**
 * A way in, as a listener hands it over: a transport the reactor runs the protocol step on, or a channel
 * that has already been through one (a spawner's, where the handshake is not the reactor's to do).
 */
export type Incoming =
  | { readonly transport: StringTransport; readonly channel?: undefined }
  | { readonly channel: Channel; readonly transport?: undefined };

/** An admitted connection: the way in, and whatever the listener knows about it. */
export type Connection<Meta = unknown> = Incoming & {
  /** The transport's own facts: what the listener resolved, the URL, the peer. */
  readonly meta: Meta;
};

/** Where connections come from.  A listener owns its medium and its own admission. */
export interface Listener<Meta = unknown> {
  /** The next admitted connection.  Rejects once the listener is closed. */
  accept(signal?: AbortSignal): Promise<Connection<Meta>>;
  /** Stop accepting, and release what the listener owns. */
  close(): Promise<void>;
}

/** One served connection, as the reactor reports it. */
export interface Session<Meta = unknown> {
  /** The served process.  It is a root process: the seam spawned it for this connection. */
  readonly proc: ServedProcess<AnyActorDefinition>;
  /** What the listener resolved, plus whatever the factory added. */
  readonly meta: Meta;
  /** Settles when the connection closes and the serve is over. */
  readonly done: Promise<void>;
}

/** What a connection becomes: an actor to serve, and any meta to report about it. */
export type SessionFactory<Meta = unknown> = (
  connection: Connection<Meta>,
) => AnyActorDefinition | { actor: AnyActorDefinition; meta?: Meta };

export interface ReactorOptions<Meta = unknown> {
  /** A connection was admitted and its process is up. */
  onSession?(session: Session<Meta>): void;
  /** Its connection closed, and the serve is over. */
  onClosed?(session: Session<Meta>): void;
  /** A connection could not be served: a handshake that never came, a wire that went early. */
  onError?(error: unknown, connection: Connection<Meta>): void;
  /**
   * Every decoded frame, before the serve handles it.  Returning true swallows the frame, which is
   * where a subprocess's own output frames (`$fd`) are captured instead of passed on.
   */
  onIncomingFrame?(frame: Record<string, unknown>): boolean | void;
}

export interface Reactor {
  /** Stop accepting and stop every live session. */
  stop(): Promise<void>;
  /** How many sessions are being served right now. */
  readonly live: number;
}

export function reactor<Meta = unknown>(
  listener: Listener<Meta>,
  serve: AnyActorDefinition | SessionFactory<Meta>,
  options: ReactorOptions<Meta> = {},
): Reactor {
  const factory: SessionFactory<Meta> = typeof serve === "function" ? serve : () => serve;
  const stopping = new AbortController();
  const live = new Set<ServedProcess<AnyActorDefinition>>();

  const serveOne = async (connection: Connection<Meta>): Promise<void> => {
    // Held in an object: the session is built inside the seam's callback, and a local `let` assigned
    // only there is narrowed to null by the compiler by the time the teardown reads it.
    const held: { session: Session<Meta> | null } = { session: null };
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    try {
      const requested = factory(connection);
      const added = "actor" in requested;
      const actor = added ? requested.actor : requested;
      const meta = added ? (requested.meta ?? connection.meta) : connection.meta;
      // The way in: a transport this side runs the protocol step on, or a channel somebody else already
      // handshaked.  Either way the frame hook goes on before the serve sees a frame.
      const spawner: Spawner = () =>
        connection.channel
          ? Promise.resolve(withFrameHook(connection.channel, options.onIncomingFrame))
          : protocolStep(connection.transport, options);

      await serveRemoteActor(actor, spawner, (proc) => {
        live.add(proc);
        const session: Session<Meta> = { proc, meta, done };
        held.session = session;
        options.onSession?.(session);
      });
    } catch (error) {
      options.onError?.(error, connection);
    } finally {
      const session = held.session;
      if (session) {
        live.delete(session.proc);
        options.onClosed?.(session);
      }
      settle();
    }
  };

  // The loop: one accept at a time, and a session's life never holds the next connection back.
  const accepting = (async (): Promise<void> => {
    for (;;) {
      let connection: Connection<Meta>;
      try {
        connection = await listener.accept(stopping.signal);
      } catch {
        // Nothing more is coming: the listener was closed, or its medium is over.
        return;
      }
      if (stopping.signal.aborted) {
        // A connection admitted as the reactor stops is ended rather than served: it asked for a server
        // that is no longer taking any.
        await (connection.channel ?? connection.transport).close();
        return;
      }
      void serveOne(connection);
    }
  })();

  return {
    get live(): number {
      return live.size;
    },
    async stop(): Promise<void> {
      stopping.abort();
      await listener.close();
      await Promise.all([...live].map((proc) => proc.stop()));
      await accepting;
    },
  };
}

/**
 * A listener with exactly one connection: what a caller serves on when the medium is already open for it,
 * as a spawner that hands back a channel is.  The connection is taken once, a second `accept()` is a
 * mistake worth naming, and `close()` releases an accept that is still waiting for one.
 */
export function oneConnection<Meta = unknown>(
  spawner: Spawner,
  meta: Meta = undefined as Meta,
): Listener<Meta> {
  let taken = false;
  let closed = false;
  let release: (() => void) | null = null;

  return {
    async accept(signal?: AbortSignal): Promise<Connection<Meta>> {
      if (taken) throw new Error("oneConnection: the connection has already been taken");
      if (closed) throw new Error("oneConnection: closed");
      taken = true;
      const channel = await Promise.race([
        spawner(),
        new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error("oneConnection: closed before a connection arrived"));
          signal?.addEventListener("abort", release, { once: true });
        }),
      ]);
      return { channel, meta };
    },
    async close(): Promise<void> {
      closed = true;
      release?.();
    },
  };
}

/** The protocol step: the frame channel over a transport, and the `$proto` frame that opens it. */
async function protocolStep(
  transport: StringTransport,
  options: ReactorOptions<unknown>,
): Promise<Channel> {
  const channel = json1Channel(transport);
  await channel.send({ $proto: VERSION });
  return withFrameHook(channel, options.onIncomingFrame);
}

/**
 * The frame hook, as the channel the serve gets: every decoded frame is offered to it, and one it claims
 * with `true` goes no further.
 */
function withFrameHook(
  channel: Channel,
  hook: ReactorOptions<unknown>["onIncomingFrame"],
): Channel {
  if (!hook) return channel;

  return {
    send: (frame) => channel.send(frame),
    onMessage: (handler) =>
      channel.onMessage((frame) => {
        if (hook(frame) === true) return;
        handler(frame);
      }),
    removeHandler: () => channel.removeHandler(),
    onClose: (handler) => channel.onClose(handler),
    close: () => channel.close(),
  };
}
