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

/** An admitted connection, and whatever the listener knows about it. */
export interface Connection<Meta = unknown> {
  /** The transport's own facts: what the listener resolved, the URL, the peer. */
  readonly meta: Meta;
  /** The transport over the connection, before the protocol handshake. */
  readonly transport: StringTransport;
}

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
      const spawner: Spawner = () => handshake(connection.transport, options);

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
        // A connection admitted as the reactor stops is closed rather than served: it asked for a server
        // that is no longer taking any.
        await connection.transport.close();
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

/** The protocol step: the frame channel, the `$proto` frame, and the incoming-frame hook. */
async function handshake(
  transport: StringTransport,
  options: ReactorOptions<unknown>,
): Promise<Channel> {
  const channel = json1Channel(transport);
  await channel.send({ $proto: VERSION });

  const hook = options.onIncomingFrame;
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
