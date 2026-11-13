// ── the demo's spec: three figures on a 2×2 board ───────────────────────────

import type { FilterResult, RecordSpec } from '../src/interface';

export type Shape = 'triangle' | 'diamond' | 'circle' | 'square';
export type Colour = 'red' | 'blue' | 'yellow' | 'green';

export interface Figure {
  shape: Shape;
  colour: Colour;
}

/** A 2×2 board: what stands in each box.  Nothing else — the demo has no use for a moment or an author. */
export interface Board {
  cells: (Figure | null)[];
}

export type ShapesRecord =
  | { type: 'PLACE'; cell: number; figure: Figure }
  | { type: 'LIFT'; cell: number }
  /** Two of a figure on one board: the board is cleared, and the record says so. */
  | { type: 'CLEAR' };

export type ShapesAsk = { cell: number; figure: Figure | null };

const CELLS = 4;

/** The figure that already stands on the board with this shape and colour, if any. */
function twin(board: Board, figure: Figure): number | null {
  const at = board.cells.findIndex(
    (cell) => cell !== null && cell.shape === figure.shape && cell.colour === figure.colour,
  );
  return at === -1 ? null : at;
}

export const shapesSpec: RecordSpec<Board, ShapesRecord, ShapesAsk> = {
  filter(board: Board, ask: ShapesAsk): FilterResult {
    if (ask.cell < 0 || ask.cell >= CELLS) {
      return { refuse: `${ask.cell} is not a box on this board` };
    }
    const taken = board.cells[ask.cell] !== null;
    if (ask.figure === null && !taken) return { refuse: `box ${ask.cell} is empty` };
    if (ask.figure !== null && taken) return { refuse: `box ${ask.cell} is taken` };
    return { pass: true };
  },

  map(_board: Board, ask: ShapesAsk): ShapesRecord {
    if (ask.figure === null) return { type: 'LIFT', cell: ask.cell };
    return { type: 'PLACE', cell: ask.cell, figure: ask.figure };
  },

  reduce(board: Board | null, record: ShapesRecord): Board {
    const cells = [...(board?.cells ?? Array<Figure | null>(CELLS).fill(null))];
    if (record.type === 'CLEAR') return { cells: Array<Figure | null>(CELLS).fill(null) };
    if (record.type === 'LIFT') {
      cells[record.cell] = null;
      return { cells };
    }
    cells[record.cell] = record.figure;
    // Two of a figure do not stand: the second clears the board, which is the rule the demo shows.
    const pair = twin({ cells }, record.figure);
    return { cells: pair !== null && pair !== record.cell ? Array<Figure | null>(CELLS).fill(null) : cells };
  },

  diff(before: Board | null, after: Board): ShapesRecord[] {
    // From nothing: one PLACE per figure that stands — and a CLEAR when none does, because a follower has to hear
    // something to know the source has spoken.
    if (before === null) {
      const places = after.cells.flatMap((figure, cell): ShapesRecord[] =>
        figure === null ? [] : [{ type: 'PLACE', cell, figure }],
      );
      return places.length === 0 ? [{ type: 'CLEAR' }] : places;
    }
    const empty = after.cells.every((cell) => cell === null);
    const was = before.cells.some((cell) => cell !== null);
    if (empty && was) return [{ type: 'CLEAR' }];
    for (let cell = 0; cell < CELLS; cell += 1) {
      const had = before.cells[cell] ?? null;
      const has = after.cells[cell] ?? null;
      if (had === null && has !== null) return [{ type: 'PLACE', cell, figure: has }];
      if (had !== null && has === null) return [{ type: 'LIFT', cell }];
    }
    return [{ type: 'CLEAR' }];
  },
};
