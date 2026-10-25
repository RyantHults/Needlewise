import { describe, expect, it } from 'vitest';
import { CellKind } from '../domain';
import type { CanvasContextAdapter, CanvasTarget } from '../editor/contracts';
import { ThreeQuarterNE, ThreeQuarterNW, ThreeQuarterPair } from '../editor/cell-kinds';
import {
  createThreadSpriteCache,
  drawThreadBackstitch,
  drawThreadFabric,
  drawThreadFlat,
  drawThreadStitch,
  THREAD_BACKSTITCH_WIDTH,
  THREAD_STITCH_WIDTH,
  threadEdgeColor,
  threadHighlightColor
} from './thread-preview';

interface StrokeRecord {
  from: [number, number];
  to: [number, number];
  strokeStyle: string;
  lineWidth: number;
  lineCap: string | undefined;
}

interface RecordingContext extends CanvasContextAdapter {
  strokes: StrokeRecord[];
  calls: string[];
  images: unknown[][];
}

function recordingContext(): RecordingContext {
  let from: [number, number] = [0, 0];
  let to: [number, number] = [0, 0];
  const context: RecordingContext = {
    strokes: [],
    calls: [],
    images: [],
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    font: '',
    clearRect(): void {},
    fillRect(): void { context.calls.push('fillRect'); },
    beginPath(): void {},
    moveTo(x: number, y: number): void { from = [x, y]; },
    lineTo(x: number, y: number): void { to = [x, y]; },
    fill(): void { context.calls.push('fill'); },
    stroke(): void {
      context.calls.push('stroke');
      context.strokes.push({
        from: [...from] as [number, number],
        to: [...to] as [number, number],
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
        lineCap: context.lineCap
      });
    },
    drawImage(...args: unknown[]): void { context.images.push(args); }
  };
  return context;
}

const rect = (size: number) => ({ x: 0, y: 0, width: size, height: size });

/** Strokes grouped by strand: edge, body, highlight come in threes. */
function bodies(context: RecordingContext): StrokeRecord[] {
  return context.strokes.filter((_, index) => index % 3 === 1);
}

