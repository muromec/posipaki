// ── a port as an actor ──────────────────────────────────────────────────────
//
// One actor that owns one channel and speaks for it: what it is told to send goes in, what the channel delivers
// comes out as DATA, and the way the channel ended is left in the actor's state, where a parent reads anyway.
//
// The channel is opened in `setup`, which the runtime awaits, so an actor that is ready has a channel: a send is
// never asked to wait for one, and a port that cannot open fails its start rather than looking alive.  What a
// channel is — a process, a socket, a pair in memory — is `open`'s business; the actor knows only that it has one.

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
  /** What the medium knows about itself — a process its pid — as the channel reported it. */
  info: Record<string, unknown>;
}

/** What a medium's actor is handed: a name, and a way to open the channel it will own. */
export interface PortActorSpec<Args, F, C = string> {
  name: string;
  /** Opens the channel this actor owns.  Called once, when the actor starts. */
  open(args: Args): Promise<Channel<F, C>>;
}

type PortState<F, C> = {
  public: PortPublic<C>;
  private: { channel: Channel<F, C>; args: unknown };
};

/**
 * An actor over one channel.
 *
 * In `SEND {data}` writes to it and `SIGNAL {signal}` asks the medium to act on what is behind it, through
 * the channel's own `control`; posipaki's `STOP` ends the actor, which closes the channel.  Out `DATA {data}`
 * for every frame.  The channel's ending is left in `state.end`, what the medium knows about itself in
 * `state.info`, and then the actor stops.
 */
export function portActor<Args, F, C = string>(
  spec: PortActorSpec<Args, F, C>,
): ActorDefinition<Args, PortState<F, C>, PortIn<F>, PortOut<F>, {}> {
  return defineActor({
    name: spec.name,
    inMessages: defineMessages<PortIn<F>>(),
    outMessages: defineMessages<PortOut<F>>(),
    setup: async (args: Args): Promise<PortState<F, C>> => {
      const channel = await spec.open(args);
      return {
        public: { alive: true, end: null, info: channel.info },
        private: { channel, args },
      };
    },
    afterStart() {
      const { channel } = this.state.private;
      channel.onFrame((data) => {
        this.emit({ type: "DATA", data });
      });
      channel.onClose((reason) => {
        this.state.public.alive = false;
        this.state.public.end = reason;
        this.exit();
      });
    },
    async beforeEnd() {
      this.state.public.alive = false;
      await this.state.private.channel.close();
    },
    handlers: {
      async SEND(msg: SendMessage<F>) {
        await this.state.private.channel.send(msg.data);
      },
      SIGNAL(msg: SignalMessage) {
        this.state.private.channel.control({ signal: msg.signal });
      },
    },
  });
}
