// ── the ticket, as a record spec ────────────────────────────────────────────
//
// The case the generic actor was cut from: a ticket opened with a word, moved by its owner, commented on.
// Two things the four words make explicit here.  The clock is the caller's: it stamps `at` on the ask it makes, so
// the record says when the ask happened without the spec reading a clock of its own.  And `diff` needs the state to
// remember who moved it (`movedBy`), because a fold that dropped it could not say.
//
// `diff` answers a list, which is what lets `diff(null, ticket)` rebuild a ticket mid-life: its opening word, then
// every comment after it.  A vocabulary with one record per step needs no special "the whole thing" record.

import type { FilterResult, RecordSpec } from '../src/interface';

export type TicketState = 'SUBMITTED' | 'WORKING' | 'COMPLETED' | 'CANCELED';

export interface Comment {
  by: string | null;
  at: string;
  text: string;
}

export interface Ticket {
  id: string;
  state: TicketState;
  owner: string;
  /** When it was opened, and when it last moved.  Two facts, because a comment moves neither. */
  openedAt: string;
  movedAt: string;
  /** Who moved it last.  Kept for `diff`: a fold that dropped it could not say who changed the state. */
  movedBy: string | null;
  comments: Comment[];
}

export type TicketRecord =
  | { type: 'TASK_OPENED'; id: string; at: string; owner: string; by: string | null; text: string }
  | { type: 'TASK_MOVED'; at: string; by: string; state: TicketState }
  | { type: 'TASK_COMMENT'; at: string; by: string; text: string };

export type TicketAsk = {
  by: string;
  /** When it was asked: the caller stamps it, which is what keeps a replayed ask the same ask. */ at: string;
} & ({ type: 'MOVE'; state: TicketState } | { type: 'COMMENT'; text: string });

const FINAL: readonly TicketState[] = ['COMPLETED', 'CANCELED'];

/** A ticket: opened once, changed by its owner while it is not over. */
export const ticketSpec: RecordSpec<Ticket, TicketRecord, TicketAsk> = {
  filter(state: Ticket | null, ask: TicketAsk): FilterResult {
    if (state === null) return { refuse: `no ticket has been opened: ${ask.by} has nothing to change` };
    if (state.owner !== ask.by) {
      return { refuse: `${state.id} belongs to ${state.owner}: ${ask.by} may not change it` };
    }
    if (FINAL.includes(state.state)) {
      return { refuse: `${state.id} is ${state.state}: nothing changes it again` };
    }
    return { pass: true };
  },

  map(_state: Ticket | null, ask: TicketAsk): TicketRecord {
    if (ask.type === 'MOVE')
      return { type: 'TASK_MOVED', at: ask.at, by: ask.by, state: ask.state };
    return { type: 'TASK_COMMENT', at: ask.at, by: ask.by, text: ask.text };
  },

  reduce(state: Ticket | null, record: TicketRecord): Ticket {
    if (record.type === 'TASK_OPENED') {
      if (state !== null) throw new Error(`${state.id} is already open`);
      return {
        id: record.id,
        state: 'SUBMITTED',
        owner: record.owner,
        openedAt: record.at,
        movedAt: record.at,
        movedBy: null,
        comments: [{ by: record.by, at: record.at, text: record.text }],
      };
    }
    if (state === null) throw new Error(`${record.type} arrived before TASK_OPENED`);
    if (record.type === 'TASK_COMMENT') {
      return {
        ...state,
        comments: [...state.comments, { by: record.by, at: record.at, text: record.text }],
      };
    }
    return { ...state, state: record.state, movedAt: record.at, movedBy: record.by };
  },

  diff(before: Ticket | null, after: Ticket): TicketRecord[] {
    const opening = after.comments[0];
    // From nothing: the opening word, then every comment and move since — the ticket rebuilt in the records it
    // has, which is what a follower arriving mid-life is told.
    if (before === null) {
      const opened: TicketRecord = {
        type: 'TASK_OPENED',
        id: after.id,
        at: after.openedAt,
        owner: after.owner,
        by: opening?.by ?? null,
        text: opening?.text ?? '',
      };
      const rest = after.comments.slice(1).map((said): TicketRecord => ({
        type: 'TASK_COMMENT',
        at: said.at,
        by: said.by ?? after.owner,
        text: said.text,
      }));
      const moved: TicketRecord[] =
        after.movedBy === null
          ? []
          : [{ type: 'TASK_MOVED', at: after.movedAt, by: after.movedBy, state: after.state }];
      return [opened, ...rest, ...moved];
    }
    if (after.comments.length > before.comments.length) {
      const said = after.comments[after.comments.length - 1] as Comment;
      return [{ type: 'TASK_COMMENT', at: said.at, by: said.by ?? after.owner, text: said.text }];
    }
    return [
      {
        type: 'TASK_MOVED',
        at: after.movedAt,
        by: after.movedBy ?? after.owner,
        state: after.state,
      },
    ];
  },
};