describe('drawThreadStitch', () => {
  it('draws a full cross as two strands with the slash over the backslash', () => {
    const context = recordingContext();
    drawThreadStitch(context, CellKind.Full, rect(20), '#3366cc');

    expect(context.strokes).toHaveLength(6);
    const [back, slash] = bodies(context);
    // Backslash runs top-left to bottom-right, slash top-right to bottom-left.
    expect(back.from[0]).toBeLessThan(back.to[0]);
    expect(back.from[1]).toBeLessThan(back.to[1]);
    expect(slash.from[0]).toBeGreaterThan(slash.to[0]);
    expect(slash.from[1]).toBeLessThan(slash.to[1]);
  });

  it('layers each strand as edge, body, highlight', () => {
    const context = recordingContext();
    drawThreadStitch(context, CellKind.HalfSlash, rect(20), '#3366cc');

    expect(context.strokes.map((stroke) => stroke.strokeStyle)).toEqual([
      threadEdgeColor('#3366cc'),
      '#3366cc',
      threadHighlightColor('#3366cc')
    ]);
    const [edge, body, highlight] = context.strokes;
    expect(edge.lineWidth).toBeGreaterThan(body.lineWidth);
    expect(highlight.lineWidth).toBeLessThan(body.lineWidth);
  });

  it('draws one strand for each half and a strand plus a short stroke for a three-quarter', () => {
    const half = recordingContext();
    drawThreadStitch(half, CellKind.HalfBackslash, rect(20), '#000000');
    expect(half.strokes).toHaveLength(3);

    const threeQuarter = recordingContext();
    drawThreadStitch(threeQuarter, ThreeQuarterNW, rect(20), '#000000');
    expect(threeQuarter.strokes).toHaveLength(6);
    const [short, hypotenuse] = bodies(threeQuarter);
    expect(Math.hypot(short.to[0] - short.from[0], short.to[1] - short.from[1]))
      .toBeLessThan(Math.hypot(hypotenuse.to[0] - hypotenuse.from[0], hypotenuse.to[1] - hypotenuse.from[1]));
    // The short stroke of a NW three-quarter reaches the cell center from the NW corner.
    expect(short.to).toEqual([10, 10]);
    expect(short.from[0]).toBeLessThan(10);
    expect(short.from[1]).toBeLessThan(10);
  });

  it('puts the NE three-quarter short stroke in the NE corner, drawn over the hypotenuse', () => {
    const context = recordingContext();
    drawThreadStitch(context, ThreeQuarterNE, rect(20), '#000000');
    const [hypotenuse, short] = bodies(context);
    expect(hypotenuse.from[0]).toBeLessThan(hypotenuse.to[0]);
    expect(short.from[0]).toBeGreaterThan(10);
    expect(short.from[1]).toBeLessThan(10);
    expect(short.to).toEqual([10, 10]);
  });

  it('draws a legacy quarter as one corner stroke chosen by slot', () => {
    const context = recordingContext();
    drawThreadStitch(context, CellKind.Quarters, rect(20), '#000000', 2);
    expect(bodies(context)).toHaveLength(1);
    expect(bodies(context)[0].from[0]).toBeGreaterThan(10);
    expect(bodies(context)[0].from[1]).toBeGreaterThan(10);
  });

  it('paints nothing for empty cells and for a pair kind', () => {
    const context = recordingContext();
    drawThreadStitch(context, CellKind.Empty, rect(20), '#000000');
    drawThreadStitch(context, ThreeQuarterPair, rect(20), '#000000');
    expect(context.strokes).toHaveLength(0);
  });

  it('uses round caps and scales widths with the cell size', () => {
    const small = recordingContext();
    const large = recordingContext();
    drawThreadStitch(small, CellKind.Full, rect(10), '#3366cc');
    drawThreadStitch(large, CellKind.Full, rect(40), '#3366cc');

    expect(small.strokes.every((stroke) => stroke.lineCap === 'round')).toBe(true);
    expect(bodies(small)[0].lineWidth).toBeCloseTo(10 * THREAD_STITCH_WIDTH);
    expect(bodies(large)[0].lineWidth).toBeCloseTo(40 * THREAD_STITCH_WIDTH);
  });

  it('offsets strokes by the rect position', () => {
    const context = recordingContext();
    drawThreadStitch(context, CellKind.HalfBackslash, { x: 100, y: 50, width: 20, height: 20 }, '#000000');
    expect(bodies(context)[0].from[0]).toBeGreaterThan(100);
    expect(bodies(context)[0].from[1]).toBeGreaterThan(50);
  });

  it('keeps every stroke and its cap inside the cell', () => {
    const context = recordingContext();
    drawThreadStitch(context, CellKind.Full, rect(20), '#3366cc');
    for (const stroke of context.strokes) {
      const radius = stroke.lineWidth / 2;
      for (const [x, y] of [stroke.from, stroke.to]) {
        // The highlight is shifted up-left by a fraction of the cell, within its own narrower cap.
        expect(x - radius).toBeGreaterThanOrEqual(-1);
        expect(y - radius).toBeGreaterThanOrEqual(-1);
        expect(x + radius).toBeLessThanOrEqual(20 + 1e-6);
        expect(y + radius).toBeLessThanOrEqual(20 + 1e-6);
      }
    }
  });

  it('restores the caller stroke state', () => {
    const context = recordingContext();
    context.strokeStyle = '#ff0000';
    context.lineWidth = 7;
    context.lineCap = 'square';
    drawThreadStitch(context, CellKind.Full, rect(20), '#3366cc');
    expect(context.strokeStyle).toBe('#ff0000');
    expect(context.lineWidth).toBe(7);
    expect(context.lineCap).toBe('square');
  });

  it('derives a darker edge and a lighter highlight', () => {
    expect(threadEdgeColor('#808080')).toBe('#535353');
    expect(threadHighlightColor('#808080')).toBe('#b3b3b3');
    expect(threadEdgeColor('not-a-color')).toBe('not-a-color');
  });

});

describe('drawThreadBackstitch', () => {
  it('draws one round-capped strand between the two cell-coordinate points', () => {
    const context = recordingContext();
    drawThreadBackstitch(context, { x: 1, y: 2 }, { x: 3, y: 2 }, 10, '#cc3333', { x: 5, y: 7 });

    expect(context.strokes).toHaveLength(3);
    const body = bodies(context)[0];
    expect(body.from).toEqual([15, 27]);
    expect(body.to).toEqual([35, 27]);
    expect(body.lineWidth).toBeCloseTo(10 * THREAD_BACKSTITCH_WIDTH);
    expect(body.lineCap).toBe('round');
    expect(THREAD_BACKSTITCH_WIDTH).toBeLessThan(THREAD_STITCH_WIDTH);
  });
});

