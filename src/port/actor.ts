// ── a port as an actor ──────────────────────────────────────────────────────
//
// One actor that owns one channel and speaks for it: what it is told to send goes in, what the channel delivers
// comes out as DATA, and the way the channel ended is left in the actor's state, where a parent reads anyway.
//
// The channel is opened when the actor starts and closed when it ends, so the actor's life and the channel's
// are the same one.  What a channel is — a process, a socket, a pair in memory — is the opener's business; the
// actor knows only that it has one.

import type { ActorDefinition } from "../actor-types.js";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";
import type { Channel } from "./channel.js";

/** Write this to the channel. */
export interface SendMessage<F> extends Message {
  type: "SEND";
  data: F;
}

/** Ask the channel's own world to act on what is behind it; a medium without one ignores it. */
export interface SignalMessage extends Message {
  type: "SIGNAL";
  signal: string;
}

/** A frame the channel delivered. */
export interface DataMessage<F> extends Message {
  type: "DATA";
  data: F;
}

export type PortIn<F> = SendMessage<F> | SignalMessage;
export type PortOut<F> = DataMessage<F>;

/** What a parent may read of a port.  The ending is here because it is state, not news. */
export interface PortPublic<C> {
  /** The channel is open.  False before it opens and after it has ended. */
  alive: boolean;
  /** How it ended, or null while it has not. */
  end: C | null;
}

export interface PortActorSpec<Args, F, C> {
  name: string;
  /** Opens the channel this actor owns.  Called once, when the actor starts. */
  open(args: Args): Promise<Channel<F, C>>;
  /** How a signal reaches the medium.  A process sends it; a connection with no process behind it has none. */
  signal?(channel: Channel<F, C>, signal: string): void;
}

type PortState<C> = { public: PortPublic<C>; private: { channel: Channel<unknown, C> | null; args: unknown } };

/**
 * An actor over one channel.
 *
 * In `SEND {data}` writes to it and `SIGNAL {signal}` asks the medium to act on what is behind it; posipaki's
 * `STOP` ends the actor, which closes the channel.  Out `DATA {data}` for every frame.  The channel's ending is
 * left in `state.end` and the actor stops.
 */
export function portActor<Args, F, C>(
  spec: PortActorSpec<Args, F, C>,
): ActorDefinition<Args, PortState<C>, PortIn<F>, PortOut<F>, {}> {
  return defineActor({
    name: spec.name,
    inMessages: defineMessages<PortIn<F>>(),
    outMessages: defineMessages<PortOut<F>>(),
    setup: (args: Args) => ({
      public: { alive: false as boolean, end: null as C | null },
      private: { channel: null as Channel<unknown, C> | null, args },
    }),
    afterStart() {
      const { args } = this.state.private;
      void spec.open(args).then((channel) => {
        this.state.private.channel = channel;
        this.state.public.alive = true;
        channel.onFrame((data) => {
          this.emit({ type: "DATA", data });
        });
        channel.onClose((reason) => {
          this.state.public.alive = false;
          this.state.public.end = reason;
          this.exit();
        });
      });
    },
    async beforeEnd() {
      this.state.public.alive = false;
      await (this.state.private.channel as Channel<F, C> | null)?.close();
    },
    handlers: {
      async SEND(msg: SendMessage<F>) {
        await (this.state.private.channel as Channel<F, C> | null)?.send(msg.data);
      },
      SIGNAL(msg: SignalMessage) {
        const channel = this.state.private.channel as Channel<F, C> | null;
        if (channel !== null) spec.signal?.(channel, msg.signal);
      },
    },
  });
}
