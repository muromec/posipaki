// ── the demo's spec: four shapes on a 2×2 board ────────────────────────────

import type { FilterResult, RecordSpec } from '../src/interface';

/**
 * What stands in a box.  A shape and nothing else: a colour is how a shape is *drawn*, so it belongs to the page,
 * not to the record — the same board renders the same either way.
 */
export type Shape = 'triangle' | 'diamond' | 'circle' | 'square';

/** A 2×2 board: what stands in each box.  Nothing else — the demo has no use for a moment or an author. */
export interface Board {
  cells: (Shape | null)[];
}

export type ShapesRecord =
  | { type: 'PLACE'; cell: number; shape: Shape }
  | { type: 'LIFT'; cell: number }
  /** Two of a shape on one board: the board is cleared, and the record says so. */
  | { type: 'CLEAR' };

export type ShapesAsk = { cell: number; shape: Shape | null };

const CELLS = 4;

/** The box that already holds this shape, if any. */
function twin(board: Board, shape: Shape): number | null {
  const at = board.cells.findIndex((cell) => cell === shape);
  return at === -1 ? null : at;
}

export const shapesSpec: RecordSpec<Board, ShapesRecord, ShapesAsk> = {
  filter(board: Board, ask: ShapesAsk): FilterResult {
    if (ask.cell < 0 || ask.cell >= CELLS) {
      return { refuse: `${ask.cell} is not a box on this board` };
    }
    const taken = board.cells[ask.cell] !== null;
    if (ask.shape === null && !taken) return { refuse: `box ${ask.cell} is empty` };
    if (ask.shape !== null && taken) return { refuse: `box ${ask.cell} is taken` };
    return { pass: true };
  },

  map(_board: Board, ask: ShapesAsk): ShapesRecord {
    if (ask.shape === null) return { type: 'LIFT', cell: ask.cell };
    return { type: 'PLACE', cell: ask.cell, shape: ask.shape };
  },

  reduce(board: Board | null, record: ShapesRecord): Board {
    const empty = (): Board => ({ cells: Array<Shape | null>(CELLS).fill(null) });
    if (record.type === 'CLEAR') return empty();
    const cells = [...(board?.cells ?? empty().cells)];
    if (record.type === 'LIFT') {
      cells[record.cell] = null;
      return { cells };
    }
    cells[record.cell] = record.shape;
    // Two of a shape do not stand: the second one clears the board, which is the rule the demo shows.
    const pair = twin({ cells }, record.shape);
    return pair !== null && pair !== record.cell ? empty() : { cells };
  },

  diff(before: Board | null, after: Board): ShapesRecord[] {
    // From nothing: one PLACE per shape that stands — and a CLEAR when none does, because a follower has to hear
    // something to know the source has spoken.
    if (before === null) {
      const places = after.cells.flatMap((shape, cell): ShapesRecord[] =>
        shape === null ? [] : [{ type: 'PLACE', cell, shape }],
      );
      return places.length === 0 ? [{ type: 'CLEAR' }] : places;
    }
    const empty = after.cells.every((cell) => cell === null);
    const was = before.cells.some((cell) => cell !== null);
    if (empty && was) return [{ type: 'CLEAR' }];
    for (let cell = 0; cell < CELLS; cell += 1) {
      const had = before.cells[cell] ?? null;
      const has = after.cells[cell] ?? null;
      if (had === null && has !== null) return [{ type: 'PLACE', cell, shape: has }];
      if (had !== null && has === null) return [{ type: 'LIFT', cell }];
    }
    return [{ type: 'CLEAR' }];
  },
};
