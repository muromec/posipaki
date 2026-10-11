// ── the server reactor ─────────────────────────────────────────────────────
//
// One loop for every medium: accept a connection, serve one actor for it, report what is being served,
// and stop when asked.  What a medium is lives in a Listener, so nothing here knows a transport.
// serveRemoteActor is the same loop for a listener that carries exactly one connection.

import type { ActorDefinition, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import type { Channel, StringTransport } from "./channel.js";
import { json1Channel, VERSION } from "./protocols/json1.js";
import { serveChannel, type AnyProcess, type Init, type Served, type ServedProcess, type Spawner } from "./server.js";

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

/** A connection as a session is built on it: what it was admitted by, what the listener resolved,
 *  and the channel above the protocol step.  Past admission the way in *is* that channel: the
 *  reactor owns the protocol step, so a listener never has to carry one for it. */
export type ServedConnection<Meta = unknown> = {
  /** The transport it was admitted on, when the listener handed one over rather than a channel.
   *  What the connection came in on, kept as that; the session speaks over `channel`. */
  readonly transport?: StringTransport;
  /** What the listener resolved about the connection. */
  readonly meta: Meta;
  /** The frames of this connection: the channel above the protocol step.  This is what the
   *  session's process is given as `ctx.connection`, and what a serving half answers with. */
  readonly channel: Channel;
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

/** What a connection becomes: the process to serve.  It is called once the `$init` has been read, so the
 *  args the far side asked for are in hand.  A bare actor definition is the shortcut for a factory that
 *  spawns one with them. */
export type SessionFactory<Meta = unknown> = (
  connection: ServedConnection<Meta>,
  init: Init,
) => Served<Meta> | AnyProcess | Promise<Served<Meta> | AnyProcess>;

/** The shortcut, as a factory: spawn the definition with what the far side asked for, and hand
 *  it the connection as `ctx.connection` so the process speaks for itself from `setup` on. */
export function spawnFactory<Meta = unknown>(definition: AnyActorDefinition): SessionFactory<Meta> {
  return async (connection, init) => ({
    proc: await definition.spawn(init.args, {
      name: init.rootName,
      parentName: init.parentName,
      parentId: init.parentId,
      connection: connection.channel,
    }),
  });
}

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
  const factory: SessionFactory<Meta> = typeof serve === "function" ? serve : spawnFactory(serve);
  const stopping = new AbortController();
  // What is being served: the one function that ends each session, and the promise that says it is over.
  const live = new Map<() => Promise<void>, Promise<void>>();

  const serveOne = async (connection: Connection<Meta>): Promise<void> => {
    // Held in an object: the session is built inside the seam's callback, and a local `let` assigned
    // only there is narrowed to null by the compiler by the time the teardown reads it.
    const held: { session: Session<Meta> | null; end: (() => Promise<void>) | null } = {
      session: null,
      end: null,
    };
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    try {
      // The way in: a transport this side runs the protocol step on, or a channel somebody else already
      // handshaked.  Either way the frame hook goes on before the serve sees a frame.
      const channel = connection.channel
        ? withFrameHook(connection.channel, options.onIncomingFrame)
        : await protocolStep(connection.transport, options);

      // What the session is served over: the channel above the protocol step.  It goes to the factory,
      // which hands it to the process it spawns (`ctx.connection`), and it is the whole way out — the
      // far end's own output included, as a frame of its own (`outputFrame`, channel.ts).
      const served: ServedConnection<Meta> = {
        transport: connection.transport,
        meta: connection.meta,
        channel,
      };

      await serveChannel(
        channel,
        // The factory is asked where the args are: the serve reads the `$init` and hands it over.
        async (init) => {
          const answer = await factory(served, init);
          return "proc" in answer ? answer : { proc: answer };
        },
        (spawned, ended) => {
          live.set(ended, done);
          held.end = ended;
          const session: Session<Meta> = { proc: spawned.proc, meta: spawned.meta ?? connection.meta, done };
          held.session = session;
          options.onSession?.(session);
        },
      );
    } catch (error) {
      options.onError?.(error, connection);
    } finally {
      const session = held.session;
      if (held.end) live.delete(held.end);
      if (session) options.onClosed?.(session);
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
      // Every live session is ended, and the stop waits for them to be over: something that asks whether a
      // reactor is still serving gets its answer from here rather than from a race.
      const ending = [...live.keys()].map((end) => end());
      const over = [...live.values()];
      await Promise.all(ending);
      await Promise.all(over);
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
    onClose: (handler) => channel.onClose(handler),
    close: () => channel.close(),
  };
}

/**
 * One actor over one connection: the reactor with a listener that carries exactly one.  A caller that
 * has a spawner and no loop of its own gets the same serving, the same reports and the same teardown a
 * listener gets.  The promise settles when the serve is over, and rejects when the connection could not
 * be served at all — the two outcomes the seam has always had.
 */
export async function serveRemoteActor<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  R extends ReflectionOptions,
>(
  actor: ActorDefinition<Args, State, InMsg, OutMsg, R>,
  spawner: Spawner,
  onSpawned?: (proc: ServedProcess<ActorDefinition<Args, State, InMsg, OutMsg, R>>) => void,
): Promise<void> {
  // A medium that cannot be reached fails the caller's await rather than the loop's: the loop reads an
  // accept that ends as nothing more coming.
  const channel = await spawner();
  await new Promise<void>((resolve, reject) => {
    reactor(oneConnection(async () => channel), actor, {
      onSession: ({ proc }) => onSpawned?.(proc),
      onClosed: () => resolve(),
      onError: (error) => reject(error),
    });
  });
}
