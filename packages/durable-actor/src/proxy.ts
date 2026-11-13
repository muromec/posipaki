import { defineActor, defineMessages, type SpawnedFrom } from 'posipaki';
import type { Channel } from 'posipaki/port';

import type { Followed } from './followed';
import type {
  RecordFeed,
  RecordInMessage,
  RecordOutMessage,
  RecordPublic,
  RecordSpec,
} from './interface';
import { reasonOf, written } from './record';

/** When a follower shows a change: after the authority has it, or at once and undone if it is refused. */
export type ProxyMode = 'deferred' | 'optimistic';

export interface ProxyOptions {
  /** Default `deferred`. */
  mode?: ProxyMode;
}

export interface ProxyArgs<S, R, Q, E = string> {
  /** The process that owns the log and filters: what answers a request. */
  authority: Followed<S, Q, E>;
  /** What it is fed: the fold where it arrives, then one record per change — `mirrorChannel` over the authority. */
  source: Channel<RecordFeed<S, R>, string>;
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
  source: Channel<RecordFeed<S, R>, string>;
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
        public: { state: null, watching: 0 },
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
      mine.stopReading = mine.source.onFrame((feed) => this.receive(feed));
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
      ADD_RECORD(request) {
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
        mine.authority.send({ type: 'ADD_RECORD', requestId: asking, request: request.request });
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
        this.emit({ type: 'RECORD_ACCEPTED', requestId: callerId } satisfies RecordOutMessage<E>);
        mine.guessed.add(written(record));
        mine.guessing.set(asking, { callerId, record, before, request });
        mine.authority.send({ type: 'ADD_RECORD', requestId: asking, request });
      },

      /** What the authority said, in the words of whoever asked this proxy. */
      relayed(answer: RecordOutMessage<E>): void {
        const mine = this.state.private;
        const guess = mine.guessing.get(answer.requestId);
        if (guess !== undefined) {
          mine.guessing.delete(answer.requestId);
          if (answer.type === 'RECORD_ACCEPTED') return;
          // The guess was wrong: the fold goes back, and the caller who was told yes a moment ago is told no —
          // the same answer the authority gave, arriving late.
          this.state.public.state = guess.before;
          this.self.notify();
          mine.guessed.delete(written(guess.record));
          this.emit({
            type: 'RECORD_REJECTED',
            requestId: guess.callerId,
            reason: answer.reason,
          } satisfies RecordOutMessage<E>);
          return;
        }
        const callerId = mine.asking.get(answer.requestId);
        if (callerId === undefined) return;
        mine.asking.delete(answer.requestId);
        if (answer.type === 'RECORD_ACCEPTED') {
          this.emit({ type: 'RECORD_ACCEPTED', requestId: callerId } satisfies RecordOutMessage<E>);
          return;
        }
        this.emit({ ...answer, requestId: callerId } satisfies RecordOutMessage<E>);
      },

      /** One record from the authority: reduced with the same spec — unless this proxy already guessed it. */
      /** One frame from the authority: where it stands, or a record — reduced with the same spec. */
      receive(feed: RecordFeed<S, R>): void {
        const mine = this.state.private;
        if ('snapshot' in feed) {
          this.state.public.state = feed.snapshot;
          this.self.notify();
          return;
        }
        if (mine.guessed.has(written(feed.record))) {
          mine.guessed.delete(written(feed.record));
          return;
        }
        // A record this spec cannot reduce is the end of the process, the same as on the authority's side.
        this.state.public.state = spec.reduce(this.state.public.state, feed.record);
        this.self.notify();
      },

      reject(requestId: string, reason: E): void {
        this.emit({ type: 'RECORD_REJECTED', requestId, reason } satisfies RecordOutMessage<E>);
      },
    },
  });
}

/** A running proxy. */
export type ProxyProc<S, R, Q, E = string> = SpawnedFrom<ReturnType<typeof makeDurableProxyActor<S, R, Q, E>>>;
