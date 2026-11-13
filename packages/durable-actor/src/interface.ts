// ── what a durable actor is, and what it is told ────────────────────────────
//
// The spec is four words and they are laws; the messages are the whole of what a caller can say to a process and
// what a process says back.  Nothing here runs.

/** What a filter comes to: the request may go on, or the refusal that says why it does not. */
export type FilterResult<E = string> = { pass: true } | { refuse: E };

/**
 * What makes a durable actor: the four words a pipeline uses.
 *
 * `filter` says whether a request may become anything at all; `map` turns a request that may into the record it
 * is.  Everything `map` needs is in its two arguments — a record's moment and ids belong to whoever built the
 * request, not to the spec — so the same request maps to the same record twice, and a replay builds what the live
 * run built.  `reduce` is the fold of records into state, `diff` its inverse for one step: the record that takes
 * one state to the next.
 */
export interface RecordSpec<S, R, Q, E = string> {
  /** May this request go on?  A `refuse` writes nothing. */
  filter(state: S, request: Q): FilterResult<E>;
  /** The record a request becomes.  Pure in its two arguments. */
  map(state: S, request: Q): R;
  /** One record onto the fold.  `null` is a fold with nothing in it yet. */
  reduce(state: S | null, record: R): S;
  /**
   * The records that take `before` to `after`.
   *
   * One step of `reduce`, inverted — usually one record, because a fold step is one record.  With `null` for
   * `before` it is every record needed to build the state from nothing, which is what a source starts a reader
   * with: a list, so a vocabulary needs no special "the whole thing" record.
   */
  diff(before: S | null, after: S): R[];
}

/** What a process publishes: the fold, and how many are keeping it up. */
export interface RecordPublic<S> {
  /** The fold as it stands, or null before the first record arrived. */
  state: S | null;
  /** Followers plus requests in flight: what keeps the process up. */
  watching: number;
}

// ── what a caller says ──────────────────────────────────────────────────────

/** Ask the process to write a record: the request, and the id its answer carries. */
export interface AddRecord<Q> {
  type: 'ADD_RECORD';
  requestId: string;
  request: Q;
}

/** Somebody is watching: the process stays up while they are. */
export interface AttachProcess {
  type: 'ATTACH';
}

/** They left; it goes down when nobody is left. */
export interface DetachProcess {
  type: 'DETACH';
}

/** Everything a process is told: a request to filter, or a claim on its life. */
export type RecordInMessage<Q> = AddRecord<Q> | AttachProcess | DetachProcess;

// ── what a follower is fed ──────────────────────────────────────────────────

/**
 * One frame of a follower's source: the fold where it arrives, or a record that changed it.
 *
 * A follower has no log of its own — the difference it is told needs something to be different from — so the
 * state it starts at travels with the records rather than beside them.
 */
// ── what a process says ─────────────────────────────────────────────────────

/** The record was written and has come back reduced: the state holds it. */
export interface RecordAccepted {
  type: 'RECORD_ACCEPTED';
  requestId: string;
}

/** The spec refused it, in its own vocabulary.  Nothing was written. */
export interface RecordRejected<E = string> {
  type: 'RECORD_REJECTED';
  requestId: string;
  reason: E;
}

/**
 * Everything a process says: whether it took the request, and nothing about the work — that is the state.
 *
 * There is no third word.  A process that cannot go on (its source went, a record would not fold) dies with the
 * reason instead of answering, because a caller waiting on a dead process hears that it ended.
 */
export type RecordOutMessage<E = string> = RecordAccepted | RecordRejected<E>;

/**
 * What a caller needs of a durable actor, whoever it is.
 *
 * The process that owns the log and the one that follows it answer the same words, so a caller handed this
 * cannot tell which it has.
 */
export interface RecordHandle<S, Q, E = string> {
  /** The published state: the fold, and whatever else the process chose to say about itself. */
  readonly state: { state: S | null } | null;
  send(message: RecordInMessage<Q>): void;
  subscribe(event: 'message', handler: (message: RecordOutMessage<E>) => void): () => void;
  subscribe(event: 'state', handler: () => void): () => void;
  wait(): Promise<void>;
}
