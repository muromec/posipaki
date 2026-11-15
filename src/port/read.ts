// ── one message at a time ─────────────────────────────────────────────────
//
// A channel hands a frame to whoever is subscribed when it arrives.  A caller that wants one frame, now,
// subscribes and takes the first — and the frame behind it has nowhere to go, which is what this keeps.

import { held } from "./held.js";
import type { Channel } from "./channel.js";

/** What one channel's reads stand on: the frames nobody has asked for yet, and who is waiting for one. */
interface Waiters<T> {
  standing: T[];
  waiting: Array<(frame: T) => void>;
}

/**
 * One reader per channel, made the first time somebody reads it.
 *
 * The channel is wrapped in `held` here, so a frame that lands while a read is being handed out waits for the
 * next one instead of being lost.  A weak table, because the reader lives exactly as long as the channel does
 * and there is one of it per channel, not one per call.
 */
const readers = new WeakMap<object, Waiters<unknown>>();

function waitersFor<T, C>(channel: Channel<T, C>): Waiters<T> {
  const known = readers.get(channel) as Waiters<T> | undefined;
  if (known !== undefined) return known;
  const made: Waiters<T> = { standing: [], waiting: [] };
  readers.set(channel, made as Waiters<unknown>);
  held(channel).onFrame((frame: T) => {
    const next = made.waiting.shift();
    if (next === undefined) made.standing.push(frame);
    else next(frame);
  });
  return made;
}

/**
 * The next message on a channel, and no further.
 *
 * Reads of one channel are served in order: what arrived while a caller was waiting goes to the next caller
 * rather than being dropped.  What arrived before the first read is not kept here — a channel whose early
 * frames matter is wrapped in `held` where it is made.
 */
export async function readMessage<T, C>(channel: Channel<T, C>): Promise<T> {
  const waiters = waitersFor(channel);
  const standing = waiters.standing.shift();
  if (standing !== undefined) return standing;
  return await new Promise<T>((resolve) => waiters.waiting.push(resolve));
}

/**
 * The next message, or `nothing` when this channel has none and nothing is coming.
 *
 * `nothing` is answered once the channel says it is quiet — `hasFrames()` answering `false` — and a channel that
 * cannot say waits instead, because "no frame now" is not something it can promise.  What is already standing on
 * this channel is taken first, so a frame that arrived while nobody was waiting is not lost to the question.
 */
export async function readMessageMaybe<T, C>(channel: Channel<T, C>): Promise<T | null>;
export async function readMessageMaybe<T, C, N>(
  channel: Channel<T, C>,
  nothing: N,
): Promise<T | N>;
export async function readMessageMaybe<T, C, N>(
  channel: Channel<T, C>,
  nothing?: N,
): Promise<T | N | null> {
  const waiters = waitersFor(channel);
  const standing = waiters.standing.shift();
  if (standing !== undefined) return standing;
  // `false` is the channel saying it has nothing and is fetching nothing; `null` is it saying it cannot know,
  // and a reader that needs an answer waits for a frame rather than taking a silence for one.
  if ((await channel.hasFrames()) === false) return nothing ?? null;
  // A frame may have arrived while the channel was being asked, so the read re-checks what is standing before it
  // waits: the question and the queue are two views of one moment, and only one of them is atomic.
  return await readMessage(channel);
}
