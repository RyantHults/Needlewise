import { describe, expect, it } from 'vitest';
import type { CanvasContextAdapter, RendererStyle } from '../editor/contracts';
import { ChartPresentationMode, DEFAULT_RENDERER_STYLE } from '../editor/contracts';
import { CellKind, type PatternDocument } from '../domain';
import { getSymbolOutline, SYMBOL_IDS, SYMBOL_POOL } from '../symbols';
import { drawPaletteSymbol, drawSymbolOutline } from './symbol-painter';

interface ContextRecord {
  name: string;
  args: unknown[];
  fillStyle: string;
}

interface RecordingContext extends CanvasContextAdapter {
  records: ContextRecord[];
  record(name: string, args: unknown[]): void;
}

function recordingContext(): RecordingContext {
  const context: RecordingContext = {
    records: [],
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    clearRect: function (): void {},
    fillRect: function (): void {},
    beginPath: function (): void {},
    moveTo: function (): void {},
    lineTo: function (): void {},
    record: function (this: RecordingContext, name: string, args: unknown[]): void {
      this.records.push({
        name,
        args,
        fillStyle: this.fillStyle
      });
    },
    fill: function (this: RecordingContext, ...args: unknown[]): void { this.record('fill', args); },
    stroke: function (this: RecordingContext, ...args: unknown[]): void { this.record('stroke', args); },
    save: function (this: RecordingContext, ...args: unknown[]): void { this.record('save', args); },
    restore: function (this: RecordingContext, ...args: unknown[]): void { this.record('restore', args); },
    translate: function (this: RecordingContext, ...args: unknown[]): void { this.record('translate', args); },
    scale: function (this: RecordingContext, ...args: unknown[]): void { this.record('scale', args); },
    setTransform: function (this: RecordingContext, ...args: unknown[]): void { this.record('setTransform', args); }
  };
  return context;
}

function named(context: RecordingContext, name: string): ContextRecord | undefined {
  return context.records.find((entry) => entry.name === name);
}

describe('drawSymbolOutline', () => {
  it('fills the outline path', () => {
    const context = recordingContext();

    drawSymbolOutline(context, { d: 'M0 0L1 0L1 1Z' }, { x: 0, y: 0 }, 8, '#123456');

    const painted = named(context, 'fill');
    expect(painted).toBeDefined();
    expect((painted?.args[0] as { d: string }).d).toBe('M0 0L1 0L1 1Z');
  });

  it('never strokes the outline', () => {
    const context = recordingContext();

    drawSymbolOutline(context, { d: 'M0 0L1 0L1 1Z' }, { x: 0, y: 0 }, 8, '#123456');

    // A glyph contour is already the solid silhouette of the mark. Stroking it
    // traces a border around an already-filled shape, which doubles the weight
    // of every stem and closes the counters of marks like `o` and `8`.
    expect(named(context, 'stroke')).toBeUndefined();
  });

  it('paints the symbol in the requested ink', () => {
    const context = recordingContext();

    drawSymbolOutline(context, { d: 'M-0.5 0L0.5 0' }, { x: 0, y: 0 }, 8, '#2266cc');

    expect(named(context, 'fill')?.fillStyle).toBe('#2266cc');
  });

  it('brackets painting with save and restore so symbol state cannot leak', () => {
    const context = recordingContext();

    drawSymbolOutline(context, { d: 'M-0.5 0L0.5 0' }, { x: 10, y: 20 }, 8, '#2266cc');

    // A leaked translate/scale/fillStyle would misplace or recolor every
    // subsequent cell drawn on the same context.
    expect(context.records[0]?.name).toBe('save');
    expect(context.records[context.records.length - 1]?.name).toBe('restore');
    expect(context.records.filter((entry) => entry.name === 'restore')).toHaveLength(1);
  });

  it('composes with the existing matrix instead of replacing it', () => {
    const context = recordingContext();

    drawSymbolOutline(context, { d: 'M-0.5 0L0.5 0' }, { x: 0, y: 0 }, 8, '#000');

    // prepareTarget installs the device-pixel-ratio matrix with setTransform;
    // calling it here would rescale the entire canvas.
    expect(named(context, 'setTransform')).toBeUndefined();
  });

  it('restores the context even when the canvas rejects the paint', () => {
    const context = recordingContext();
    context.fill = function (this: RecordingContext, ...args: unknown[]): void {
      this.record('fill', args);
      throw new Error('canvas rejected fill');
    };

    expect(() =>
      drawSymbolOutline(context, { d: 'M-0.5 0L0.5 0' }, { x: 0, y: 0 }, 8, '#000')
    ).toThrow('canvas rejected fill');
    expect(context.records.filter((entry) => entry.name === 'restore')).toHaveLength(1);
  });
});

