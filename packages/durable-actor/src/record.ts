// ── a durable actor ─────────────────────────────────────────────────────────
//
// A process whose state is the fold of the records it was given, and whose only words are whether it took a
// request.  The records come from a channel — a journal file, an in-memory log, a peer's stream — so the same
// actor is a local task, a follower and a projection, and the channel is the only thing that differs.
//
// Four rules, and nothing else: a record is reduced into the state; a request is filtered against that state
// before anything is written; a passed request is mapped to a record and written back through the same channel,
// and the accept is sent when that record comes back reduced.

import { defineActor, defineMessages, type SpawnedFrom } from 'posipaki';
import type { Channel } from 'posipaki/port';
/** What a filter comes to: the request as it goes on, or the refusal that says why it does not. */
/** What a filter comes to: the request may go on, or the refusal that says why it does not. */
export type FilterResult<E = string> = { pass: true } | { refuse: E };

/**
 * What makes a durable actor: the four words a pipeline uses.
 *
 * `filter` says whether a request may become anything at all; `map` turns a request that may into the record it
 * is.  Everything `map` needs is in its two arguments — a record's moment and ids belong to whoever built the
 * request, not to the spec — so the same request maps to the same record twice, and a replay builds what the
 * live run built.  `reduce` is the fold of records into state, `diff` its inverse for one step: the record that
 * takes one state to the next.
 */
export interface RecordSpec<S, R, Q, E = string> {
  /** May this request go on?  A `refuse` writes nothing. */
  filter(state: S, request: Q): FilterResult<E>;
  /** The record a request becomes.  Pure in its two arguments. */
  map(state: S, request: Q): R;
  /** One record onto the fold.  `null` is a fold with nothing in it yet. */
  reduce(state: S | null, record: R): S;
  /** The record that takes `before` to `after`: `reduce` inverted for one step. */
  diff(before: S | null, after: S): R;
}

export interface RecordPublic<S> {
  /** The fold as it stands, or null before the first record arrived. */
  state: S | null;
  /** Followers plus requests in flight: what keeps the process up. */
  watching: number;
}

/** What a caller says to a durable actor: a request to filter, or a claim on the process. */
export type RecordInMessage<Q> =
  | { type: 'ASK'; requestId: string; request: Q }
  | { type: 'ATTACH' }
  | { type: 'DETACH' };

/**
 * What it says back.  Nothing about the work — that is the state.
 *
 * `REJECTED` is the spec's word and carries its own `E`; `FAILED` is the process's, for what no spec had an
 * opinion about: the source went, or a record would not fold.
 */
export type RecordOutMessage<E = string> =
  | { type: 'ACCEPTED'; requestId: string }
  | { type: 'REJECTED'; requestId: string; reason: E }
  | { type: 'FAILED'; requestId: string; reason: string };

/**
 * What a caller needs of a durable actor, whoever it is.
 *
 * An authoritative process and a proxy answer the same words: the same requests, the same answers, the same
 * published state.  A caller handed this cannot tell which it has, which is the point.
 */
export interface RecordHandle<S, Q, E = string> {
  /** The published state: the fold, and whatever else the process chose to say about itself. */
  readonly state: { state: S | null } | null;
  send(message: RecordInMessage<Q>): void;
  subscribe(event: 'message', handler: (message: RecordOutMessage<E>) => void): () => void;
  subscribe(event: 'state', handler: () => void): () => void;
  wait(): Promise<void>;
}

/** What an authoritative process is given: one channel, both ways. */
export interface AuthoritativeArgs<R> {
  /** Records come from here, and a passed request's record goes back here. */
  source: Channel<R, string>;
}

interface Private<R> {
  source: Channel<R, string>;
  stopReading: () => void;
  watching: number;
  /** Whether anybody has watched: a process is not torn down before its first reason to exist arrives. */
  seen: boolean;
  /** Records this process wrote and has not seen come back, by what was written, and who to answer. */
  awaiting: Map<string, string>;
}

