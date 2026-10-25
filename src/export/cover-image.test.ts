import { describe, expect, it, vi } from 'vitest';
import { CellKind, createDocument, HalfDirection, type PatternDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import type { CanvasContextAdapter } from '../editor/contracts';
import { coverCellPx, paintCover, renderCoverPng, type CoverCanvas, type CoverImageInput } from './cover-image';
import { applyCommand } from '../domain/test-fixtures';

interface Call { readonly op: string; readonly args: readonly unknown[] }

function recorder(): { context: CanvasContextAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const record = (op: string) => (...args: unknown[]): void => { calls.push({ op, args }); };
  const context = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
    clearRect: record('clearRect'), fillRect: record('fillRect'), beginPath: record('beginPath'), closePath: record('closePath'),
    moveTo: record('moveTo'), lineTo: record('lineTo'), fill: record('fill'), stroke: record('stroke')
  } as unknown as CanvasContextAdapter;
  return { context, calls };
}

function patternOf(width: number, height: number, fill: (apply: (c: Parameters<typeof applyCommand>[1]) => void) => void = () => undefined): PatternDocument {
  let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width, height, palette: [{ name: 'Red', color: '#d33' }, { name: 'Blue', color: '#36c' }] });
  fill((command) => { pattern = applyCommand(pattern, command).document; });
  return pattern;
}

const inputOf = (document: PatternDocument, patch: Partial<CoverImageInput> = {}): CoverImageInput => ({ document, backgroundColor: '#fafafa', ...patch });

describe('coverCellPx', () => {
  it('clamps to 1..16 and fits the max side', () => {
    expect(coverCellPx(10, 10)).toBe(16);
    expect(coverCellPx(100, 80)).toBe(12);
    expect(coverCellPx(5000, 10)).toBe(1);
    expect(coverCellPx(100, 100, 400)).toBe(4);
    expect(coverCellPx(10, 10, Number.NaN)).toBe(16);
  });
});

describe('paintCover', () => {
  it('draws the fabric and, for an empty pattern, nothing else', async () => {
    const { context, calls } = recorder();
    await paintCover(context, inputOf(patternOf(3, 2)), 8);
    expect(calls.filter((call) => call.op === 'fillRect')).toEqual([{ op: 'fillRect', args: [0, 0, 24, 16] }]);
    expect(calls.some((call) => call.op === 'moveTo' && call.args[0] === 0)).toBe(true);
  });

  it('paints thread strokes in detail and flat polygons below the detail size', async () => {
    const document = patternOf(2, 1, (apply) => { apply({ type: 'set-full', x: 0, y: 0, color: 1 }); apply({ type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 2 }); });
    const detail = recorder();
    await paintCover(detail.context, inputOf(document), 8);
    // Full cross: two strands of three strokes each, plus one half strand of three.
    expect(detail.calls.filter((call) => call.op === 'stroke').length).toBeGreaterThanOrEqual(9);
    const flat = recorder();
    await paintCover(flat.context, inputOf(document), 2);
    expect(flat.calls.filter((call) => call.op === 'stroke')).toHaveLength(0);
    expect(flat.calls.filter((call) => call.op === 'fillRect').length).toBe(2);
    expect(flat.calls.filter((call) => call.op === 'fill').length).toBe(1);
  });

  it('splits a three-quarter pair into its two components', async () => {
    const document = patternOf(1, 1);
    document.kind[0] = CellKind.ThreeQuarterPair;
    document.colors[0] = 1;
    document.colors[2] = 2;
    const { context, calls } = recorder();
    await paintCover(context, inputOf(document), 2);
    expect(calls.filter((call) => call.op === 'fill')).toHaveLength(2);
  });

  it('skips masked-off cells and draws backstitch', async () => {
    const document = patternOf(2, 1, (apply) => {
      apply({ type: 'set-full', x: 0, y: 0, color: 1 });
      apply({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 8, y: 4 }, color: 2 });
    });
    const masked = { ...document, canvasMask: Uint8Array.from([0, 1]) };
    const { context, calls } = recorder();
    await paintCover(context, inputOf(masked), 2);
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(1);
    expect(calls.filter((call) => call.op === 'stroke')).toHaveLength(3);
  });

  it('places a backstitch from fixed-point store units in cell pixels', async () => {
    // Cell (2,3) to (3,3) is stored as (8,12)->(12,12).
    const document = patternOf(10, 10, (apply) => {
      apply({ type: 'add-backstitch', start: { x: 8, y: 12 }, end: { x: 12, y: 12 }, color: 2 });
    });
    const { context, calls } = recorder();
    await paintCover(context, inputOf(document), 8);
    // The last three strokes are edge, body and highlight; the edge strand is unshifted.
    const tail = calls.slice(-12);
    expect(tail[1]).toEqual({ op: 'moveTo', args: [16, 24] });
    expect(tail[2]).toEqual({ op: 'lineTo', args: [24, 24] });
  });

  it('rejects with an AbortError when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(paintCover(recorder().context, inputOf(patternOf(2, 2)), 4, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('renderCoverPng', () => {
  it('returns undefined without a canvas', async () => {
    await expect(renderCoverPng(inputOf(patternOf(2, 2)), { createCanvas: () => undefined })).resolves.toBeUndefined();
    // jsdom has no 2D context; the default factory must degrade quietly.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(renderCoverPng(inputOf(patternOf(2, 2)))).resolves.toBeUndefined();
    getContext.mockRestore();
  });

  it('sizes the canvas from the cell size and returns the encoded bytes', async () => {
    const sizes: Array<[number, number]> = [];
    const png = new Uint8Array([137, 80, 78, 71]);
    const createCanvas = (width: number, height: number): CoverCanvas => {
      sizes.push([width, height]);
      return { context: recorder().context, toPng: () => Promise.resolve(png) };
    };
    await expect(renderCoverPng(inputOf(patternOf(100, 80)), { createCanvas })).resolves.toBe(png);
    expect(sizes).toEqual([[1200, 960]]);
    await renderCoverPng(inputOf(patternOf(10, 5), { maxSidePx: 30 }), { createCanvas });
    expect(sizes[1]).toEqual([30, 15]);
  });

  it('rejects when aborted before and propagates draw errors', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderCoverPng(inputOf(patternOf(2, 2)), { signal: controller.signal, createCanvas: () => undefined })).rejects.toMatchObject({ name: 'AbortError' });
    const failing = { ...recorder().context, fillRect: () => { throw new Error('draw failed'); } } as unknown as CanvasContextAdapter;
    await expect(renderCoverPng(inputOf(patternOf(2, 2)), { createCanvas: () => ({ context: failing, toPng: () => Promise.resolve(new Uint8Array()) }) })).rejects.toThrow('draw failed');
  });
});
