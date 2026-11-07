// ── a port as an actor ──────────────────────────────────────────────────────
//
// One actor that owns one channel and speaks for it: what it is told to send goes in, what the channel delivers
// comes out as DATA, and the way the channel ended comes out once as the message the caller named.
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

/** Ask the channel's own world to act on the process behind it; a medium without one ignores it. */
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
export type PortOut<F, E extends Message> = DataMessage<F> | E;

/** What a parent may read of a port. */
export interface PortPublic {
  /** The channel is open.  False before it opens and after it has ended. */
  alive: boolean;
}

export interface PortActorSpec<Args, F, C, E extends Message> {
  name: string;
  /** Opens the channel this actor owns.  Called once, when the actor starts. */
  open(args: Args): Promise<Channel<F, C>>;
  /** The message the ending is announced with.  What a channel's close means is the caller's to say. */
  exit(reason: C): E;
  /** How a signal reaches the medium.  A process sends it; a connection with no process behind it has none. */
  signal?(channel: Channel<F, C>, signal: string): void;
}

/**
 * An actor over one channel.
 *
 * In `SEND {data}` writes to it, `SIGNAL {signal}` asks the medium to act on what is behind it, and posipaki's
 * `STOP` ends the actor, which closes the channel.  Out `DATA {data}` for every frame, and the spec's `exit`
 * message once, after which the actor ends.
 */
export function portActor<Args, F, C, E extends Message>(
  spec: PortActorSpec<Args, F, C, E>,
): ActorDefinition<Args, { public: PortPublic; private: { channel: Channel<F, C> | null } }, PortIn<F>, PortOut<F, E>, {}> {
  return defineActor({
    name: spec.name,
    inMessages: defineMessages<PortIn<F>>(),
    outMessages: defineMessages<PortOut<F, E>>(),
    setup: (args: Args) => ({
      public: { alive: false as boolean },
      private: { channel: null as Channel<F, C> | null, args },
    }),
    afterStart() {
      const { args } = this.state.private;
      void spec.open(args).then((channel) => {
        this.state.private.channel = channel;
        this.state.public.alive = true;
        channel.onFrame((data) => {
          void this.emit({ type: "DATA", data } as PortOut<F, E>);
        });
        channel.onClose((reason) => {
          this.state.public.alive = false;
          this.emit(spec.exit(reason));
          this.exit();
        });
      });
    },
    async beforeEnd() {
      this.state.public.alive = false;
      await this.state.private.channel?.close();
    },
    handlers: {
      async SEND(msg: SendMessage<F>) {
        await this.state.private.channel?.send(msg.data);
      },
      SIGNAL(msg: SignalMessage) {
        const channel = this.state.private.channel;
        if (channel !== null) spec.signal?.(channel, msg.signal);
      },
    },
  });
}
