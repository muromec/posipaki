// ── what a follower sends its requests through ──────────────────────────────
//
// Two forms, and one difference between them: whether the medium can say "taken" back.  A request resolves when the
// authority wrote the record and rejects with the spec's refusal; a channel only carries, so a refusal is never
// heard.  Those are what a peer, an HTTP call, a socket or a UDP packet can be.  A process is the third form in the
// API and not here, because a process is always one of the two and which one is a decision, not a type.

import type { Channel } from 'posipaki/port';

import type { ProxyMode, RecordInMessage, RecordOutMessage } from './interface';

/** The least a process has to be for a follower to send it requests: a handle without its state. */
export interface Sendable<Q, E = string> {
  send(message: RecordInMessage<Q>): void;
  subscribe(event: 'message', handler: (message: RecordOutMessage<E>) => void): () => void;
}

/**
 * A call that answers: it resolves when the authority took the request, and rejects with its refusal.
 *
 * Made from a process it carries that process, so a follower that asks can still attach to what it asks and let go
 * of it.  Written by hand it carries nothing, and the authority's life is its caller's business.
 */
export interface Request<Q, E = string> {
  (request: Q): Promise<void>;
  readonly process?: Sendable<Q, E>;
}

/** What a refused request is rejected with, so the spec's own word survives the trip up. */
export class Refused<E> extends Error {
  readonly reason: E;

  constructor(reason: E) {
    super(String(reason));
    this.name = 'Refused';
    this.reason = reason;
  }
}

/** Where requests go: a call that answers, or a channel that only carries. */
export type Upstream<Q, E = string> = Request<Q, E> | Channel<Q, string>;

/** Everything a follower may be handed: either form, or a process, which is a shortcut to one of them. */
export type UpstreamSource<S, Q, E = string> = Upstream<Q, E> | Sendable<Q, E>;

/** A process turned into a request: it is asked, and the answer awaited. */
export function requesting<Q, E>(to: Sendable<Q, E>): Request<Q, E> {
  let next = 1;
  const ask = (request: Q): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const requestId = `request-${next++}`;
      const stop = to.subscribe('message', (message) => {
        if (message.requestId !== requestId) return;
        stop();
        if (message.type === 'RECORD_ACCEPTED') return resolve();
        reject(new Refused(message.reason));
      });
      to.send({ type: 'ADD_RECORD', requestId, request });
    });
  return Object.assign(ask, { process: to });
}

/** A process turned into a channel: requests are thrown at it and nothing is heard back. */
function casting<Q, E>(to: Sendable<Q, E>): Channel<Q, string> {
  let next = 1;
  return {
    async send(request: Q): Promise<void> {
      to.send({ type: 'ADD_RECORD', requestId: `request-${next++}`, request });
    },
    onFrame: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
    close: async () => {},
    info: { writes: 'a process' },
    control: () => {},
  };
}

/** Whether what a follower was handed is a process, which it attaches to and lets go of. */
export function processOf<Q, E>(source: UpstreamSource<unknown, Q, E>): Sendable<Q, E> | null {
  if (typeof source === 'function') return source.process ?? null;
  if ('onFrame' in source) return null;
  return source;
}

/**
 * The form a follower works in.
 *
 * A request and a channel are handed back as they are.  A process becomes a request when the mode has to know
 * whether the authority took the request, and a channel when it does not: a guess is taken back by an answer, and
 * a follower that makes no guesses has none to take back.
 */
export function upstreamOf<S, Q, E>(
  source: UpstreamSource<S, Q, E>,
  mode: ProxyMode,
): Upstream<Q, E> {
  if (typeof source === 'function') return source;
  if ('onFrame' in source) return source;
  return mode === 'optimistic' ? requesting(source) : casting(source);
}
