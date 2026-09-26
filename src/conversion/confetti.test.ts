import { describe, expect, it } from 'vitest';
import { CellKind, createDocument, type PatternDocument } from '../domain';
import { isConfettiDistance, MAX_CONFETTI_DISTANCE, reduceConfetti, reduceConfettiSteps } from './confetti';

type Rgb = readonly [number, number, number];

const association = { catalogId: 'confetti-catalog', brandLabel: 'Confetti', colorCount: 4 };

/** Palette id → RGB; ids 1..4 are red, near-red, blue and green. */
const COLORS = new Map<number, Rgb>([[1, [255, 0, 0]], [2, [200, 0, 0]], [3, [0, 0, 255]], [4, [0, 255, 0]]]);
const colorOf = (paletteId: number): Rgb | undefined => COLORS.get(paletteId);

/** Rows of palette ids; `.` is an empty cell. */
function grid(rows: readonly string[]): PatternDocument {
  const document = createDocument({
    width: rows[0].length,
    height: rows.length,
    catalog: association,
    palette: [...COLORS].map(([id, rgb]) => ({ id, name: `Color ${String(id)}`, color: `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}` }))
  });
  rows.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === '.') return;
    document.kind[y * document.width + x] = CellKind.Full;
    document.colors[(y * document.width + x) * 4] = Number(cell);
  }));
  return document;
}

function rows(document: PatternDocument): string[] {
  const result: string[] = [];
  for (let y = 0; y < document.height; y += 1) {
    let row = '';
    for (let x = 0; x < document.width; x += 1) {
      const index = y * document.width + x;
      row += document.kind[index] === CellKind.Empty ? '.' : String(document.colors[index * 4]);
    }
    result.push(row);
  }
  return result;
}

function usageOf(document: PatternDocument): Map<number, number> {
  const usage = new Map<number, number>();
  for (let index = 0; index < document.width * document.height; index += 1) {
    if (document.kind[index] !== CellKind.Empty) usage.set(document.colors[index * 4], (usage.get(document.colors[index * 4]) ?? 0) + 1);
  }
  return usage;
}

function reduce(document: PatternDocument, distance: number): { cleared: number; usage: Map<number, number> } {
  const usage = usageOf(document);
  const cleared = reduceConfetti(document, distance, colorOf, usage);
  return { cleared, usage };
}

describe('confetti reduction', () => {
  it('replaces an isolated stitch with its majority neighbour', () => {
    const document = grid(['111', '131', '111']);
    const { cleared, usage } = reduce(document, 1);
    expect(rows(document)).toEqual(['111', '111', '111']);
    expect(cleared).toBe(0);
    expect(usage.get(1)).toBe(9);
    expect(usage.get(3)).toBe(0);
  });

  it('leaves adjacent same-color stitches untouched at distance 1', () => {
    const document = grid(['111111', '113311', '111111']);
    reduce(document, 1);
    expect(rows(document)).toEqual(['111111', '113311', '111111']);
  });

  it('affects more stitches at lower distances', () => {
    // The two blue stitches are exactly two cells apart.
    const nearest = ['11111', '13131', '11111'];
    const low = grid(nearest);
    reduce(low, 1);
    expect(rows(low)).toEqual(['11111', '11111', '11111']);
    const high = grid(nearest);
    reduce(high, 2);
    expect(rows(high)).toEqual(nearest);
  });

  it('breaks mode ties toward the closest non-empty color', () => {
    // A green (4) centre with four red (1) and four near-red (2) neighbours:
    // near-red is closer to green, so it wins regardless of id or position.
    const document = grid(['111', '241', '222']);
    reduce(document, 1);
    expect(document.colors[4 * 4]).toBe(2);
    const swapped = grid(['222', '142', '111']);
    reduce(swapped, 1);
    expect(swapped.colors[4 * 4]).toBe(2);
  });

  it('lets empty lose ties against any color', () => {
    const document = grid(['333', '.13', '...']);
    const { cleared } = reduce(document, 1);
    expect(rows(document)[1]).toBe('.33');
    expect(cleared).toBe(0);
  });

  it('clears a lone stitch surrounded by empty cells', () => {
    const document = grid(['...', '.1.', '...']);
    const { cleared, usage } = reduce(document, 1);
    expect(rows(document)).toEqual(['...', '...', '...']);
    expect(document.kind[4]).toBe(CellKind.Empty);
    expect(document.colors[4 * 4]).toBe(0);
    expect(cleared).toBe(1);
    expect(usage.get(1)).toBe(0);
  });

  it('evaluates every cell against the pre-pass snapshot without cascading', () => {
    // In-place evaluation would turn the first cell blue and then keep the
    // blue stitch (it would gain a blue neighbour); the snapshot swaps both.
    const document = grid(['1311']);
    reduce(document, 1);
    expect(rows(document)).toEqual(['3111']);
  });

  it('keeps a stitch with no in-bounds neighbours', () => {
    const document = grid(['1']);
    expect(reduce(document, 1).cleared).toBe(0);
    expect(rows(document)).toEqual(['1']);
  });

  it('yields between chunks and matches the synchronous result', () => {
    const pattern = ['1131..', '3311.4', '..1113', '4.3311'];
    const synchronous = grid(pattern);
    const syncUsage = usageOf(synchronous);
    const syncCleared = reduceConfetti(synchronous, 1, colorOf, syncUsage);
    const stepped = grid(pattern);
    const steppedUsage = usageOf(stepped);
    const steps = reduceConfettiSteps(stepped, 1, colorOf, steppedUsage, 5);
    let yields = 0;
    let step = steps.next();
    while (step.done !== true) {
      yields += 1;
      step = steps.next();
    }
    expect(yields).toBe(8);
    expect(step.value).toBe(syncCleared);
    expect(rows(stepped)).toEqual(rows(synchronous));
    expect(steppedUsage).toEqual(syncUsage);
  });

  it('accepts only integer distances within the supported range', () => {
    expect(MAX_CONFETTI_DISTANCE).toBe(5);
    expect([1, 3, MAX_CONFETTI_DISTANCE].every(isConfettiDistance)).toBe(true);
    expect([0, 6, 1.5, Number.NaN, '1', undefined].some(isConfettiDistance)).toBe(false);
  });
});