/**
 * `drawPaletteSymbol` is where a document's own symbol choice becomes geometry,
 * so these assert the mapping decisions rather than the transform maths that
 * `drawSymbolOutline` already covers.
 */
describe('drawPaletteSymbol', () => {
  const rect = { x: 10, y: 20, width: 16, height: 16 };
  const style = (overrides: Partial<RendererStyle> = {}): RendererStyle => ({
    ...DEFAULT_RENDERER_STYLE,
    ...overrides
  });
  const documentWith = (symbol: string | undefined, id = 1): PatternDocument => ({
    palette: [{ id, name: 'Red', color: '#d33', ...(symbol === undefined ? {} : { symbol }) }]
  } as unknown as PatternDocument);
  const painted = (context: RecordingContext): string[] => [
    ...new Set(
      context.records
        .filter((entry) => entry.name === 'fill')
        .map((entry) => (entry.args[0] as { d: string } | undefined)?.d)
        .filter((d): d is string => typeof d === 'string')
    )
  ];

  it('paints the outline the palette entry names', () => {
    const context = recordingContext();
    const [id] = SYMBOL_IDS;
    const outline = getSymbolOutline(id);

    drawPaletteSymbol(context, documentWith(id), 1, rect, style({ mode: ChartPresentationMode.Symbol }), CellKind.Full);

    expect(painted(context)).toEqual([outline?.d]);
  });

  it('falls back to the domain default when the entry names no symbol', () => {
    const context = recordingContext();
    const entry = SYMBOL_POOL[0];

    drawPaletteSymbol(context, documentWith(undefined), 1, rect, style({ mode: ChartPresentationMode.Symbol }), CellKind.Full);

    expect(painted(context)).toEqual([entry.d]);
  });

  it('paints nothing for a slug the pool does not own', () => {
    const context = recordingContext();

    drawPaletteSymbol(context, documentWith('not-a-symbol'), 1, rect, style({ mode: ChartPresentationMode.Symbol }), CellKind.Full);

    expect(painted(context)).toEqual([]);
  });

  it('paints nothing when symbols are hidden or the mode shows color alone', () => {
    for (const overrides of [
      { showSymbols: false },
      { mode: ChartPresentationMode.Color },
      { mode: ChartPresentationMode.Grayscale }
    ]) {
      const context = recordingContext();
      drawPaletteSymbol(context, documentWith(SYMBOL_IDS[0]), 1, rect, style(overrides as Partial<RendererStyle>), CellKind.Full);
      expect(painted(context), JSON.stringify(overrides)).toEqual([]);
    }
  });

  it('fits the symbol to the largest square inside the stitch shape', () => {
    const fit = (kind: number, slot?: number): RecordingContext => {
      const context = recordingContext();
      drawPaletteSymbol(context, documentWith(SYMBOL_IDS[0]), 1, rect, style({ mode: ChartPresentationMode.Symbol }), kind, slot);
      return context;
    };

    const full = fit(CellKind.Full);
    expect(named(full, 'translate')?.args).toEqual([18, 28]);
    expect(named(full, 'scale')?.args).toEqual([16, 16]);

    // A three-quarter triangle holds a half-cell square centred 0.25 in from its right angle.
    const threeQuarter = fit(CellKind.ThreeQuarterNE);
    expect(named(threeQuarter, 'translate')?.args).toEqual([22, 24]);
    expect(named(threeQuarter, 'scale')?.args).toEqual([8, 8]);

    const half = fit(CellKind.HalfSlash);
    expect(named(half, 'translate')?.args).toEqual([18, 28]);
    expect((named(half, 'scale')?.args[0] as number)).toBeCloseTo(16 * (1 - Math.SQRT1_2));
  });

  it('places the symbol in the right-angle corner of a legacy quarter slot', () => {
    const context = recordingContext();

    drawPaletteSymbol(context, documentWith(SYMBOL_IDS[0]), 1, rect, style({ mode: ChartPresentationMode.Symbol }), CellKind.Quarters, 1);

    expect(named(context, 'translate')?.args).toEqual([24, 26]);
    expect(named(context, 'scale')?.args).toEqual([4, 4]);
  });

  it('does not throw when the canvas rejects the outline', () => {
    const context = recordingContext();
    context.fill = function (): void {
      throw new Error('canvas rejected fill');
    };

    expect(() =>
      drawPaletteSymbol(context, documentWith(SYMBOL_IDS[0]), 1, rect, style({ mode: ChartPresentationMode.Symbol }), CellKind.Full)
    ).not.toThrow();
  });

});
