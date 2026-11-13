// ── the process that follows ────────────────────────────────────────────────
//
// A follower keeps the authority's fold and answers for it, and never writes: what it is given to send leaves
// through a request that answers or a channel that only carries.  In `optimistic` mode it also shows a record the
// authority has not written yet, and holds it until an answer or the record itself settles it.

import { defineActor, defineMessages, type SpawnedFrom } from 'posipaki';
import type { Channel } from 'posipaki/port';

import type {
  ProxyMode,
  RecordInMessage,
  RecordOutMessage,
  RecordPublic,
  RecordSpec,
} from './interface';
import { reasonOf, written } from './record';
import {
  Refused,
  processOf,
  upstreamOf,
  type Sendable,
  type Upstream,
  type UpstreamSource,
} from './upstream';

export type { ProxyMode } from './interface';

export interface ProxyOptions {
  /** Default `deferred`. */
  mode?: ProxyMode;
}

export interface ProxyArgs<S, R, Q, E = string> {
  /** Where requests go: a call that answers, a channel that only carries, or a process used as one of the two. */
  upstream: UpstreamSource<S, Q, E>;
  /** What it is fed: the fold where it arrives, then one record per change — `mirrorChannel` over the authority. */
  source: Channel<R, string>;
}

/** A request on its way up: who is waiting for it, what was asked, and the record this side makes of it. */
interface Asked<Q, R> {
  kind: 'asked';
  callerId: string;
  request: Q;
  /** What `map` made of the request, or null when this follower had no fold to ask it about. */
  record: R | null;
  /** Whether it is already in the fold this follower shows: a guess, rather than a request still on its way. */
  shown: boolean;
}

/** A record the log has that could not be placed: it belongs after the requests that are still in flight. */
interface Heard<R> {
  kind: 'heard';
  record: R;
}

/** What is not in the authority's fold yet, in the order it happened. */
type Pending<Q, R> = Asked<Q, R> | Heard<R>;

/** What the authority said about a request: taken, or refused in the spec's own words. */
type Answer<E> = { ok: true } | { ok: false; reason: E };

interface Private<S, R, Q, E> {
  upstream: Upstream<Q, E>;
  /** The process it sends to, when it was handed one: what this follower attaches to and lets go of. */
  process: Sendable<Q, E> | null;
  source: Channel<R, string>;
  stopReading: () => void;
  mode: ProxyMode;
  /** The authority's fold, built from its records alone: what a guess is replayed over. */
  confirmed: S | null;
  pending: Pending<Q, R>[];
}

/**
 * A follower: the same fold as the authority, over a channel it may not write.
 *
 * It filters nothing of its own — the authority's refusal is the only rule — except in `optimistic` mode, where it
 * applies the spec to guess and says so if the guess was wrong.
 */
