// ── the loop, at the port level ─────────────────────────────────────────────
//
// A listener yields a pair of ports per accept, and one handler runs on that pair.  The same loop the connection
// reactor runs, one level down: there the unit is a connection that speaks a protocol, here it is a pair of
// channels and nothing above them.

import type { Channel } from "./channel.js";

/** One accepted exchange: what the far side sends, and what we send back. */
export interface PortPair<In, Out, Meta = unknown, C = void> {
  readonly inbound: Channel<In, C>;
  readonly outbound: Channel<Out, C>;
  /** Whatever the listener resolved about the caller: admission, a path, a token's subject. */
  readonly meta: Meta;
}

/** Where pairs arrive.  The listener owns the medium and its admission. */
export interface PortListener<In, Out, Meta = unknown, C = void> {
  accept(): Promise<PortPair<In, Out, Meta, C>>;
  close(): Promise<void>;
}

export interface PortReactorOptions<In, Out, Meta, C = void> {
  /** Called once a pair has been accepted and its handler has been given it. */
  onSession?(pair: PortPair<In, Out, Meta, C>): void;
  /** Called when a session is over, with whatever the handler threw. */
  onClosed?(pair: PortPair<In, Out, Meta, C>, error: unknown): void;
  /** A handler that throws is reported here, and the loop goes on. */
  onError?(error: unknown): void;
}

export interface PortReactor {
  /** How many handlers are running now. */
  readonly live: number;
  /** Close the listener, stop accepting, and wait for the handlers to finish. */
  stop(): Promise<void>;
}

/**
 * One handler per accepted pair, in arrival order.
 *
 * The loop ends when the listener's `accept()` rejects, which a closed listener does.  A handler that throws is
 * reported and its session ends; the loop carries on with the next pair.
 */
export function portReactor<In, Out, Meta, C = void>(
  listener: PortListener<In, Out, Meta, C>,
  handle: (pair: PortPair<In, Out, Meta, C>) => void | Promise<void>,
  options: PortReactorOptions<In, Out, Meta, C> = {},
): PortReactor {
  const running = new Set<Promise<void>>();
  let stopped = false;

  const serve = (pair: PortPair<In, Out, Meta, C>): void => {
    const session = (async () => {
      options.onSession?.(pair);
      try {
        await handle(pair);
      } catch (error) {
        options.onError?.(error);
        options.onClosed?.(pair, error);
        return;
      }
      options.onClosed?.(pair, undefined);
    })();
    running.add(session);
    void session.finally(() => running.delete(session));
  };

  const loop = (async () => {
    for (;;) {
      let pair: PortPair<In, Out, Meta, C>;
      try {
        pair = await listener.accept();
      } catch {
        return;
      }
      if (stopped) return;
      serve(pair);
    }
  })();

  return {
    get live() {
      return running.size;
    },
    async stop() {
      stopped = true;
      await listener.close();
      await loop;
      await Promise.all([...running]);
    },
  };
}
