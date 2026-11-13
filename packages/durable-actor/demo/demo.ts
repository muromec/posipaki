// ── three boards, two of them following a log ───────────────────────────────
//
// Every board is a durable actor whose state is the fold of records: the first one owns the log and filters, the
// second follows it and defers, the third follows the second and guesses.
//
// The channels between them can be cut, which is what makes the shape visible: a cut board stops moving, and a
// healed one comes back from the state where it attaches.

import { mirrorChannel } from '../src/mirror';
import { openLog } from '../src/log';
import { proxy } from '../src/proxy';
import { authoritative, type RecordHandle, type RecordOutMessage } from '../src/record';
import { gateChannel, type Gate } from './gate';
import {
  shapesSpec,
  type Board,
  type Figure,
  type ShapesAsk,
  type ShapesRecord,
} from './shapes';

const FIGURES: Figure[] = [
  { shape: 'triangle', colour: 'red' },
  { shape: 'diamond', colour: 'blue' },
  { shape: 'circle', colour: 'yellow' },
];

const LABELS = ['A — the log', 'B — deferred', 'C — optimistic'];

/** What the page draws for one board: the process, its canvas, and the gate above it. */
interface Node {
  name: string;
  board: Board | null;
  draw(): void;
}

const events: string[] = [];
const root = document.querySelector('#demo') as HTMLElement;
const logList = document.querySelector('#events') as HTMLElement;
const cuts = document.querySelector('#cuts') as HTMLElement;

function say(line: string): void {
  events.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
  events.length = Math.min(events.length, 40);
  logList.textContent = events.join('\n');
}

/** A figure drawn as it will stand on the board. */
function figureSvg(figure: Figure): string {
  const paint = { red: '#e5484d', blue: '#3b82f6', yellow: '#eab308' }[figure.colour];
  const shape = {
    triangle: `<polygon points="50,12 88,84 12,84" fill="${paint}"/>`,
    diamond: `<polygon points="50,8 90,50 50,92 10,50" fill="${paint}"/>`,
    circle: `<circle cx="50" cy="50" r="40" fill="${paint}"/>`,
  }[figure.shape];
  return `<svg viewBox="0 0 100 100" class="figure">${shape}</svg>`;
}

let selected: Figure | null = FIGURES[0] ?? null;

/** One board's panel: a label, a 2×2 grid, and the state it is folding. */
function panel(
  name: string,
  onCell: (cell: number) => void,
): { element: HTMLElement; grid: HTMLElement[] } {
  const wrap = document.createElement('section');
  wrap.className = 'panel';
  const title = document.createElement('h2');
  title.textContent = name;
  wrap.append(title);
  const grid = document.createElement('div');
  grid.className = 'grid';
  const cells: HTMLElement[] = [];
  for (let cell = 0; cell < 4; cell += 1) {
    const box = document.createElement('button');
    box.className = 'cell';
    box.dataset['cell'] = String(cell);
    box.addEventListener('click', () => onCell(cell));
    grid.append(box);
    cells.push(box);
  }
  wrap.append(grid);
  const board = document.createElement('div');
  board.className = 'board';
  wrap.append(board);
  root.append(wrap);
  return { element: board as HTMLElement, grid: cells };
}

/** Draw a board into the boxes it owns. */
function paint(cells: HTMLElement[], board: Board | null): void {
  cells.forEach((box, at) => {
    const figure = board?.cells[at] ?? null;
    box.innerHTML = figure === null ? '' : figureSvg(figure);
    box.dataset['filled'] = figure === null ? 'no' : 'yes';
  });
}

// ── the three processes ─────────────────────────────────────────────────────

// A board begins cleared: the log has no empty state, only a first record.
const log = openLog<ShapesRecord>([{ type: 'CLEAR', at: 0, by: 'system' }]);
const Authority = authoritative(shapesSpec);
const Follower = proxy(shapesSpec);
const Guesser = proxy(shapesSpec, { mode: 'optimistic' });