/** A record as the source will hand it back: what an answer is matched against. */
export function written<R>(record: R): string {
  return JSON.stringify(record);
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The actor an authoritative process is made of: it owns the log, so it may write what it filters.
 *
 * A proxy is the same fold and the same messages over a channel it may not write — see `proxy.ts`.
 */
export function authoritative<S, R, Q, E = string>(spec: RecordSpec<S, R, Q, E>) {
  return defineActor({
    name: 'durable',
    inMessages: defineMessages<RecordInMessage<Q>>(),
    outMessages: defineMessages<RecordOutMessage<E>>(),

    setup(args: AuthoritativeArgs<R>): { public: RecordPublic<S>; private: Private<R> } {
      return {
        public: { state: null, watching: 0 },
        private: {
          source: args.source,
          stopReading: () => {},
          watching: 0,
          seen: false,
          awaiting: new Map(),
        },
      };
    },

    afterStart() {
      const mine = this.state.private;
      // What the source holds arrives before this returns, so the state is the log's when the loop starts.
      mine.stopReading = mine.source.onFrame((record) => this.reduce(record));
      mine.source.onError((error: unknown) => this.stop(reasonOf(error)));
      mine.source.onClose((reason: string) => this.stop(reason));
    },

    async beforeEnd() {
      this.state.private.stopReading();
      await this.state.private.source.close('the durable actor is over');
    },

    handlers: {
      /** A request: filtered here, and written if the rules allow it.  The answer follows the write back. */
      async ASK(request) {
        const mine = this.state.private;
        const state = this.state.public.state;
        if (state === null) return this.fail(request.requestId, 'no record has arrived yet');
        const verdict = spec.filter(state, request.request);
        if ('refuse' in verdict) return this.reject(request.requestId, verdict.refuse);
        const record = spec.map(state, request.request);
        this.watch(true);
        mine.awaiting.set(written(record), request.requestId);
        try {
          await mine.source.send(record);
        } catch (error) {
          mine.awaiting.delete(written(record));
          this.watch(false);
          this.fail(request.requestId, reasonOf(error));
        }
      },
      ATTACH() {
        this.watch(true);
      },
      DETACH() {
        this.watch(false);
      },
    },

    methods: {
      /** One record arrived: reduce it, publish the state, and answer it if it is one of ours. */
      reduce(record: R): void {
        const mine = this.state.private;
        let state: S;
        try {
          state = spec.reduce(this.state.public.state, record);
        } catch (error) {
          this.stop(reasonOf(error));
          return;
        }
        this.state.public.state = state;
        this.self.notify();
        const requestId = mine.awaiting.get(written(record));
        if (requestId === undefined) return;
        mine.awaiting.delete(written(record));
        this.emit({ type: 'ACCEPTED', requestId } satisfies RecordOutMessage<E>);
        this.watch(false);
      },

      /** The spec's refusal: the record was not written, and this is why, in the spec's own vocabulary. */
      reject(requestId: string, reason: E): void {
        this.emit({ type: 'REJECTED', requestId, reason } satisfies RecordOutMessage<E>);
      },

      /** The process's own word, for what no spec had an opinion about. */
      fail(requestId: string, reason: string): void {
        this.emit({ type: 'FAILED', requestId, reason } satisfies RecordOutMessage<E>);
      },

      /** Somebody joined or left: the count is what the process lives on. */
      watch(joined: boolean): void {
        const mine = this.state.private;
        mine.watching = Math.max(0, mine.watching + (joined ? 1 : -1));
        if (joined) mine.seen = true;
        this.state.public.watching = mine.watching;
        this.self.notify();
        if (!joined && mine.seen && mine.watching === 0) this.exit('nobody is watching');
      },

      /** The source went away, or said something nobody can reduce: that is the end of the process. */
      stop(reason: string): void {
        const mine = this.state.private;
        mine.stopReading();
        for (const requestId of mine.awaiting.values()) this.fail(requestId, reason);
        mine.awaiting.clear();
        this.exit(reason);
      },
    },
  });
}

/** A running authoritative process. */
export type AuthoritativeProc<S, R, Q, E = string> = SpawnedFrom<
  ReturnType<typeof authoritative<S, R, Q, E>>
>;
