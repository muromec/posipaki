// ── a proxy over an authoritative process ───────────────────────────────────
//
// A process that follows another one and takes requests on its behalf.  It holds no log: the records it reduces
// come from the authority (`mirrorChannel`), and the rules live with the log's writer, so a request it is given
// goes there.
//
// Two modes, and the difference is when the caller sees the state move:
//
// - `deferred` says nothing until the authority has written the record and it has come back through the mirror,
//   so an accept always means "the authority has it";
// - `optimistic` reduces the record it would ask for at once and answers yes immediately, then forwards.  If the
//   authority refuses, the answer is a second word (`rolled back: …`) and the fold returns to what it was before
//   the guess.
import { defineActor, defineMessages, type SpawnedFrom } from 'posipaki';
import type { Channel } from 'posipaki/port';

import type { Followed } from './followed';
import {
  type RecordInMessage,
  type RecordOutMessage,
  type RecordPublic,
  type RecordSpec,
  reasonOf,
  written,
} from './record';

/** When a follower shows a change: after the authority has it, or at once and undone if it is refused. */
export type ProxyMode = 'deferred' | 'optimistic';

export interface ProxyOptions {
  /** Default `deferred`. */
  mode?: ProxyMode;
}

/** What a proxy is given: the process it follows, the state where it attaches, and the changes after it. */
export interface ProxyArgs<S, R, Q, E = string> {
  /** The process that owns the log and filters: what answers a request, and where the records come from. */
  authority: Followed<S, Q, E>;
  /** The fold as it stands where the follower attaches: a state, not a record. */
  snapshot: S | null;
  /** The changes after it: `mirrorChannel` over the authority, in the usual case. */
  source: Channel<R, string>;
}

/** One guess in flight: what it would have been, what the state was, and who is waiting to hear about it. */
interface Guess<S, R, Q> {
  callerId: string;
  record: R;
  before: S | null;
  /** What the caller asked, so the authority is asked the same question rather than being shown the guess. */
  request: Q;
}

interface Private<S, R, Q, E> {
  authority: Followed<S, Q, E>;
  source: Channel<R, string>;
  stopReading: () => void;
  mode: ProxyMode;
  /** Guesses in flight, by the id this proxy asked the authority under. */
  guessing: Map<string, Guess<S, R, Q>>;
  /** Answered ids, by the id this proxy asked under, for the callers that are still waiting. */
  asking: Map<string, string>;
  /** Records already reduced as a guess, so the mirror's copy of one is not reduced twice. */
  guessed: Set<string>;
  next: number;
}

/**
 * A proxy: the authority's records reduced locally, and its answers relayed under each caller's own id.
 *
 * A proxy never filters.  A request it cannot hand over is a failure, not a refusal, because it has no rules to
 * refuse with — except in optimistic mode, where it applies the spec's own `filter` and `map` to guess, and says
 * so if the guess was wrong.
 */
export function makeDurableProxyActor<S, R, Q, E = string>(
  spec: RecordSpec<S, R, Q, E>,
  options: ProxyOptions = {},
) {
  return defineActor({
    name: 'proxy',
    inMessages: defineMessages<RecordInMessage<Q>>(),
    outMessages: defineMessages<RecordOutMessage<E>>(),

    setup(args: ProxyArgs<S, R, Q, E>): { public: RecordPublic<S>; private: Private<S, R, Q, E> } {
      return {
        // The fold as it stands where this proxy attaches: a state, given as one.
        public: { state: args.snapshot, watching: 0 },
        private: {
          authority: args.authority,
          source: args.source,
          stopReading: () => {},
          mode: options.mode ?? 'deferred',
          guessing: new Map(),
          asking: new Map(),
          guessed: new Set(),
          next: 1,
        },
      };
    },

    afterStart() {
      const mine = this.state.private;
      // The records are the authority's; so are the answers to what this proxy forwards.
      mine.stopReading = mine.source.onFrame((record) => this.receive(record));
      mine.authority.subscribe('message', (message) =>
        this.relayed(message as RecordOutMessage<E>),
      );
      mine.authority.send({ type: 'ATTACH' });
    },

    async beforeEnd() {
      this.state.private.stopReading();
      this.state.private.authority.send({ type: 'DETACH' });
    },

    handlers: {
      /** A request: answered from a guess, or forwarded and answered when the authority has spoken. */
      ASK(request) {
        const mine = this.state.private;
        const state = this.state.public.state;
        if (mine.mode === 'optimistic' && state !== null) {
          const verdict = spec.filter(state, request.request);
          if ('refuse' in verdict) return this.reject(request.requestId, verdict.refuse);
          const record = spec.map(state, request.request);
          this.guess(request.requestId, record, state, request.request);
          return;
        }
        const asking = `p-${mine.next++}`;
        mine.asking.set(asking, request.requestId);
        mine.authority.send({ type: 'ASK', requestId: asking, request: request.request });
      },
      ATTACH() {},
      DETACH() {},
    },

    methods: {
      /** Show it now, and ask: the record is reduced here before the authority has decided about it. */
      guess(callerId: string, record: R, before: S | null, request: Q): void {
        const mine = this.state.private;
        const asking = `p-${mine.next++}`;
        this.state.public.state = spec.reduce(before, record);
        this.self.notify();
        this.emit({ type: 'ACCEPTED', requestId: callerId } satisfies RecordOutMessage<E>);
        mine.guessed.add(written(record));
        mine.guessing.set(asking, { callerId, record, before, request });
        mine.authority.send({ type: 'ASK', requestId: asking, request });
      },

      /** What the authority said, in the words of whoever asked this proxy. */
      relayed(answer: RecordOutMessage<E>): void {
        const mine = this.state.private;
        const guess = mine.guessing.get(answer.requestId);
        if (guess !== undefined) {
          mine.guessing.delete(answer.requestId);
          if (answer.type === 'ACCEPTED') return;
          // The guess was wrong: undo it, and tell the caller who was told yes a moment ago.
          this.state.public.state = guess.before;
          this.self.notify();
          mine.guessed.delete(written(guess.record));
          this.emit({
            type: 'FAILED',
            requestId: guess.callerId,
            reason: `rolled back: ${typeof answer.reason === 'string' ? answer.reason : 'refused'}`,
          } satisfies RecordOutMessage<E>);
          return;
        }
        const callerId = mine.asking.get(answer.requestId);
        if (callerId === undefined) return;
        mine.asking.delete(answer.requestId);
        if (answer.type === 'ACCEPTED') {
          this.emit({ type: 'ACCEPTED', requestId: callerId } satisfies RecordOutMessage<E>);
          return;
        }
        this.emit({ ...answer, requestId: callerId } satisfies RecordOutMessage<E>);
      },

      /** One record from the authority: reduced with the same spec — unless this proxy already guessed it. */
      receive(record: R): void {
        const mine = this.state.private;
        if (mine.guessed.has(written(record))) {
          mine.guessed.delete(written(record));
          return;
        }
        try {
          this.state.public.state = spec.reduce(this.state.public.state, record);
          this.self.notify();
        } catch (error) {
          this.exit(reasonOf(error));
        }
      },

      reject(requestId: string, reason: E): void {
        this.emit({ type: 'REJECTED', requestId, reason } satisfies RecordOutMessage<E>);
      },
    },
  });
}

/** A running proxy. */
export type ProxyProc<S, R, Q, E = string> = SpawnedFrom<ReturnType<typeof makeDurableProxyActor<S, R, Q, E>>>;
