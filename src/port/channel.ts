// ── A channel: frames of one type, and the three ways it ends ───────────────
//
// The bottom of a port.  A channel moves frames and knows nothing else: not what a frame means, not what
// carries it, not whether anything is a process.  Its type parameter is the frame — bytes, a line, a decoded
// object — so a medium and a protocol differ by what they carry rather than by which interface they implement.
//
// Three endings, and they are not the same fact:
//
//   close() from here   our doing; the far end hears a close of its own, and we hear nothing
//   onClose             the far end is gone, with whatever it said
//   onError             the wire failed; once, and always followed by a close
//
// `close()` is idempotent and a second one is not news.  A send that cannot be delivered rejects rather than
// resolving: a channel that swallowed it would be a message nobody can account for.

/**
 * A frame of a channel that carries lines.
 *
 * A line may announce octets after it (a stream chunk on the remote seam), so a part is the line and what it
 * announced.  A medium that moves whole messages, like a websocket, produces parts with no octets; a medium
 * that moves bytes produces none until the splitter has run.
 */
export interface Part {
  /** One line, without its terminator. */
  line: string;
  /** The octets the line announced, when it announced any. */
  bytes: Uint8Array | null;
}

/** Frames of one type, and the three ways it ends. */
export interface Channel<F> {
  /**
   * Put a frame on it.
   *
   * Rejects when the channel is over, from either side: there is no reader left, and a resolved promise
   * would say the frame had been taken.
   */
  send(frame: F): Promise<void>;
  /** A frame arrived.  The returned function stops this reader and no other. */
  onFrame(handler: (frame: F) => void): () => void;
  /** The far end closed, and said why.  Once, after any frames already read. */
  onClose(handler: (reason: string) => void): () => void;
  /** The wire failed.  Once, and always followed by a close. */
  onError(handler: (error: unknown) => void): () => void;
  /**
   * Close it from this side.
   *
   * Idempotent: a second call does nothing.  The far end hears a close; the callers on this side do not,
   * because they are the ones who asked.
   */
  close(reason?: string): Promise<void>;
}

/** What is thrown when a frame is sent on a channel that is over. */
export class ChannelClosed extends Error {
  constructor(reason: string) {
    super(`the channel is closed: ${reason}`);
    this.name = "ChannelClosed";
  }
}
