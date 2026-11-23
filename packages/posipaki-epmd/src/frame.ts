// ── frames: the length a packet announces ───────────────────────────────────
//
// The wire says how long a packet is before it says the packet: two bytes until the handshake ends, four after it.
// This is that cut, and the write that puts the length back.
//
// What the octets of a frame mean is the layer above; nothing here reads them.

import type { Channel } from "posipaki/port";

/** One packet of the wire: the octets its length field announced. */
export type EpmdFrame = Uint8Array;

/** How many bytes a length field takes: two until the handshake ends, four after it. */
export type Prefix = 2 | 4;

/** A channel of frames, and the width of the length fields they are cut with. */
export interface Framed<C = string> extends Channel<EpmdFrame, C> {
  /** The width of the length field the frames below this one carry. */
  readonly prefix: Prefix;
  /**
   * The width of the length field from here on.
   *
   * Call it between frames, which the handshake does once at its end: a frame already cut is unaffected, and
   * octets of a frame still in the buffer were cut with the wrong width, so that is a refusal rather than a
   * re-cut of something whose boundaries are unknown.
   */
  use(prefix: Prefix): void;
}

const EMPTY = new Uint8Array(0);

/** Two chunks as one. */
function joined(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const whole = new Uint8Array(first.length + second.length);
  whole.set(first, 0);
  whole.set(second, first.length);
  return whole;
}

/** The first frame in the buffer, or null while it is incomplete. */
function cut(
  buffered: Uint8Array,
  width: Prefix,
): { frame: EpmdFrame; rest: Uint8Array } | null {
  if (buffered.length < width) return null;
  const head = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
  const announced = width === 2 ? head.getUint16(0) : head.getUint32(0);
  if (buffered.length < width + announced) return null;
  return {
    frame: buffered.slice(width, width + announced),
    rest: buffered.slice(width + announced),
  };
}

/**
 * Bytes as frames, and frames as bytes.
 *
 * One chunk may carry no frame, part of one, or several; the buffer is where the parts wait. A frame that is
 * longer than the width can announce is refused where it is sent, because the wire has no way to say it.
 */
export function wrapEpmdFrame<C = string>(inner: Channel<Uint8Array, C>): Framed<C> {
  const readers = new Set<(frame: EpmdFrame) => void>();
  let buffered: Uint8Array = EMPTY;
  let width: Prefix = 2;
  let ended = false;

  const deliver = (frame: EpmdFrame): void => {
    for (const reader of [...readers]) reader(frame);
  };

  /**
   * An empty packet is a tick: a keep-alive a node expects to hear back, and not a message.
   *
   * The answer is what keeps the connection: a node that hears nothing for its net tick time closes it, and a side
   * that never speaks looks exactly like one that has gone.
   */
  const answerTick = (): void => {
    inner.send(new Uint8Array(width)).catch(() => undefined);
  };

  const drain = (): void => {
    while (!ended) {
      const next = cut(buffered, width);
      if (next === null) return;
      buffered = next.rest;
      if (next.frame.length === 0) {
        answerTick();
        continue;
      }
      deliver(next.frame);
    }
  };

  inner.onFrame((chunk) => {
    buffered = joined(buffered, chunk);
    drain();
  });
  inner.onClose(() => {
    ended = true;
  });

  return {
    async send(frame: EpmdFrame): Promise<void> {
      const limit = width === 2 ? 0xffff : 0xffffffff;
      if (frame.length > limit) {
        throw new Error(`a ${width}-byte length cannot announce ${frame.length} octets`);
      }
      const packet = new Uint8Array(width + frame.length);
      const head = new DataView(packet.buffer);
      if (width === 2) head.setUint16(0, frame.length);
      else head.setUint32(0, frame.length);
      packet.set(frame, width);
      await inner.send(packet);
    },
    onFrame(handler: (frame: EpmdFrame) => void): () => void {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose: (handler) => inner.onClose(handler),
    onError: (handler) => inner.onError(handler),
    close: (reason) => inner.close(reason),
    get info() {
      return inner.info;
    },
    control: (command) => inner.control(command),
    hasFrames: () => inner.hasFrames(),
    get prefix() {
      return width;
    },
    use(next: Prefix): void {
      if (buffered.length > 0) {
        throw new Error(
          `the length field cannot change from ${width} to ${next}: ${buffered.length} octets of a frame are still buffered`,
        );
      }
      width = next;
    },
  };
}
