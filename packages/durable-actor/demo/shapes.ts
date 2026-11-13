// ── the demo's spec: three figures on a 2×2 board ───────────────────────────

import type { FilterResult, RecordSpec } from '../src/interface';

export type Shape = 'triangle' | 'diamond' | 'circle';
export type Colour = 'red' | 'blue' | 'yellow';

export interface Figure {
  shape: Shape;
  colour: Colour;
}

/** A 2×2 board.  `cells[i]` is what stands in box `i`, or nothing. */
export interface Board {
  cells: (Figure | null)[];
  /** Who made the last change, and when: kept so `diff` can name the record that made it. */
  by: string;
  at: number;
  moves: number;
}

export type ShapesRecord =
  | { type: 'PLACE'; at: number; by: string; cell: number; figure: Figure }
  | { type: 'LIFT'; at: number; by: string; cell: number }
  /** Two of a figure on one board: the board is cleared, and the record says so. */
  | { type: 'CLEAR'; at: number; by: string };

export type ShapesAsk = {
  by: string;
  cell: number;
  figure: Figure | null;
  /** When it was asked: the caller stamps it. */
  at: number;
};

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
    if (ask.figure === null) return { type: 'LIFT', at: ask.at, by: ask.by, cell: ask.cell };
    return { type: 'PLACE', at: ask.at, by: ask.by, cell: ask.cell, figure: ask.figure };
  },

  reduce(board: Board | null, record: ShapesRecord): Board {
    const base: Board = board ?? { cells: Array(CELLS).fill(null), by: '', at: 0, moves: 0 };
    if (record.type === 'CLEAR') {
      return {
        cells: Array(CELLS).fill(null),
        by: record.by,
        at: record.at,
        moves: base.moves + 1,
      };
    }
    if (record.type === 'LIFT') {
      const cells = [...base.cells];
      cells[record.cell] = null;
      return { cells, by: record.by, at: record.at, moves: base.moves + 1 };
    }
    // Two of a figure do not stand: the second clears the board, which is the rule the demo shows.
    const cells: (Figure | null)[] = [...base.cells];
    cells[record.cell] = record.figure;
    const pair = twin({ ...base, cells }, record.figure);
    const cleared = pair !== null && pair !== record.cell;
    return {
      cells: cleared ? Array(CELLS).fill(null) : cells,
      by: record.by,
      at: record.at,
      moves: base.moves + 1,
    };
  },

  diff(before: Board | null, after: Board): ShapesRecord {
    const said: Board = before ?? { cells: Array(CELLS).fill(null), by: '', at: 0, moves: 0 };
    const filled = after.cells.every((cell) => cell === null);
    const wasFilled = said.cells.some((cell) => cell !== null);
    if (filled && wasFilled) return { type: 'CLEAR', at: after.at, by: after.by };
    for (let cell = 0; cell < CELLS; cell += 1) {
      const was = said.cells[cell] ?? null;
      const now = after.cells[cell] ?? null;
      if (was === null && now !== null)
        return { type: 'PLACE', at: after.at, by: after.by, cell, figure: now };
      if (was !== null && now === null) return { type: 'LIFT', at: after.at, by: after.by, cell };
    }
    return { type: 'CLEAR', at: after.at, by: after.by };
  },
};