const panels = LABELS.map((label, index) => {
  const { element, grid } = panel(label, (cell) => place(index, cell));
  return { label, element, grid };
});

const authority = await Authority.spawn({ source: log.channel() }, { name: 'board-a' });

const gateAB = gateChannel(mirrorChannel(authority, shapesSpec));
const b = await Follower.spawn(
  { authority, snapshot: authority.state?.state ?? null, source: gateAB.channel },
  { name: 'board-b' },
);

// A follower attaches to a state, so C waits until B has folded one.
await new Promise<void>((resolve) => {
  if (b.state?.state != null) return resolve();
  const stop = b.subscribe('state', () => {
    if (b.state?.state == null) return;
    stop();
    resolve();
  });
});
const gateBC = gateChannel(mirrorChannel(b, shapesSpec));
const c = await Guesser.spawn(
  { authority: b, snapshot: b.state?.state ?? null, source: gateBC.channel },
  { name: 'board-c' },
);

const procs: RecordHandle<Board, ShapesAsk>[] = [authority, b, c];

/** Answers, wherever they come from: a refusal is shown where it was asked for. */
procs.forEach((proc, index) => {
  proc.subscribe('message', (message) => {
    const answer = message as RecordOutMessage;
    if (answer.type === 'ACCEPTED') return;
    if (answer.type === 'REJECTED') say(`${LABELS[index]} refused: ${answer.reason}`);
    else say(`${LABELS[index]} — ${answer.reason}`);
  });
  proc.subscribe('state', () => {
    paint(panels[index]?.grid ?? [], proc.state?.state ?? null);
  });
});

/** Ask the board in that column to change.  With a figure selected it places, without it lifts. */
function place(index: number, cell: number): void {
  const proc = procs[index];
  if (proc === undefined) return;
  const board = proc.state?.state ?? null;
  const occupied = board?.cells[cell] !== null && board?.cells[cell] !== undefined;
  const ask: ShapesAsk = {
    by: LABELS[index] ?? 'somebody',
    at: Date.now(),
    cell,
    figure: occupied || selected === null ? null : selected,
  };
  proc.send({ type: 'ASK', requestId: `ask-${Date.now()}-${cell}`, request: ask });
}

// ── the figures to pick, and the channels to cut ────────────────────────────

const palette = document.querySelector('#palette') as HTMLElement;
for (const figure of FIGURES) {
  const button = document.createElement('button');
  button.className = 'pick';
  button.innerHTML = figureSvg(figure);
  button.addEventListener('click', () => {
    selected = figure;
    for (const other of palette.querySelectorAll('.pick')) other.classList.remove('picked');
    button.classList.add('picked');
    say(`picked the ${figure.colour} ${figure.shape}`);
  });
  palette.append(button);
}
palette.querySelector('.pick')?.classList.add('picked');

/** A cuttable link: the demo's four channels. */
function cutSwitch(name: string, gate: Gate<ShapesRecord>): void {
  const button = document.createElement('button');
  button.className = 'cut';
  button.textContent = `${name}: carrying`;
  button.addEventListener('click', () => {
    if (gate.cutNow) {
      gate.heal();
      button.textContent = `${name}: carrying`;
      button.classList.remove('cut-now');
      say(`${name} healed`);
      return;
    }
    gate.cut();
    button.textContent = `${name}: cut`;
    button.classList.add('cut-now');
    say(`${name} cut`);
  });
  cuts.append(button);
}

cutSwitch('A→B', gateAB);
cutSwitch('B→C', gateBC);

for (const proc of procs) {
  proc.send({ type: 'ATTACH' });
}

paint(panels[0]?.grid ?? [], authority.state?.state ?? null);
paint(panels[1]?.grid ?? [], b.state?.state ?? null);
paint(panels[2]?.grid ?? [], c.state?.state ?? null);
say('three boards: A owns the log, B follows it, C follows B and guesses');