describe('drawThreadFlat', () => {
  it('fills the stitch geometry with the thread color and never strokes', () => {
    const context = recordingContext();
    drawThreadFlat(context, CellKind.Full, rect(3), '#3366cc');
    expect(context.fillStyle).toBe('#3366cc');
    expect(context.calls).toEqual(['fillRect']);
    expect(context.strokes).toHaveLength(0);
  });

});

describe('drawThreadFabric', () => {
  it('fills the background and strokes the weave', () => {
    const context = recordingContext();
    drawThreadFabric(context, { x: 0, y: 0, width: 40, height: 40 }, 10, '#f4efe0');
    expect(context.fillStyle).toBe('#f4efe0');
    expect(context.calls).toContain('fillRect');
    expect(context.calls).toContain('stroke');
  });

  it('skips the weave below the detail threshold', () => {
    const context = recordingContext();
    drawThreadFabric(context, { x: 0, y: 0, width: 20, height: 20 }, 2, '#f4efe0');
    expect(context.calls).toEqual(['fillRect']);
  });
});

describe('createThreadSpriteCache', () => {
  function factory() {
    const created: RecordingContext[] = [];
    const sizes: number[][] = [];
    const targetFactory = (width: number, height: number): CanvasTarget => {
      const context = recordingContext();
      created.push(context);
      sizes.push([width, height]);
      return { context, width, height, source: { width, height, getContext: () => context } };
    };
    return { created, sizes, targetFactory };
  }

  it('paints a sprite once per (color, kind) and reuses it', () => {
    const { created, targetFactory } = factory();
    const cache = createThreadSpriteCache(targetFactory, 16);

    const first = cache.get('#3366cc', CellKind.Full);
    const again = cache.get('#3366cc', CellKind.Full);
    expect(again).toBe(first);
    expect(created).toHaveLength(1);

    cache.get('#3366cc', CellKind.HalfSlash);
    cache.get('#cc3333', CellKind.Full);
    expect(created).toHaveLength(3);
    expect(cache.size).toBe(3);
  });

  it('allocates sprites at the cell pixel size', () => {
    const { sizes, targetFactory } = factory();
    const cache = createThreadSpriteCache(targetFactory, 16.4);
    cache.get('#000000', CellKind.Full);
    expect(sizes).toEqual([[16, 16]]);
    expect(cache.cellPx).toBe(16);
  });

  it('blits a sprite with drawImage', () => {
    const { targetFactory } = factory();
    const cache = createThreadSpriteCache(targetFactory, 16);
    const context = recordingContext();
    const drawn = cache.draw(context, '#3366cc', CellKind.Full, { x: 32, y: 48, width: 16, height: 16 });
    expect(drawn).toBe(true);
    expect(context.images).toHaveLength(1);
    expect(context.images[0].slice(1)).toEqual([32, 48, 16, 16]);
    expect(context.strokes).toHaveLength(0);
  });

  it('reports no sprite when the target cannot be allocated', () => {
    const cache = createThreadSpriteCache(() => undefined, 16);
    const context = recordingContext();
    expect(cache.get('#000000', CellKind.Full)).toBeUndefined();
    expect(cache.draw(context, '#000000', CellKind.Full, rect(16))).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('survives a throwing target factory', () => {
    const cache = createThreadSpriteCache(() => { throw new Error('no canvas'); }, 16);
    expect(cache.get('#000000', CellKind.Full)).toBeUndefined();
  });

  it('clears and bounds its entries', () => {
    const { targetFactory } = factory();
    const cache = createThreadSpriteCache(targetFactory, 8, 2);
    cache.get('#000001', CellKind.Full);
    cache.get('#000002', CellKind.Full);
    cache.get('#000003', CellKind.Full);
    expect(cache.size).toBeLessThanOrEqual(2);
    cache.clear();
    expect(cache.size).toBe(0);
    cache.get('#000003', CellKind.Full);
    expect(cache.size).toBe(1);
  });
});
