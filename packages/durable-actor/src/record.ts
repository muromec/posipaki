// ── the process that owns the log ───────────────────────────────────────────
//
// A durable actor: its state is the fold of the records it was given, and it writes what it filters.  The records
// come from a channel — a journal file, an in-memory log, a peer's stream — so the same actor is a local task, a
// follower and a projection, and the channel is the only thing that differs.
//
// Four rules, and nothing else: a record is reduced into the state; a request is filtered against that state
// before anything is written; a passed request is mapped to a record and written back through the same channel;
// and the accept is sent when that record comes back reduced.

import { defineActor, defineMessages, type SpawnedFrom } from 'posipaki';
import type { Channel } from 'posipaki/port';

import type {
  RecordInMessage,
  RecordOutMessage,
  RecordPublic,
  RecordSpec,
} from './interface';

/** What the process that owns the log is given: one channel, both ways. */
export interface AuthoritativeArgs<R> {
  /** Records come from here, and a passed request's record goes back here. */
  log: Channel<R, string>;
}

interface Private<R> {
  log: Channel<R, string>;
  stopReading: () => void;
  watching: number;
  /** Whether anybody has watched: a process is not torn down before its first reason to exist arrives. */
  seen: boolean;
  /** Records this process wrote and has not seen come back, by what was written, and who to answer. */
  awaiting: Map<string, string>;
  /** Resolved by the first record, or by a source that ended before one arrived. */
  folded: Promise<void>;
  markFolded: () => void;
}

/** A record as the log will hand it back: what an answer is matched against. */
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
export function makeDurableActor<S, R, Q, E = string>(spec: RecordSpec<S, R, Q, E>) {
  return defineActor({
    name: 'durable',
    inMessages: defineMessages<RecordInMessage<Q>>(),
    outMessages: defineMessages<RecordOutMessage<E>>(),

    setup(args: AuthoritativeArgs<R>): { public: RecordPublic<S>; private: Private<R> } {
      // The process is up before its log has been handed over, so a request waits on the first record rather
      // than being refused a state that has not arrived.
      const fold: { done?: () => void } = {};
      const folded = new Promise<void>((resolve) => {
        fold.done = resolve;
      });
      const markFolded = (): void => fold.done?.();
      return {
        public: { state: null, watching: 0 },
        private: {
          log: args.log,
          stopReading: () => {},
          watching: 0,
          seen: false,
          awaiting: new Map(),
          folded,
          markFolded,
        },
      };
    },

    afterStart() {
      const mine = this.state.private;
      // What the log holds arrives before this returns, so the state is the log's when the loop starts.
      mine.stopReading = mine.log.onFrame((record) => this.reduce(record));
      mine.log.onError((error: unknown) => this.crash(reasonOf(error)));
      mine.log.onClose((reason: string) => this.crash(reason));
    },

    async beforeEnd() {
      this.state.private.stopReading();
      await this.state.private.log.close('the durable actor is over');
    },

    handlers: {
      /** A request: filtered here, and written if the rules allow it.  The answer follows the write back. */
      async ADD_RECORD(request) {
        const mine = this.state.private;
        // A request that arrives before the log has been handed over waits for its first record: the state a
        // request is judged against is the log's, and the log has not spoken yet.
        await mine.folded;
        const state = this.state.public.state;
        if (state === null) throw new Error('this process folded to nothing');
        const verdict = spec.filter(state, request.request);
        if ('refuse' in verdict) return this.reject(request.requestId, verdict.refuse);
        const record = spec.map(state, request.request);
        this.watch(true);
        mine.awaiting.set(written(record), request.requestId);
        // A write that cannot be made is the end of this process: the caller waiting on it hears that it ended.
        await mine.log.send(record);
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
        // A record this spec cannot reduce is a journal it cannot read, and guessing past it is worse: the
        // process ends with the sentence rather than letting the throw escape through the channel that delivered
        // the record.
        try {
          this.state.public.state = spec.reduce(this.state.public.state, record);
        } catch (error) {
          this.crash(reasonOf(error));
          return;
        }
        mine.markFolded();
        this.self.notify();
        const requestId = mine.awaiting.get(written(record));
        if (requestId === undefined) return;
        mine.awaiting.delete(written(record));
        this.emit({ type: 'RECORD_ACCEPTED', requestId } satisfies RecordOutMessage<E>);
        this.watch(false);
      },

      /** The spec's refusal: the record was not written, and this is why, in the spec's own vocabulary. */
      reject(requestId: string, reason: E): void {
        this.emit({ type: 'RECORD_REJECTED', requestId, reason } satisfies RecordOutMessage<E>);
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

      /** The log went away: the process goes with it, and a caller waiting hears that it ended. */
      crash(reason: string): void {
        this.state.private.stopReading();
        // A source that ends before its first record leaves nothing to fold: the wait for one ends here too.
        this.state.private.markFolded();
        this.exit(reason);
      },
    },
  });
}

/** A running process that owns a log. */
export type AuthoritativeProc<S, R, Q, E = string> = SpawnedFrom<
  ReturnType<typeof makeDurableActor<S, R, Q, E>>
>;
