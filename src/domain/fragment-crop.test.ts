import { describe, expect, it } from 'vitest';

import { SYMBOL_IDS } from '../symbols';
import { CellKind, cropPatternFragment, createDocument, createPatternFragment, createPatternFragmentFromCells, DomainError } from './index';

const source = () => {
  const document = createDocument({ width: 4, height: 3, catalog: { catalogId: 'dmc', brandLabel: 'DMC', colorCount: 8 }, palette: [{ name: 'A', color: '#111111', symbol: SYMBOL_IDS[0] }] });
  for (let index = 0; index < 12; index += 1) {
    document.kind[index] = CellKind.Full;
    document.colors[index * 4] = 1;
  }
  // Inside column 1..2 / row 0..1, straddling the left edge, and a segment on the crop boundary.
  const x1 = [4, 0, 4, 12];
  const y1 = [4, 0, 0, 0];
  const x2 = [8, 4, 4, 16];
  const y2 = [4, 0, 8, 0];
  document.backstitches = { ids: Uint32Array.from([1, 2, 3, 4]), x1: Uint32Array.from(x1), y1: Uint32Array.from(y1), x2: Uint32Array.from(x2), y2: Uint32Array.from(y2), colors: Uint16Array.of(1, 1, 1, 1), completed: new Uint8Array(4) };
  document.nextBackstitchId = 5;
  return document;
};

describe('cropPatternFragment', () => {
  it('keeps the rect cells rebased and drops backstitches that leave the rect', () => {
    const fragment = createPatternFragment(source(), { x: 0, y: 0, width: 4, height: 3 });
    const cropped = cropPatternFragment(fragment, { x: 1, y: 0, width: 2, height: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect([...cropped.kind]).toEqual([1, 1, 1, 1]);
    // (4,4)-(8,4) and (4,0)-(4,8) are inside; (0,0)-(4,0) straddles the left edge; (12,0)-(16,0) is outside.
    expect([...cropped.backstitches.x1].sort()).toEqual([0, 0]);
    expect(cropped.backstitches.x1).toHaveLength(2);
    expect([...cropped.backstitches.y2].sort((a, b) => a - b)).toEqual([4, 8]);
  });

  it('keeps a full-size crop identical and does not alias the input', () => {
    const fragment = createPatternFragment(source(), { x: 0, y: 0, width: 4, height: 3 });
    const cropped = cropPatternFragment(fragment, { x: 0, y: 0, width: 4, height: 3 });
    expect(cropped.kind).toEqual(fragment.kind);
    expect(cropped.colors).toEqual(fragment.colors);
    expect(cropped.backstitches.x1).toHaveLength(4);
    cropped.kind[0] = 0;
    expect(fragment.kind[0]).toBe(CellKind.Full);
  });

  it('crops a sparse fragment, keeping its empty cells empty', () => {
    const fragment = createPatternFragmentFromCells(source(), Uint32Array.of(0, 5, 10));
    expect(fragment.width).toBe(3);
    const cropped = cropPatternFragment(fragment, { x: 1, y: 0, width: 2, height: 3 });
    expect([...cropped.kind]).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it('rejects an empty or out-of-fragment rect', () => {
    const fragment = createPatternFragment(source(), { x: 0, y: 0, width: 2, height: 2 });
    expect(() => cropPatternFragment(fragment, { x: 0, y: 0, width: 0, height: 1 })).toThrow(DomainError);
    expect(() => cropPatternFragment(fragment, { x: 1, y: 0, width: 2, height: 1 })).toThrow(DomainError);
  });
});