export function makeDurableProxyActor<S, R, Q, E = string>(
  spec: RecordSpec<S, R, Q, E>,
  options: ProxyOptions = {},
) {
  return defineActor({
    name: 'proxy',
    inMessages: defineMessages<RecordInMessage<Q>>(),
    outMessages: defineMessages<RecordOutMessage<E>>(),

    setup(args: ProxyArgs<S, R, Q, E>): {
      public: RecordPublic<S>;
      private: Private<S, R, Q, E>;
    } {
      const mode = options.mode ?? 'deferred';
      return {
        public: { state: null, watching: 0 },
        private: {
          upstream: upstreamOf(args.upstream, mode),
          process: processOf(args.upstream),
          source: args.source,
          stopReading: () => {},
          mode,
          confirmed: null,
          pending: [],
        },
      };
    },

    afterStart() {
      const mine = this.state.private;
      // The records are the authority's; the requests in between are this process's own.
      mine.stopReading = mine.source.onFrame((record) => this.receive(record));
      mine.source.onClose((reason: string) => this.exit(reason));
      mine.process?.send({ type: 'ATTACH' });
    },

    async beforeEnd() {
      this.state.private.stopReading();
      this.state.private.process?.send({ type: 'DETACH' });
    },

    handlers: {
      /** A request: guessed and shown at once, or carried up and answered when the authority has spoken. */
      ADD_RECORD(message) {
        const mine = this.state.private;
        const shown = this.state.public.state;
        // A guess needs a fold to guess from, and a follower before its first record has none: the request is asked.
        const guessed = mine.mode === 'optimistic' && shown !== null;
        if (guessed) {
          const verdict = spec.filter(shown, message.request);
          if ('refuse' in verdict) return this.reject(message.requestId, verdict.refuse);
        }
        const asked: Asked<Q, R> = {
          kind: 'asked',
          callerId: message.requestId,
          request: message.request,
          record: shown === null ? null : spec.map(shown, message.request),
          shown: guessed,
        };
        mine.pending.push(asked);
        if (guessed) {
          this.show();
          this.emit({ type: 'RECORD_ACCEPTED', requestId: message.requestId } satisfies RecordOutMessage<E>);
        }
        void this.ask(asked);
      },
      ATTACH() {},
      DETACH() {},
    },

    methods: {
      /** Carry one request up; what comes back is the answer, when the medium has one to give. */
      async ask(asked: Asked<Q, R>): Promise<void> {
        try {
          const answered = await this.carry(asked.request);
          // A medium that only carries says nothing about whether the request was taken: the record is the answer.
          if (!answered) return;
        } catch (error) {
          // A medium that failed is not a refusal: nothing here can tell a caller the authority said no.
          if (!(error instanceof Refused)) return this.exit(reasonOf(error));
          this.settle(asked, { ok: false, reason: error.reason as E });
          this.drain();
          this.show();
          return;
        }
        // A shown guess is not settled here: the record that says the same thing is on its way, and retires it.
        if (asked.shown) return;
        this.settle(asked, { ok: true });
        this.drain();
        this.show();
      },

      /** What this follower works through: the medium's own shape, hidden from the rest of it. */
      async carry(request: Q): Promise<boolean> {
        const upstream = this.state.private.upstream;
        if (typeof upstream === 'function') {
          await upstream(request);
          return true;
        }
        await upstream.send(request);
        return false;
      },

      /** One record from the authority: retired against the oldest request, or held until what is before it settles. */
      receive(record: R): void {
        const mine = this.state.private;
        const asked = this.oldest();
        if (asked !== null && this.madeOf(asked, record)) {
          mine.confirmed = spec.reduce(mine.confirmed, record);
          this.settle(asked, { ok: true });
        } else {
          mine.pending.push({ kind: 'heard', record });
        }
        this.drain();
        this.show();
      },

      /** Whether that record is the one the authority made of that request: whole, unless the spec says otherwise. */
      madeOf(asked: Asked<Q, R>, record: R): boolean {
        if (asked.record === null) return false;
        if (spec.producedFrom !== undefined) return spec.producedFrom(asked.request, record);
        return written(asked.record) === written(record);
      },

      oldest(): Asked<Q, R> | null {
        for (const entry of this.state.private.pending) if (entry.kind === 'asked') return entry;
        return null;
      },

      /** Take a request out of what is pending, and say what the authority said about it. */
      settle(asked: Asked<Q, R>, answer: Answer<E>): void {
        const pending = this.state.private.pending;
        const at = pending.indexOf(asked);
        if (at < 0) return;
        pending.splice(at, 1);
        // A guess was already answered when it was shown: only a refusal has anything left to say about it.
        if (answer.ok && asked.shown) return;
        this.emit(
          answer.ok
            ? ({ type: 'RECORD_ACCEPTED', requestId: asked.callerId } satisfies RecordOutMessage<E>)
            : ({
                type: 'RECORD_REJECTED',
                requestId: asked.callerId,
                reason: answer.reason,
              } satisfies RecordOutMessage<E>),
        );
      },

      /** A record nothing is waiting on is the authority's: it enters the fold the moment nothing is before it. */
      drain(): void {
        const mine = this.state.private;
        for (;;) {
          const head = mine.pending[0];
          if (head === undefined || head.kind !== 'heard') return;
          mine.confirmed = spec.reduce(mine.confirmed, head.record);
          mine.pending.shift();
        }
      },

      /**
       * Publish the fold as this follower shows it: the authority's, with the guesses still in flight on top.
       *
       * A record held behind a guess is not shown: it cannot be placed until the guess is settled, and the fold
       * that would put it first is not the one the authority will end up with.
       */
      show(): void {
        const mine = this.state.private;
        let folded = mine.confirmed;
        for (const entry of mine.pending) {
          if (entry.kind === 'asked' && entry.shown && entry.record !== null) {
            folded = spec.reduce(folded, entry.record);
          }
        }
        this.state.public.state = folded;
        this.self.notify();
      },

      /** The spec's refusal: nothing was written, and this is why, in the spec's own vocabulary. */
      reject(callerId: string, reason: E): void {
        this.emit({ type: 'RECORD_REJECTED', requestId: callerId, reason } satisfies RecordOutMessage<E>);
      },
    },
  });
}

/** A running follower. */
export type ProxyProc<S, R, Q, E = string> = SpawnedFrom<
  ReturnType<typeof makeDurableProxyActor<S, R, Q, E>>
>;
