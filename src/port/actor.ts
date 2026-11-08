// ── a port as an actor ──────────────────────────────────────────────────────
//
// One actor that owns one channel and speaks for it: what it is told to send goes in, what the channel delivers
// comes out as DATA, and the way the channel ended is left in the actor's state, where a parent reads anyway.
//
// The channel is opened when the actor starts and closed when it ends, so the actor's life and the channel's
// are the same one.  What a channel is — a process, a socket, a pair in memory — is `open`'s business; the
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
export interface PortPublic<C, Info = unknown> {
  /** The channel is open.  False before it opens and after it has ended. */
  alive: boolean;
  /** How it ended, or null while it has not. */
  end: C | null;
  /** What the medium knows about itself — a process its pid — or null while it knows nothing. */
  info: Info | null;
}

/**
 * What `open` answers when the medium has more to say than a channel.
 *
 * `info` is what the medium knows about itself, and `signal` is how a signal reaches what is behind the
 * channel: a channel cannot offer that, so whatever opened it does.
 */
export interface Opened<F, C = string, Info = unknown> {
  channel: Channel<F, C>;
  info?: Info;
  signal?(signal: string): void;
}

export interface PortActorSpec<Args, F, C, Info = unknown> {
  name: string;
  /** Opens the channel this actor owns.  Called once, when the actor starts. */
  open(args: Args): Promise<Channel<F, C> | Opened<F, C, Info>>;
}

type PortState<F, C, Info> = {
  public: PortPublic<C, Info>;
  private: {
    /** The opening, kept so a send waits for the channel rather than being dropped before it exists. */
    opening: Promise<Channel<F, C>> | null;
    signal: ((signal: string) => void) | null;
    args: unknown;
  };
};

/**
 * An actor over one channel.
 *
 * In `SEND {data}` writes to it and `SIGNAL {signal}` reaches the medium through what `open` answered;
 * posipaki's `STOP` ends the actor, which closes the channel.  Out `DATA {data}` for every frame.  The
 * channel's ending is left in `state.end`, what the medium knows about itself in `state.info`, and then the
 * actor stops.
 */
export function portActor<Args, F, C, Info = unknown>(
  spec: PortActorSpec<Args, F, C, Info>,
): ActorDefinition<Args, PortState<F, C, Info>, PortIn<F>, PortOut<F>, {}> {
  return defineActor({
    name: spec.name,
    inMessages: defineMessages<PortIn<F>>(),
    outMessages: defineMessages<PortOut<F>>(),
    setup: (args: Args) => ({
      public: { alive: false as boolean, end: null as C | null, info: null as Info | null },
      private: {
        opening: null as Promise<Channel<F, C>> | null,
        signal: null as ((signal: string) => void) | null,
        args,
      },
    }),
    afterStart() {
      const { args } = this.state.private;
      const opening = spec.open(args).then((answer) => {
        const opened: Opened<F, C, Info> = "channel" in answer ? answer : { channel: answer };
        const { channel } = opened;
        this.state.private.signal = opened.signal ?? null;
        this.state.public.info = opened.info ?? null;
        this.state.public.alive = true;
        channel.onFrame((data) => {
          this.emit({ type: "DATA", data });
        });
        channel.onClose((reason) => {
          this.state.public.alive = false;
          this.state.public.end = reason;
          this.exit();
        });
        return channel;
      });
      this.state.private.opening = opening;
      // A channel that never opens is this actor's own failure: nothing can be sent and nothing arrives.
      void opening.catch((error: unknown) => {
        this.exit(`the port could not open: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    async beforeEnd() {
      this.state.public.alive = false;
      const opening = this.state.private.opening;
      if (opening === null) return;
      const channel = await opening.catch(() => null);
      await channel?.close();
    },
    handlers: {
      // Held until the channel exists: an opener that has not answered yet is not a reason to lose a frame.
      async SEND(msg: SendMessage<F>) {
        const opening = this.state.private.opening;
        if (opening === null) return;
        const channel = await opening;
        await channel.send(msg.data);
      },
      SIGNAL(msg: SignalMessage) {
        this.state.private.signal?.(msg.signal);
      },
    },
  });
}
