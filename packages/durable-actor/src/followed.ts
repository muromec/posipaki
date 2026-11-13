// ── what one process needs of another ───────────────────────────────────────

import type { RecordInMessage, RecordOutMessage } from './record';

/**
 * What a follower needs of the process it follows: a state, and somewhere to send the requests it is given.
 *
 * It is the smaller half of `RecordHandle`, which is why a proxy can follow a proxy: the chain is one shape all
 * the way down, and only the first process has a log.
 */
export interface Followed<S, Q, E = string> {
  readonly state: { state: S | null } | null;
  send(message: RecordInMessage<Q>): void;
  subscribe(event: 'message', handler: (message: RecordOutMessage<E>) => void): () => void;
}
