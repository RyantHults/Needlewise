import { describe, expect, it } from 'vitest';
import { CellKind, createDocument, createPatternFragment } from '../domain';
import { cellToScreenRect, fitViewport, getCanvasMetrics, visibleCellRect } from '../editor/coordinates';
import type { CanvasContextAdapter, CanvasTarget, PendingCellState, TraceImage } from '../editor/contracts';
import { ThreeQuarterPair } from '../editor/cell-kinds';
import { MAX_ATLAS_PIXELS, createDefaultAtlasTarget } from './context';
import { isCanvasImageSource } from './atlas';
import { createCanvasRenderer } from './renderer';
import { symbolForPaletteId } from './symbols';
import { sparseSelectionGeometry } from '../editor/lasso';

interface RecordingContext extends CanvasContextAdapter {
  calls: string[];
  records: Array<{
    name: string;
    args: unknown[];
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    lineWidth: number;
    font: string;
  }>;
}

function recordingContext(): RecordingContext {
  const context: RecordingContext = {
    calls: [],
    records: [],
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    clearRect: function (this: RecordingContext, ...args: number[]): void { record(this, 'clearRect', args); },
    fillRect: function (this: RecordingContext, ...args: number[]): void { record(this, 'fillRect', args); },
    strokeRect: function (this: RecordingContext, ...args: number[]): void { record(this, 'strokeRect', args); },
    rect: function (this: RecordingContext, ...args: number[]): void { record(this, 'rect', args); },
    clip: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'clip', args); },
    beginPath: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'beginPath', args); },
    closePath: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'closePath', args); },
    moveTo: function (this: RecordingContext, ...args: number[]): void { record(this, 'moveTo', args); },
    lineTo: function (this: RecordingContext, ...args: number[]): void { record(this, 'lineTo', args); },
    fill: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'fill', args); },
    stroke: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'stroke', args); },
    fillText: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'fillText', args); },
    drawImage: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'drawImage', args); },
    save: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'save', args); },
    restore: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'restore', args); },
    setTransform: function (this: RecordingContext, ...args: number[]): void { record(this, 'setTransform', args); },
    setLineDash: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'setLineDash', args); }
  };
  return context;
}

function record(context: RecordingContext, name: string, args: unknown[]): void {
  context.calls.push(name);
  context.records.push({
    name,
    args,
    fillStyle: context.fillStyle,
    strokeStyle: context.strokeStyle,
    globalAlpha: context.globalAlpha,
    lineWidth: context.lineWidth,
    font: context.font
  });
}

function target(context: RecordingContext, source?: unknown): CanvasTarget & { resizeCount: number } {
  let resizeCount = 0;
  return {
    context,
    width: 0,
    height: 0,
    source,
    get resizeCount() { return resizeCount; },
    resize(width: number, height: number): void {
      resizeCount += 1;
      this.width = width;
      this.height = height;
    }
  };
}

function pixelContext(width: number, height: number): RecordingContext & { pixels: string[][] } {
  const context = recordingContext() as RecordingContext & { pixels: string[][] };
  context.pixels = Array.from({ length: height }, () => Array.from({ length: width }, () => ''));
  let path: Array<[number, number]> = [];
  const paintRect = (left: number, top: number, rectWidth: number, rectHeight: number): void => {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(top + rectHeight)); y += 1) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(left + rectWidth)); x += 1) context.pixels[y][x] = context.fillStyle;
    }
  };
  const inside = (x: number, y: number): boolean => {
    let result = false;
    for (let index = 0, previous = path.length - 1; index < path.length; previous = index, index += 1) {
      const [currentX, currentY] = path[index];
      const [previousX, previousY] = path[previous];
      const crosses = (currentY > y) !== (previousY > y)
        && x < (previousX - currentX) * (y - currentY) / (previousY - currentY) + currentX;
      if (crosses) result = !result;
    }
    return result;
  };
  context.clearRect = function (this: typeof context, ...args: number[]): void {
    record(this, 'clearRect', args);
    this.pixels = Array.from({ length: height }, () => Array.from({ length: width }, () => ''));
  };
  context.fillRect = function (this: typeof context, ...args: number[]): void {
    record(this, 'fillRect', args);
    paintRect(args[0], args[1], args[2], args[3]);
  };
  context.beginPath = function (this: typeof context): void {
    record(this, 'beginPath', []);
    path = [];
  };
  context.moveTo = function (this: typeof context, x: number, y: number): void {
    record(this, 'moveTo', [x, y]);
    path.push([x, y]);
  };
  context.lineTo = function (this: typeof context, x: number, y: number): void {
    record(this, 'lineTo', [x, y]);
    path.push([x, y]);
  };
  context.fill = function (this: typeof context): void {
    record(this, 'fill', []);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) if (inside(x + 0.5, y + 0.5)) this.pixels[y][x] = this.fillStyle;
    }
  };
  return context;
}

class FakeCanvasImageSource {
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(): unknown {
    return undefined;
  }
}

class FakeOffscreenCanvas extends FakeCanvasImageSource {
  getContext(): RecordingContext {
    return recordingContext();
  }
}

function chart(width = 4, height = 4) {
  return createDocument({
    width,
    height,
    palette: [
      { id: 1, name: 'Red', color: '#f00' },
      { id: 35, name: 'Blue', color: '#00f' }
    ]
  });
}

describe('Canvas 2D chart renderer', () => {
  it('uses deterministic base-36 symbols', () => {
    expect(symbolForPaletteId(1)).toBe('1');
    expect(symbolForPaletteId(35)).toBe('z');
    expect(symbolForPaletteId(36)).toBe('10');
  });

  it('renders floating fragments with transparent holes, destination masking, cleared completion, backstitches, and a clipped boundary', () => {
    const document = chart(3, 2);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    document.completed[0] = 1;
    const source = chart(2, 1);
    source.kind[1] = CellKind.Full;
    source.colors[4] = 1;
    source.backstitches = {
      ids: new Uint32Array([1]),
      x1: new Uint32Array([0]),
      y1: new Uint32Array([0]),
      x2: new Uint32Array([8]),
      y2: new Uint32Array([0]),
      colors: new Uint16Array([1]),
      completed: new Uint8Array([1])
    };
    source.nextBackstitchId = 2;
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 1 });
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 32),
      viewport: { x: 0, y: 0, zoom: 16 }
    });
    renderer.renderNow();
    overlay.calls.length = 0;
    overlay.records.length = 0;
    renderer.setOverlay({ floatingPaste: { fragment, destination: { x: -1, y: 0, width: 2, height: 1 } } });
    renderer.renderNow();

    expect(overlay.records.some((record) => record.name === 'fillRect' && record.fillStyle === '#ffffff')).toBe(true);
    expect(overlay.records.some((record) => record.name === 'strokeRect')).toBe(false);
    expect(overlay.records.some((record) => record.name === 'lineTo')).toBe(true);
    expect(overlay.records.some((record) => record.name === 'fillRect' && record.args[0] === 16)).toBe(false);
    renderer.dispose();
  });

  it('renders move completion/backstitch state with source contour below destination preview', () => {
    const document = chart(4, 2);
    const source = chart(1, 1);
    source.kind[0] = CellKind.Full;
    source.colors[0] = 1;
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 1, height: 1 });
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(40, 20),
      viewport: { x: 0, y: 0, zoom: 10 },
      style: { showGrid: false },
      overlay: {
        floatingPaste: {
          mode: 'move',
          fragment,
          destination: { x: 2, y: 0, width: 1, height: 1 },
          copySelection: { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } },
          sourceSelection: { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } },
          completion: new Uint8Array([1]),
          backstitches: {
            ids: new Uint32Array([4]),
            x1: new Uint32Array([0]),
            y1: new Uint32Array([0]),
            x2: new Uint32Array([4]),
            y2: new Uint32Array([0]),
            colors: new Uint16Array([1]),
            completed: new Uint8Array([1])
          }
        }
      }
    });
    renderer.renderNow();

    const sourceContour = overlay.records.findIndex((record) => record.name === 'moveTo' && record.args.join(',') === '0,0');
    const destinationFill = overlay.records.findIndex((record) => record.name === 'fillRect' && record.args[0] === 20 && record.args[1] === 0);
    expect(sourceContour).toBeGreaterThanOrEqual(0);
    expect(destinationFill).toBeGreaterThan(sourceContour);
    expect(overlay.records.some((record) => record.name === 'fillRect' && record.args[0] === 20 && record.globalAlpha < 1)).toBe(true);
    expect(overlay.records.some((record) => record.name === 'lineTo' && record.args.join(',') === '30,0' && record.globalAlpha < 1)).toBe(true);
    renderer.dispose();
  });

  it('translates sparse exterior and interior copy-time contours at a legal clamped destination', () => {
    const document = chart(8, 8);
    const source = chart(3, 3);
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 3, height: 3 });
    const geometry = sparseSelectionGeometry(new Uint32Array([0, 1, 2, 3, 5, 6, 7, 8]), 3, 3)!;
    const boundaries = geometry.boundaries.map((boundary) => Object.freeze({
      start: Object.freeze({ ...boundary.start }),
      end: Object.freeze({ ...boundary.end }),
      kind: boundary.kind
    }));
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(80, 80),
      viewport: { x: 0, y: 0, zoom: 10 },
      overlay: {
        floatingPaste: {
          fragment,
          destination: { x: 5, y: 5, width: 3, height: 3 },
          copySelection: { kind: 'sparse', rect: { x: 5, y: 5, width: 3, height: 3 }, boundaries }
        }
      }
    });
    renderer.renderNow();

    expect(geometry.boundaries.some((boundary) => boundary.kind === 'exterior')).toBe(true);
    expect(geometry.boundaries.some((boundary) => boundary.kind === 'interior')).toBe(true);
    const contourPaths = overlay.records
      .filter((record) => record.strokeStyle === '#2266cc' && ['moveTo', 'lineTo'].includes(record.name))
      .map((record) => `${record.name}:${(record.args as number[]).join(',')}`);
    expect(contourPaths).toEqual(expect.arrayContaining([
      'moveTo:50,50', 'lineTo:60,50',
      'moveTo:70,60', 'lineTo:60,60',
      'moveTo:60,60', 'lineTo:60,70',
      'moveTo:70,70', 'lineTo:70,60',
      'moveTo:60,70', 'lineTo:70,70'
    ]));
    expect(boundaries[0]?.start).toEqual(geometry.boundaries[0]?.start);
    renderer.dispose();
  });

  it('clips a rectangular copied contour by its true visible edges', () => {
    const document = chart(3, 2);
    const source = chart(2, 1);
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 1 });
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 32),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { showGrid: false },
      overlay: { floatingPaste: { fragment, destination: { x: -1, y: 0, width: 2, height: 1 } } }
    });
    renderer.renderNow();

    const contourPath = overlay.records.filter((record) => record.strokeStyle === '#2266cc' && ['moveTo', 'lineTo'].includes(record.name));
    expect(contourPath).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'moveTo', args: [0, 0] }),
      expect.objectContaining({ name: 'lineTo', args: [16, 0] }),
      expect.objectContaining({ name: 'moveTo', args: [16, 0] }),
      expect.objectContaining({ name: 'lineTo', args: [16, 16] }),
      expect.objectContaining({ name: 'moveTo', args: [16, 16] }),
      expect.objectContaining({ name: 'lineTo', args: [0, 16] })
    ]));
    expect(contourPath.some((record) => record.name === 'moveTo' && record.args.join(',') === '0,16')).toBe(false);
    renderer.dispose();
  });

  it('culls large sparse copy-time contour work to the visible chart', () => {
    const document = chart(64, 64);
    const source = chart(64, 64);
    const indices = new Uint32Array(Array.from({ length: 32 * 64 }, (_, position) => {
      const y = Math.floor(position / 32);
      const x = (position % 32) * 2;
      return y * 64 + x;
    }));
    const geometry = sparseSelectionGeometry(indices, 64, 64)!;
    const fragment = createPatternFragment(source, geometry.bounds);
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(64, 64),
      viewport: { x: 0, y: 0, zoom: 8 },
      style: { showGrid: false },
      overlay: {
        floatingPaste: {
          fragment,
          destination: { x: 1, y: 0, width: geometry.bounds.width, height: geometry.bounds.height },
          copySelection: { kind: 'sparse', rect: geometry.bounds, boundaries: geometry.boundaries }
        }
      }
    });
    renderer.renderNow();

    const contourStrokes = overlay.records.filter((record) => record.name === 'stroke' && record.strokeStyle === '#2266cc');
    expect(geometry.boundaries.length).toBeGreaterThan(4000);
    expect(contourStrokes.length).toBeGreaterThan(0);
    expect(contourStrokes.length).toBeLessThan(400);
    renderer.dispose();
  });

  it('bounds floating preview cell work to the visible source-coordinate intersection', () => {
    const document = chart(4, 4);
    const source = createDocument({ width: 128, height: 128, palette: [{ id: 1, name: 'Red', color: '#f00' }] });
    source.kind[2 * source.width + 2] = CellKind.Full;
    source.colors[(2 * source.width + 2) * 4] = 1;
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 128, height: 128 });
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(64, 64),
      viewport: { x: 2, y: 2, zoom: 16 }
    });
    renderer.renderNow();
    overlay.calls.length = 0;
    overlay.records.length = 0;
    renderer.setOverlay({ floatingPaste: { fragment, destination: { x: 0, y: 0, width: 128, height: 128 } } });
    renderer.renderNow();
    expect(overlay.records.filter((record) => record.name === 'fillRect').length).toBeLessThanOrEqual(2);
    renderer.dispose();
  });

  it('renders the v2 palette symbol instead of deriving one from the palette ID', () => {
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'combined' }
    });
    renderer.renderNow();
    expect(base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    renderer.dispose();
  });

  it('keeps the dark symbol ink on a light stitch in combined mode', () => {
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], color: '#f0f0f0' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'combined' }
    });
    renderer.renderNow();
    expect(base.records.some((call) => call.name === 'fillText' && call.fillStyle === '#242424')).toBe(true);
    renderer.dispose();
  });

  it('flips the symbol ink to white on a dark stitch in combined mode', () => {
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], color: '#000000' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'combined' }
    });
    renderer.renderNow();
    expect(base.records.some((call) => call.name === 'fillText' && call.fillStyle === '#ffffff')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillText' && call.fillStyle === '#242424')).toBe(false);
    renderer.dispose();
  });

  it('keeps the configured symbol ink in symbol mode regardless of cell color', () => {
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], color: '#000000' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'symbol' }
    });
    renderer.renderNow();
    expect(base.records.some((call) => call.name === 'fillText' && call.fillStyle === '#242424')).toBe(true);
    renderer.dispose();
  });

  it('scales the symbol font to the grid cell size in combined mode', () => {
    const document = chart(1, 1);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'combined' }
    });
    renderer.renderNow();
    // A 1x1 cell spans viewport.zoom screen px (cellToScreenRect: width =
    // height = zoom), so the default 1em symbolFont resolves to 16px.
    expect(base.records.some((call) => call.name === 'fillText' && call.font === '600 16px sans-serif')).toBe(true);
    renderer.dispose();
  });

  it('applies the per-glyph scale and dy override to shift the draw centre', () => {
    // Render the same centred 1x1 cell once with the overridden glyph (℗
    // = { scale: 0.7, dy: 2 }) and once with a plain glyph, in fresh contexts,
    // to compare font scaling and draw-centre shift without renderer diffing.
    const renderSingle = (symbol: string): RecordingContext => {
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol };
      document.kind[0] = CellKind.Full;
      document.colors[0] = 1;
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(32, 32),
        viewport: { x: 0, y: 0, zoom: 16 },
        style: { mode: 'combined' }
      });
      renderer.renderNow();
      renderer.dispose();
      return base;
    };
    const marker = renderSingle('\u2117');
    const overridden = marker.records.find((call) => call.name === 'fillText' && call.args[0] === '\u2117');
    expect(overridden).toBeDefined();
    // Scale shrinks the 16px cell to 16 × 0.7 = 11.2 → 11px em font.
    expect(overridden?.font).toBe('600 11px sans-serif');
    const plain = renderSingle('\u25cf').records.find((call) => call.name === 'fillText' && call.args[0] === '\u25cf');
    expect(plain).toBeDefined();
    // dy shifts the draw centre 2px below the plain glyph's baseline.
    expect(overridden?.args[2]).toBe((plain?.args[2] as number) + 2);
  });

  it('applies scale-only overrides without shifting the draw position', () => {
    const renderSingle = (symbol: string): RecordingContext => {
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol };
      document.kind[0] = CellKind.Full;
      document.colors[0] = 1;
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(32, 32),
        viewport: { x: 0, y: 0, zoom: 16 },
        style: { mode: 'combined' }
      });
      renderer.renderNow();
      renderer.dispose();
      return base;
    };
    // ⣿ is overridden with { scale: 0.6 } only.
    const braille = renderSingle('\u28FF');
    const scalled = braille.records.find((call) => call.name === 'fillText' && call.args[0] === '\u28FF');
    expect(scalled).toBeDefined();
    // Scale shrinks the 16px cell to 16 × 0.6 = 9.6 → 10px em font.
    expect(scalled?.font).toBe('600 10px sans-serif');
    const plain = renderSingle('\u25cf').records.find((call) => call.name === 'fillText' && call.args[0] === '\u25cf');
    expect(plain).toBeDefined();
    // No dy entry on ⣿: the draw centre stays on the plain-glyph baseline.
    expect(scalled?.args[2]).toBe(plain?.args[2]);
  });

  it('draws full, half, quarter geometry and culls distant backstitches', () => {
    const document = chart();
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    document.kind[1] = CellKind.HalfBackslash;
    document.colors[4] = 1;
    document.kind[2] = CellKind.HalfSlash;
    document.colors[8] = 1;
    document.kind[3] = CellKind.Quarters;
    document.colors.set([1, 35, 1, 35], 12);
    document.backstitches = {
      ids: new Uint32Array([1, 2]),
      x1: new Uint32Array([0, 40]),
      y1: new Uint32Array([2, 2]),
      x2: new Uint32Array([16, 48]),
      y2: new Uint32Array([2, 2]),
      colors: new Uint16Array([1, 1]),
      completed: new Uint8Array([0, 0])
    };
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(64, 64, { dpr: 1 }),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'combined' }
    });
    const stats = renderer.renderNow();
    expect(stats.visitedCells).toBe(16);
    expect(stats.drawnCells).toBe(4);
    expect(stats.drawnBackstitches).toBe(1);
    expect(base.calls).toContain('fillRect');
    expect(base.calls).toContain('fill');
    expect(base.calls).toContain('fillText');
    expect(base.records.find((call) => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0 && call.args[2] === 16 && call.args[3] === 16)).toMatchObject({ fillStyle: '#f00' });
    expect(base.records.some((call) => call.name === 'moveTo' && call.args[0] === 16 && call.args[1] === 0)).toBe(true);
  });

  it('renders half bands and all directional three-quarter triangles with exact paths', () => {
    const document = chart(6, 1);
    document.kind.set([
      CellKind.HalfBackslash,
      CellKind.HalfSlash,
      CellKind.ThreeQuarterNW,
      CellKind.ThreeQuarterNE,
      CellKind.ThreeQuarterSE,
      CellKind.ThreeQuarterSW
    ]);
    for (let index = 0; index < 6; index += 1) document.colors[index * 4] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(96, 16),
      viewport: { x: 0, y: 0, zoom: 16 }
    });
    renderer.renderNow();
    const paths = base.records
      .filter((call) => call.fillStyle === '#f00' && call.strokeStyle === '' && (call.name === 'moveTo' || call.name === 'lineTo'))
      .map((call) => [call.name, ...(call.args as number[])]);
    const halfLeg = 16 * Math.SQRT1_2;
    expect(paths).toEqual([
      ['moveTo', 0, 0], ['lineTo', 16 - halfLeg, 0], ['lineTo', 16, halfLeg], ['lineTo', 16, 16], ['lineTo', halfLeg, 16], ['lineTo', 0, 16 - halfLeg],
      ['moveTo', 16 + halfLeg, 0], ['lineTo', 32, 0], ['lineTo', 32, 16 - halfLeg], ['lineTo', 32 - halfLeg, 16], ['lineTo', 16, 16], ['lineTo', 16, halfLeg],
      ['moveTo', 32, 0], ['lineTo', 48, 0], ['lineTo', 32, 16],
      ['moveTo', 48, 0], ['lineTo', 64, 0], ['lineTo', 64, 16],
      ['moveTo', 80, 0], ['lineTo', 80, 16], ['lineTo', 64, 16],
      ['moveTo', 80, 0], ['lineTo', 96, 16], ['lineTo', 80, 16]
    ]);
    renderer.dispose();
  });

  it('renders paired three-quarter axes with distinct detail colors and asymmetric completion', () => {
    const document = chart(2, 1);
    document.kind[0] = ThreeQuarterPair;
    document.colors.set([1, 0, 35, 0], 0);
    document.completed[0] = 1;
    document.kind[1] = ThreeQuarterPair;
    document.colors.set([0, 35, 0, 1], 4);
    document.completed[1] = 2;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'color' }
    });
    renderer.renderNow();
    const paths = base.records
      .filter((call) => (call.fillStyle === '#f00' || call.fillStyle === '#00f') && call.strokeStyle !== '#4b4b4b' && call.args[1] !== 4 && (call.name === 'moveTo' || call.name === 'lineTo'))
      .map((call) => [call.name, ...(call.args as number[]), call.fillStyle]);
    expect(paths).toEqual([
      ['moveTo', 0, 0, '#f00'], ['lineTo', 16, 0, '#f00'], ['lineTo', 0, 16, '#f00'],
      ['moveTo', 16, 0, '#00f'], ['lineTo', 16, 16, '#00f'], ['lineTo', 0, 16, '#00f'],
      ['moveTo', 16, 0, '#00f'], ['lineTo', 32, 0, '#00f'], ['lineTo', 32, 16, '#00f'],
      ['moveTo', 16, 0, '#f00'], ['lineTo', 32, 16, '#f00'], ['lineTo', 16, 16, '#f00']
    ]);
    expect(base.records.filter((call) => call.name === 'stroke' && call.strokeStyle === '#242424')).toHaveLength(2);
    renderer.dispose();
  });

  it('renders pending paired colors and only the occupied completion mark', () => {
    const document = chart(1, 1);
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(16, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        pendingCellStates: [{ index: 0, cell: { x: 0, y: 0 }, kind: ThreeQuarterPair, colors: [1, 0, 35, 0], completed: 1 }]
      }
    });
    renderer.renderNow();
    const paths = overlay.records
      .filter((call) => (call.fillStyle === '#f00' || call.fillStyle === '#00f') && call.strokeStyle !== '#ffffff' && call.args[1] !== 4 && (call.name === 'moveTo' || call.name === 'lineTo'))
      .map((call) => [call.name, ...(call.args as number[]), call.fillStyle]);
    expect(paths).toEqual([
      ['moveTo', 0, 0, '#f00'], ['lineTo', 16, 0, '#f00'], ['lineTo', 0, 16, '#f00'],
      ['moveTo', 16, 0, '#00f'], ['lineTo', 16, 16, '#00f'], ['lineTo', 0, 16, '#00f']
    ]);
    expect(overlay.records.filter((call) => call.name === 'stroke' && call.strokeStyle === '#242424')).toHaveLength(1);
    renderer.dispose();
  });

  it('renders a paired clear preview without removing the opposite completion mark', () => {
    const document = chart(1, 1);
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(16, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        pendingCellStates: [{ index: 0, cell: { x: 0, y: 0 }, kind: ThreeQuarterPair, colors: [1, 0, 35, 0], completed: 4 }]
      }
    });
    renderer.renderNow();
    const paths = overlay.records
      .filter((call) => (call.fillStyle === '#f00' || call.fillStyle === '#00f') && call.strokeStyle === '' && (call.name === 'moveTo' || call.name === 'lineTo'))
      .map((call) => [call.name, ...(call.args as number[]), call.fillStyle]);
    expect(paths).toEqual([
      ['moveTo', 0, 0, '#f00'], ['lineTo', 16, 0, '#f00'], ['lineTo', 0, 16, '#f00'],
      ['moveTo', 16, 0, '#00f'], ['lineTo', 16, 16, '#00f'], ['lineTo', 0, 16, '#00f']
    ]);
    expect(overlay.records.filter((call) => call.name === 'stroke' && call.strokeStyle === '#242424')).toHaveLength(1);
    renderer.dispose();
  });

  it('renders a clipped brush preview as a low-alpha outer footprint outline', () => {
    const document = chart(5, 5);
    document.palette[0] = { ...document.palette[0], color: '#ffffff' };
    document.palette[1] = { ...document.palette[1], color: '#000000' };
    document.colors[1 * 4] = 35;
    document.colors[5 * 4] = 1;
    document.colors[6 * 4] = 35;
    document.colors[7 * 4] = 35;
    document.colors[11 * 4] = 35;
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(80, 80),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [
            { index: 1, cell: { x: 1, y: 0 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 5, cell: { x: 0, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 6, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 7, cell: { x: 2, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 11, cell: { x: 1, y: 2 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }
          ]
        }
      }
    });
    renderer.renderNow();
    expect(overlay.records.some((call) => call.name === 'fillRect' && call.globalAlpha < 0.3)).toBe(false);
    expect(overlay.records.filter((call) => call.name === 'fill').length).toBe(0);
    expect(overlay.records.some((call) => call.name === 'stroke' && call.globalAlpha === 0.42)).toBe(true);
    const previewSegments = overlay.records.filter((call) => call.name === 'lineTo' && (call.strokeStyle === '#242424' || call.strokeStyle === '#ffffff'));
    expect(previewSegments.length).toBe(12);
    expect(new Set(previewSegments.map((call) => call.globalAlpha))).toEqual(new Set([0.42]));
    expect(new Set(previewSegments.map((call) => call.strokeStyle))).toEqual(new Set(['#242424', '#ffffff']));
    renderer.dispose();
  });

  it('dims the committed pattern while move-image dimming is active', () => {
    const document = chart(1, 1);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(16, 16),
      viewport: { x: 0, y: 0, zoom: 16 }
    });
    const cellFills = () => base.records.filter((call) => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0 && call.args[2] === 16 && call.args[3] === 16);
    renderer.renderNow();
    // The background fill and the (0,0) cell fill share the same rect; the cell
    // is drawn last, so it is the final record while the background stays opaque.
    expect(cellFills().at(-1)?.globalAlpha).toBe(1);
    base.calls.length = 0;
    base.records.length = 0;
    renderer.setPatternDimmed?.(true);
    renderer.renderNow();
    expect(cellFills().at(-1)?.globalAlpha).toBe(0.5);
    renderer.setPatternDimmed?.(false);
    renderer.dispose();
  });

  it('renders base and overlay independently and coalesces RAF work', () => {
    const base = recordingContext();
    const overlay = recordingContext();
    let requests = 0;
    let callback: ((time: number) => void) | undefined;
    const renderer = createCanvasRenderer({
      document: chart(),
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(32, 32),
      requestAnimationFrame: (next) => {
        requests += 1;
        callback = next;
        return requests;
      },
      cancelAnimationFrame: () => undefined
    });
    renderer.renderNow();
    base.calls.length = 0;
    overlay.calls.length = 0;
    renderer.setOverlay({ cursor: { x: 1, y: 1 } });
    renderer.invalidate('overlay');
    expect(requests).toBe(1);
    callback?.(0);
    expect(renderer.lastStats.baseRendered).toBe(false);
    expect(renderer.lastStats.overlayRendered).toBe(true);
    expect(base.calls).toEqual([]);
    expect(overlay.calls).toContain('strokeRect');
  });

  it('uses one cached atlas in overview mode', () => {
    const base = recordingContext();
    let atlasBuilds = 0;
    const renderer = createCanvasRenderer({
      document: chart(500, 500),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(500, 500),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: () => {
        atlasBuilds += 1;
        return target(recordingContext(), new FakeCanvasImageSource(500, 500));
      }
    });
    renderer.renderNow();
    renderer.invalidate('base');
    renderer.renderNow();
    expect(atlasBuilds).toBe(1);
    expect(base.calls.filter((call) => call === 'drawImage')).toHaveLength(2);
    expect(renderer.lastStats.visitedCells).toBe(0);
    const imageCall = base.records.find((call) => call.name === 'drawImage');
    expect(imageCall?.args[0]).toBeInstanceOf(FakeCanvasImageSource);
    expect(isCanvasImageSource(imageCall?.args[0])).toBe(true);
  });

  it('keeps half-band and directional three-quarter geometry in color overview atlases and fallbacks', () => {
    const createDocument = () => {
      const document = chart(2, 1);
      document.kind[0] = CellKind.HalfBackslash;
      document.kind[1] = CellKind.ThreeQuarterNE;
      document.colors[0] = 1;
      document.colors[4] = 1;
      return document;
    };
    const geometryPaths = (context: RecordingContext): unknown[][] => context.records
      .filter((call) => call.fillStyle === '#f00' && call.strokeStyle === '' && (call.name === 'moveTo' || call.name === 'lineTo'))
      .map((call) => [call.name, ...(call.args as number[])]);
    const halfLeg = Math.SQRT1_2;
    const expected = [
      ['moveTo', 0, 0], ['lineTo', 1 - halfLeg, 0], ['lineTo', 1, halfLeg], ['lineTo', 1, 1], ['lineTo', halfLeg, 1], ['lineTo', 0, 1 - halfLeg],
      ['moveTo', 1, 0], ['lineTo', 2, 0], ['lineTo', 2, 1]
    ];

    const atlasSource = recordingContext();
    const atlasRenderer = createCanvasRenderer({
      document: createDocument(),
      targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'color' },
      atlasTargetFactory: (width, height) => target(atlasSource, new FakeCanvasImageSource(width, height))
    });
    atlasRenderer.renderNow();
    expect(geometryPaths(atlasSource)).toEqual(expected);
    atlasRenderer.dispose();

    const fallbackBase = recordingContext();
    const fallbackRenderer = createCanvasRenderer({
      document: createDocument(),
      targets: { base: target(fallbackBase), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'color' },
      atlasTargetFactory: () => undefined
    });
    fallbackRenderer.renderNow();
    expect(geometryPaths(fallbackBase)).toEqual(expected);
    fallbackRenderer.dispose();
  });

  it('renders both paired axes in color overview atlases and no-atlas fallback', () => {
    const createDocument = () => {
      const document = chart(2, 1);
      document.kind[0] = ThreeQuarterPair;
      document.colors.set([1, 0, 35, 0], 0);
      document.kind[1] = ThreeQuarterPair;
      document.colors.set([0, 35, 0, 1], 4);
      return document;
    };
    const geometryPaths = (context: RecordingContext): unknown[][] => context.records
      .filter((call) => (call.fillStyle === '#f00' || call.fillStyle === '#00f') && call.strokeStyle === '' && (call.name === 'moveTo' || call.name === 'lineTo'))
      .map((call) => [call.name, ...(call.args as number[]), call.fillStyle]);
    const expectedAtlas = [
      ['moveTo', 0, 0, '#f00'], ['lineTo', 2, 0, '#f00'], ['lineTo', 0, 2, '#f00'],
      ['moveTo', 2, 0, '#00f'], ['lineTo', 2, 2, '#00f'], ['lineTo', 0, 2, '#00f'],
      ['moveTo', 2, 0, '#00f'], ['lineTo', 4, 0, '#00f'], ['lineTo', 4, 2, '#00f'],
      ['moveTo', 2, 0, '#f00'], ['lineTo', 4, 2, '#f00'], ['lineTo', 2, 2, '#f00']
    ];
    const expectedFallback = [
      ['moveTo', 0, 0, '#f00'], ['lineTo', 1, 0, '#f00'], ['lineTo', 0, 1, '#f00'],
      ['moveTo', 1, 0, '#00f'], ['lineTo', 1, 1, '#00f'], ['lineTo', 0, 1, '#00f'],
      ['moveTo', 1, 0, '#00f'], ['lineTo', 2, 0, '#00f'], ['lineTo', 2, 1, '#00f'],
      ['moveTo', 1, 0, '#f00'], ['lineTo', 2, 1, '#f00'], ['lineTo', 1, 1, '#f00']
    ];
    const atlasSource = recordingContext();
    const atlasRenderer = createCanvasRenderer({
      document: createDocument(),
      targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'color' },
      atlasTargetFactory: (width, height) => target(atlasSource, new FakeCanvasImageSource(width, height))
    });
    atlasRenderer.renderNow();
    expect(geometryPaths(atlasSource)).toEqual(expectedAtlas);
    atlasRenderer.dispose();

    const fallbackBase = recordingContext();
    const fallbackRenderer = createCanvasRenderer({
      document: createDocument(),
      targets: { base: target(fallbackBase), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'color' },
      atlasTargetFactory: () => undefined
    });
    fallbackRenderer.renderNow();
    expect(geometryPaths(fallbackBase)).toEqual(expectedFallback);
    fallbackRenderer.dispose();
  });

  it('preserves both paired colors in 2x source pixels at overview zoom', () => {
    const document = chart(2, 1);
    document.kind[0] = ThreeQuarterPair;
    document.colors.set([1, 0, 35, 0], 0);
    document.kind[1] = ThreeQuarterPair;
    document.colors.set([0, 35, 0, 1], 4);
    const source = pixelContext(4, 2);
    const base = recordingContext();
    const imageSource = new FakeCanvasImageSource(4, 2);
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(4, 2),
      viewport: { x: 0, y: 0, zoom: 2 },
      style: { mode: 'color' },
      atlasTargetFactory: (width, height) => {
        expect([width, height]).toEqual([4, 2]);
        return target(source, imageSource);
      }
    });
    renderer.renderNow();
    expect(source.pixels[0][0]).toBe('#f00');
    expect(source.pixels[1][1]).toBe('#00f');
    expect(source.pixels[0][3]).toBe('#00f');
    expect(source.pixels[1][2]).toBe('#f00');
    const drawImageArgs = base.records.find((call) => call.name === 'drawImage')?.args;
    expect(drawImageArgs?.[0]).toBe(imageSource);
    expect(drawImageArgs?.slice(1).map((value) => Math.abs(value as number))).toEqual([0, 0, 4, 2, 0, 0, 4, 2]);
    renderer.dispose();
  });

  it('treats directional three-quarter cells as one atlas slot and rebuilds on revision', () => {
    const document = chart(1, 1);
    document.kind[0] = CellKind.ThreeQuarterNW;
    document.colors[0] = 1;
    const sources: RecordingContext[] = [];
    let builds = 0;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(8, 8),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol' },
      atlasTargetFactory: (width, height) => {
        builds += 1;
        const source = recordingContext();
        sources.push(source);
        return target(source, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records.filter((call) => call.name === 'fill')).toHaveLength(1);
    expect(sources[0].records.filter((call) => call.name === 'moveTo' || call.name === 'lineTo').map((call) => call.args)).toEqual([
      [0, 0], [8, 0], [0, 8]
    ]);

    renderer.invalidate('base');
    renderer.renderNow();
    expect(builds).toBe(1);

    const next = chart(1, 1);
    next.kind[0] = CellKind.ThreeQuarterSW;
    next.colors[0] = 1;
    next.revision = document.revision + 1;
    renderer.setDocument(next);
    renderer.renderNow();
    expect(builds).toBe(2);
    expect(sources[1].records.filter((call) => call.name === 'fill')).toHaveLength(1);
    expect(sources[1].records.filter((call) => call.name === 'moveTo' || call.name === 'lineTo').map((call) => call.args)).toEqual([
      [0, 0], [8, 8], [0, 8]
    ]);
    renderer.dispose();
  });

  it('only resizes targets when backing dimensions change', () => {
    const base = recordingContext();
    const overlay = recordingContext();
    const baseTarget = target(base);
    const overlayTarget = target(overlay);
    const metrics = getCanvasMetrics(64, 64, { dpr: 1 });
    const renderer = createCanvasRenderer({
      document: chart(),
      targets: { base: baseTarget, overlay: overlayTarget },
      metrics,
      viewport: { x: 0, y: 0, zoom: 16 }
    });
    renderer.renderNow();
    expect(baseTarget.resizeCount).toBe(1);
    expect(overlayTarget.resizeCount).toBe(1);
    renderer.invalidate('base');
    renderer.renderNow();
    expect(baseTarget.resizeCount).toBe(1);
    renderer.setMetrics(metrics);
    renderer.renderNow();
    expect(baseTarget.resizeCount).toBe(1);
    renderer.setMetrics(getCanvasMetrics(64, 64, { dpr: 2 }));
    renderer.renderNow();
    expect(baseTarget.resizeCount).toBe(2);
    expect(overlayTarget.resizeCount).toBe(2);
    renderer.setMetrics(getCanvasMetrics(80, 64, { dpr: 1 }));
    renderer.renderNow();
    expect(baseTarget.resizeCount).toBe(3);
    expect(overlayTarget.resizeCount).toBe(3);
    renderer.dispose();
  });

  it('treats the projected viewport as authoritative without chart-bound clamping', () => {
    const document = chart(4, 4);
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(64, 64),
      viewport: { x: 100, y: -100, zoom: 16 }
    });
    expect(renderer.getViewport()).toEqual({ x: 100, y: -100, zoom: 16 });
    renderer.setViewport({ x: -250, y: 350, zoom: 2 });
    expect(renderer.getViewport()).toEqual({ x: -250, y: 350, zoom: 2 });
    renderer.setDocument(chart(8, 8));
    renderer.setMetrics(getCanvasMetrics(80, 80));
    expect(renderer.getViewport()).toEqual({ x: -250, y: 350, zoom: 2 });
    renderer.dispose();
  });

  it('coalesces reasons and performs a clipped bounded redraw', () => {
    const document = chart(100, 100);
    document.kind[6 * 100 + 5] = CellKind.Full;
    document.colors[(6 * 100 + 5) * 4] = 1;
    document.kind[6 * 100 + 6] = CellKind.Full;
    document.colors[(6 * 100 + 6) * 4] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(40, 40),
      viewport: { x: 0, y: 0, zoom: 4 }
    });
    renderer.renderNow();
    base.calls.length = 0;
    base.records.length = 0;
    renderer.invalidate({ layer: 'base', cellRect: { x: 5, y: 6, width: 1, height: 1 }, reason: 'paint-cell' });
    renderer.invalidate({ layer: 'base', cellRect: { x: 6, y: 6, width: 1, height: 1 }, reason: 'completion-cell' });
    renderer.renderNow();
    expect(renderer.getLastInvalidation()).toMatchObject({
      base: true,
      cellRect: { x: 5, y: 6, width: 2, height: 1 },
      reasons: ['paint-cell', 'completion-cell']
    });
    expect(renderer.lastStats.visitedCells).toBe(2);
    expect(base.records.some((call) => call.name === 'clip')).toBe(true);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(false);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '20,24,8,4')).toBe(true);
    renderer.setStyle({ gridColor: '#000' });
    renderer.renderNow();
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(true);
    renderer.dispose();
  });

  it('accepts bounded invalidation atomically through document and overlay setters', () => {
    const original = chart(100, 100);
    const next = chart(100, 100);
    next.kind[6 * 100 + 5] = CellKind.Full;
    next.colors[(6 * 100 + 5) * 4] = 1;
    next.revision = original.revision + 1;
    const base = recordingContext();
    const overlay = recordingContext();
    const baseTarget = target(base);
    const overlayTarget = target(overlay);
    const renderer = createCanvasRenderer({
      document: original,
      targets: { base: baseTarget, overlay: overlayTarget },
      metrics: getCanvasMetrics(40, 40),
      viewport: { x: 0, y: 0, zoom: 4 }
    });
    renderer.renderNow();
    base.calls.length = 0;
    base.records.length = 0;
    overlay.calls.length = 0;
    overlay.records.length = 0;

    renderer.setDocument(next, {
      layer: 'base',
      cellRect: { x: 5, y: 6, width: 1, height: 1 },
      reason: 'document-revision'
    });
    renderer.renderNow();
    expect(renderer.lastStats.visitedCells).toBe(1);
    expect(renderer.lastStats.baseRendered).toBe(true);
    expect(renderer.lastStats.overlayRendered).toBe(false);
    expect(base.records.some((call) => call.name === 'clip')).toBe(true);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(false);
    expect(baseTarget.resizeCount).toBe(1);
    expect(overlay.records).toEqual([]);
    expect(renderer.getLastInvalidation().reasons).toContain('document-revision');

    overlay.calls.length = 0;
    overlay.records.length = 0;
    renderer.setOverlay({ cursor: { x: 5, y: 6 } }, {
      layer: 'overlay',
      cellRect: { x: 5, y: 6, width: 1, height: 1 },
      reason: 'cursor-region'
    });
    renderer.renderNow();
    expect(renderer.lastStats.baseRendered).toBe(false);
    expect(renderer.lastStats.overlayRendered).toBe(true);
    expect(overlay.records.some((call) => call.name === 'clip')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(false);
    expect(overlayTarget.resizeCount).toBe(1);
    expect(renderer.getLastInvalidation().reasons).toContain('cursor-region');
    renderer.dispose();
  });

  it('does not cancel the initial full draw when setDocument receives a bounded invalidation first', () => {
    const original = chart(100, 100);
    const next = chart(100, 100);
    next.kind[6 * 100 + 5] = CellKind.Full;
    next.colors[(6 * 100 + 5) * 4] = 1;
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document: original,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(40, 40),
      viewport: { x: 0, y: 0, zoom: 4 }
    });
    renderer.setDocument(next, {
      layer: 'base',
      cellRect: { x: 5, y: 6, width: 1, height: 1 },
      reason: 'before-initial-document'
    });
    const stats = renderer.renderNow();
    expect(stats.baseRendered).toBe(true);
    expect(stats.overlayRendered).toBe(true);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(true);
    renderer.dispose();
  });

  it('does not cancel the initial full draw when setOverlay receives a bounded invalidation first', () => {
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document: chart(100, 100),
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(40, 40),
      viewport: { x: 0, y: 0, zoom: 4 }
    });
    renderer.setOverlay({ cursor: { x: 5, y: 6 } }, {
      layer: 'overlay',
      cellRect: { x: 5, y: 6, width: 1, height: 1 },
      reason: 'before-initial-overlay'
    });
    const stats = renderer.renderNow();
    expect(stats.baseRendered).toBe(true);
    expect(stats.overlayRendered).toBe(true);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(true);
    renderer.dispose();
  });

  it('rebuilds an overview atlas for a changed document while keeping bounded setter invalidation full-safe', () => {
    const original = chart(2, 2);
    original.kind[0] = CellKind.Full;
    original.colors[0] = 1;
    const next = chart(2, 2);
    next.kind[0] = CellKind.Full;
    next.colors[0] = 35;
    next.revision = original.revision + 1;
    const base = recordingContext();
    let atlasBuilds = 0;
    const renderer = createCanvasRenderer({
      document: original,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 20),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: (width, height) => {
        atlasBuilds += 1;
        return target(recordingContext(), new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    base.records.length = 0;
    renderer.setDocument(next, {
      layer: 'base',
      cellRect: { x: 0, y: 0, width: 1, height: 1 },
      reason: 'document-overview'
    });
    renderer.renderNow();
    expect(atlasBuilds).toBe(2);
    expect(renderer.lastStats.lod).toBe('overview');
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,20,20')).toBe(true);
    renderer.dispose();
  });

  it('reuses the color overview atlas when only completion and revision change', () => {
    const document = chart(2, 2);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const completionOnlyDocument = {
      ...document,
      completed: document.completed.slice(),
      revision: document.revision + 1
    };
    const base = recordingContext();
    const sources: RecordingContext[] = [];
    let builds = 0;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 20),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: (width, height) => {
        builds += 1;
        const source = recordingContext();
        sources.push(source);
        return target(source, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    const firstSourceCalls = sources[0].records.length;

    renderer.setDocument(completionOnlyDocument);
    renderer.renderNow();

    expect(builds).toBe(1);
    expect(sources[0].records).toHaveLength(firstSourceCalls);
    renderer.dispose();
  });

  it('reuses the color overview atlas for unused palette changes but rebuilds for a used color mutation', () => {
    const document = chart(2, 2);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const densePlaneReads = { kind: 0, colors: 0 };
    const trackPlane = <T extends Uint8Array | Uint16Array>(plane: T, name: keyof typeof densePlaneReads): T => new Proxy(plane, {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) densePlaneReads[name] += 1;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as T;
    document.kind = trackPlane(document.kind, 'kind');
    document.colors = trackPlane(document.colors, 'colors');
    const base = recordingContext();
    const sources: RecordingContext[] = [];
    let builds = 0;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 20),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: (width, height) => {
        builds += 1;
        const source = recordingContext();
        sources.push(source);
        return target(source, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    const firstSourceCalls = sources[0].records.length;
    densePlaneReads.kind = 0;
    densePlaneReads.colors = 0;

    const appended = {
      ...document,
      palette: [...document.palette, { ...document.palette[1], id: 99, name: 'Unused' }],
      revision: document.revision + 1
    };
    renderer.setDocument(appended);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records).toHaveLength(firstSourceCalls);
    expect(densePlaneReads).toEqual({ kind: 0, colors: 0 });
    densePlaneReads.kind = 0;
    densePlaneReads.colors = 0;

    const unusedUpdated = {
      ...appended,
      palette: appended.palette.map((entry) => entry.id === 99 ? { ...entry, color: '#abcdef' } : entry),
      revision: appended.revision + 1
    };
    renderer.setDocument(unusedUpdated);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records).toHaveLength(firstSourceCalls);
    expect(densePlaneReads).toEqual({ kind: 0, colors: 0 });

    (unusedUpdated.palette[0] as { color: string }).color = '#123456';
    unusedUpdated.revision += 1;
    renderer.setDocument(unusedUpdated);
    renderer.renderNow();
    expect(builds).toBe(2);
    expect(sources[1].records.some((call) => call.name === 'fillRect' && call.fillStyle === '#123456')).toBe(true);
    renderer.dispose();
  });

  it('keeps compact geometry and Symbol glyphs while Combined remains detail-only', () => {
    const compactContext = recordingContext();
    const compactDocument = chart(5, 5);
    compactDocument.palette[0] = { ...compactDocument.palette[0], symbol: '☆' };
    compactDocument.kind[0] = CellKind.Full;
    compactDocument.colors[0] = 1;
    compactDocument.completed[0] = 1;
    const compact = createCanvasRenderer({
      document: compactDocument,
      targets: { base: target(compactContext), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(40, 40),
      viewport: { x: 0, y: 0, zoom: 8 },
      style: { mode: 'symbol', gridInterval: 2 }
    });
    compact.renderNow();

    const compactCombinedContext = recordingContext();
    const compactCombined = createCanvasRenderer({
      document: compactDocument,
      targets: { base: target(compactCombinedContext), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(40, 40),
      viewport: { x: 0, y: 0, zoom: 8 },
      style: { mode: 'combined', gridInterval: 2 }
    });
    compactCombined.renderNow();

    const detailContext = recordingContext();
    const detail = createCanvasRenderer({
      document: compactDocument,
      targets: { base: target(detailContext), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(64, 64),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { mode: 'combined', gridInterval: 2 }
    });
    detail.renderNow();
    expect(compact.lastStats.lod).toBe('compact');
    expect(compactCombined.lastStats.lod).toBe('compact');
    expect(detail.lastStats.lod).toBe('detail');
    expect(compactContext.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    expect(compactCombinedContext.records.some((call) => call.name === 'fillText')).toBe(false);
    expect(detailContext.records.some((call) => call.name === 'fillText')).toBe(true);
    expect(compactContext.records.some((call) => call.name === 'stroke' && call.strokeStyle === '#d8d8d8')).toBe(false);
    expect(compactCombinedContext.records.some((call) => call.name === 'stroke' && call.strokeStyle === '#d8d8d8')).toBe(false);
    expect(detailContext.records.some((call) => call.name === 'stroke' && call.strokeStyle === '#d8d8d8')).toBe(true);
    expect(detailContext.records.some((call) => call.name === 'stroke' && call.strokeStyle === '#d8d8d8' && call.lineWidth === 0.35)).toBe(true);
    expect(detailContext.records.filter((call) => call.name === 'stroke').length).toBeGreaterThan(compactCombinedContext.records.filter((call) => call.name === 'stroke').length);
    expect(compactContext.records.some((call) => call.name === 'fillRect' && call.globalAlpha === 0.62)).toBe(true);
    compact.dispose();
    compactCombined.dispose();
    detail.dispose();
  });

  it('draws the 5-cell highlight tier between the stitch grid and the 10-cell grid', () => {
    const document = chart(20, 10);
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(320, 160, { dpr: 2 }),
      viewport: { x: 0, y: 0, zoom: 20 },
      style: { gridColor: '#00ff00', midGridColor: '#0000ff', majorGridColor: '#ff0000', gridInterval: 10, midGridInterval: 5 }
    });
    renderer.renderNow();
    // Mid-grid lines use the distinct mid color and the middle width tier.
    const midSegments = base.records.filter((call) => call.name === 'lineTo' && call.strokeStyle === '#0000ff');
    expect(midSegments.length).toBe(4); // x at 5,10,15 and y at 5.
    expect(new Set(midSegments.map((call) => call.lineWidth))).toEqual(new Set([1]));
    const baselineSegments = base.records.filter((call) => call.name === 'lineTo' && call.strokeStyle === '#00ff00');
    const majorSegments = base.records.filter((call) => call.name === 'lineTo' && call.strokeStyle === '#ff0000');
    expect(baselineSegments.length).toBeGreaterThan(0);
    expect(new Set(baselineSegments.map((call) => call.lineWidth))).toEqual(new Set([0.35]));
    expect(majorSegments.length).toBeGreaterThan(0);
    expect(new Set(majorSegments.map((call) => call.lineWidth))).toEqual(new Set([2.5]));
    const midLineTos = midSegments.map((call) => call.args as number[]);
    // Vertical lines span the clipped chart height at x=100,200,300; horizontal spans the canvas width at y=100.
    const verticals = midLineTos.filter(([x]) => x === 100 || x === 200 || x === 300);
    expect(verticals.length).toBe(3);
    for (const [, y] of verticals) expect(y).toBe(160);
    const horizontal = midLineTos.find(([x, y]) => x === 320 && y === 100);
    expect(horizontal).toBeDefined();
    // No mid line at the document edges: the only mid segments are the three
    // verticals at interior multiples of 5 (x=100,200,300 for cells 5,10,15)
    // and the single horizontal at y=100 (cell 5). No vertical at x=0/x=400.
    const midMoves = base.records
      .filter((call) => call.name === 'moveTo' && call.strokeStyle === '#0000ff')
      .map((call) => call.args as number[]);
    const verticalMoves = midMoves.filter(([, y]) => y === 0 || y === 160);
    const verticalMoveXs = verticalMoves.map(([x]) => x).sort((a, b) => a - b);
    expect(verticalMoveXs).toEqual([100, 200, 300]);
    renderer.dispose();
  });

  it('drops the 1-cell tier in compact LOD while retaining the 10-cell grid', () => {
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document: chart(20, 10),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(80, 40),
      viewport: { x: 0, y: 0, zoom: 8 },
      style: { gridColor: '#00ff00', midGridColor: '#0000ff', majorGridColor: '#ff0000', gridInterval: 10, midGridInterval: 5 }
    });
    renderer.renderNow();

    const gridLines = base.records.filter((call) => call.name === 'stroke');
    expect(gridLines.some((call) => call.strokeStyle === '#00ff00')).toBe(false);
    expect(gridLines.some((call) => call.strokeStyle === '#ff0000')).toBe(true);
    renderer.dispose();
  });

  it('shows every grid tier at and above 120% of the rectangular fit zoom', () => {
    const document = chart(20, 10);
    const metrics = getCanvasMetrics(640, 320, { dpr: 2 });
    const fitZoom = fitViewport(document, metrics, 0).zoom;
    const cases = [
      { ratio: 1, visible: false },
      { ratio: 1.1999, visible: false },
      { ratio: 1.2, visible: true },
      { ratio: 1.2001, visible: true }
    ];

    for (const { ratio, visible } of cases) {
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics,
        viewport: { x: 0, y: 0, zoom: fitZoom * ratio },
        style: { gridColor: '#00ff00', midGridColor: '#0000ff', majorGridColor: '#ff0000', gridInterval: 10, midGridInterval: 5 }
      });
      renderer.renderNow();
      const gridRecords = base.records.filter((call) =>
        call.name === 'stroke' && (call.strokeStyle === '#00ff00' || call.strokeStyle === '#0000ff' || call.strokeStyle === '#ff0000')
      );
      if (visible) {
        expect(gridRecords.some((call) => call.strokeStyle === '#ff0000')).toBe(true);
        expect(gridRecords.some((call) => call.strokeStyle === '#0000ff')).toBe(true);
      } else {
        expect(gridRecords).toEqual([]);
      }
      renderer.dispose();
    }
  });

  it('omits the 5-cell tier at overview zoom and on tiny charts', () => {
    const overview = recordingContext();
    const renderer = createCanvasRenderer({
      document: chart(100, 100),
      targets: { base: target(overview), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(40, 32, { dpr: 2 }),
      viewport: { x: 3.25, y: 4.5, zoom: 1 },
      style: { midGridColor: '#0000ff' }
    });
    renderer.renderNow();
    expect(overview.records.some((call) => call.strokeStyle === '#0000ff')).toBe(false);
    renderer.dispose();

    const tiny = recordingContext();
    const tinyRenderer = createCanvasRenderer({
      document: chart(4, 3),
      targets: { base: target(tiny), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(64, 48, { dpr: 1 }),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { midGridColor: '#0000ff' }
    });
    tinyRenderer.renderNow();
    // 4x3 chart has no interior multiples of 5 (5 > 4 and 5 > 3), so no mid lines.
    expect(tiny.records.some((call) => call.strokeStyle === '#0000ff')).toBe(false);
    tinyRenderer.dispose();
  });

  it('keeps grid coordinates inside the pattern and canvas bounds at every LOD and DPR', () => {
    const cases = [
      { name: 'overview', document: chart(100, 100), metrics: getCanvasMetrics(40, 32, { dpr: 2 }), viewport: { x: 3.25, y: 4.5, zoom: 1 }, grid: true },
      { name: 'compact', document: chart(7, 7), metrics: getCanvasMetrics(40, 32, { dpr: 1.5 }), viewport: { x: 0.25, y: 0.5, zoom: 8 }, grid: true },
      { name: 'detail', document: chart(3, 3), metrics: getCanvasMetrics(40, 32, { dpr: 2 }), viewport: { x: 0, y: 0, zoom: 16 }, grid: true },
      { name: 'centered pattern', document: chart(2, 2), metrics: getCanvasMetrics(80, 60, { dpr: 2 }), viewport: { x: 0, y: 0, zoom: 40 }, grid: true }
    ];

    for (const testCase of cases) {
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document: testCase.document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: testCase.metrics,
        viewport: testCase.viewport,
        style: { gridColor: '#00ff00', majorGridColor: '#ff0000', gridInterval: 2 }
      });
      renderer.renderNow();

      const pattern = cellToScreenRect({ x: 0, y: 0, width: testCase.document.width, height: testCase.document.height }, renderer.getViewport());
      const left = Math.max(0, pattern.x);
      const right = Math.min(testCase.metrics.cssWidth, pattern.x + pattern.width);
      const top = Math.max(0, pattern.y);
      const bottom = Math.min(testCase.metrics.cssHeight, pattern.y + pattern.height);
      const gridCoordinates = base.records
        .filter((call) => call.name === 'moveTo' || call.name === 'lineTo')
        .filter((call) => call.strokeStyle === '#00ff00' || call.strokeStyle === '#ff0000')
        .flatMap((call) => [call.args as number[]]);


      if (testCase.grid) expect(gridCoordinates.length, testCase.name).toBeGreaterThan(0);
      else expect(gridCoordinates, testCase.name).toEqual([]);
      for (const [x, y] of gridCoordinates) {
        expect(x, `${testCase.name} grid x`).toBeGreaterThanOrEqual(left);
        expect(x, `${testCase.name} grid x`).toBeLessThanOrEqual(right);
        expect(y, `${testCase.name} grid y`).toBeGreaterThanOrEqual(top);
        expect(y, `${testCase.name} grid y`).toBeLessThanOrEqual(bottom);
      }
      renderer.dispose();
    }
  });

  it('clips interaction overlays to the visible PatternDocument rectangle', () => {
    const document = chart(4, 3);
    const overlay = recordingContext();
    const metrics = getCanvasMetrics(80, 60, { dpr: 2 });
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics,
      viewport: { x: 0, y: 0, zoom: 10 },
      overlay: {
        pendingCells: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 3, y: 2 }, { x: 4, y: 3 }],
        backstitchPreview: { start: { x: -8, y: -4 }, end: { x: 24, y: 16 } },
        selection: { x: -2, y: -1, width: 8, height: 6 },
        cursor: { x: 3, y: 2 }
      }
    });
    renderer.renderNow();

    const pattern = cellToScreenRect({ x: 0, y: 0, width: document.width, height: document.height }, renderer.getViewport());
    const left = Math.max(0, pattern.x);
    const right = Math.min(metrics.cssWidth, pattern.x + pattern.width);
    const top = Math.max(0, pattern.y);
    const bottom = Math.min(metrics.cssHeight, pattern.y + pattern.height);
    const coordinates = overlay.records
      .filter((call) => ['fillRect', 'strokeRect', 'moveTo', 'lineTo'].includes(call.name))
      .flatMap((call) => {
        if (call.name === 'fillRect' || call.name === 'strokeRect') {
          const [x, y, width, height] = call.args as number[];
          return [[x, y], [x + width, y + height]];
        }
        return [call.args as number[]];
      });

    expect(overlay.records.some((call) => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0)).toBe(true);
    expect(overlay.records.some((call) => call.name === 'strokeRect' && call.args[0] === left && call.args[1] === top)).toBe(true);
    expect(overlay.records.some((call) => call.name === 'strokeRect' && call.args[0] === 30 && call.args[1] === 20)).toBe(true);
    for (const [x, y] of coordinates) {
      expect(x).toBeGreaterThanOrEqual(left);
      expect(x).toBeLessThanOrEqual(right);
      expect(y).toBeGreaterThanOrEqual(top);
      expect(y).toBeLessThanOrEqual(bottom);
    }
    renderer.dispose();
  });

  it('renders live lasso paths and sparse exterior/interior boundaries inside the chart', () => {
    const document = chart(3, 3);
    const overlay = recordingContext();
    const geometry = sparseSelectionGeometry(new Uint32Array([0, 1, 2, 3, 5, 6, 7, 8]), 3, 3)!;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(30, 30),
      viewport: { x: 0, y: 0, zoom: 10 },
      overlay: {
        selection: { rect: geometry.bounds, kind: 'sparse', indices: Array.from(geometry.indices), boundaries: geometry.boundaries },
        lassoPath: { points: [{ x: 0.5, y: 0.5 }, { x: -1, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] }
      }
    });
    renderer.renderNow();

    expect(overlay.records.some((call) => call.name === 'setLineDash')).toBe(true);
    expect(overlay.records.filter((call) => call.name === 'stroke' && call.strokeStyle === '#2266cc').length).toBe(19);
    expect(overlay.records.some((call) => call.name === 'moveTo' && call.args.join(',') === '10,10')).toBe(true);
    for (const call of overlay.records.filter((entry) => ['moveTo', 'lineTo'].includes(entry.name))) {
      const points = call.name === 'moveTo' || call.name === 'lineTo' ? [call.args as number[]] : [[call.args[0] as number, call.args[1] as number]];
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(30);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(30);
      }
    }
    renderer.dispose();
  });

  it('renders exact sparse pending after-states for full, half, erase, legacy, and no-op cells', () => {
    const document = chart(6, 1);
    document.kind[3] = CellKind.Full;
    document.colors[3 * 4] = 35;
    document.kind[4] = CellKind.Quarters;
    document.colors.set([1, 35, 1, 35], 4 * 4);
    document.kind[5] = CellKind.Full;
    document.colors[5 * 4] = 35;
    const pendingCellStates: PendingCellState[] = [
      { index: 0, cell: { x: 0, y: 0 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 1, cell: { x: 1, y: 0 }, kind: CellKind.HalfBackslash, colors: [1, 0, 0, 0], completed: 0 },
      { index: 2, cell: { x: 2, y: 0 }, kind: CellKind.HalfSlash, colors: [35, 0, 0, 0], completed: 0 },
      { index: 3, cell: { x: 3, y: 0 }, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 },
      { index: 4, cell: { x: 4, y: 0 }, kind: CellKind.Quarters, colors: [1, 0, 1, 0], completed: 0 }
    ];
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(96, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        pendingCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 }],
        pendingCellStates
      }
    });
    renderer.renderNow();

    const fillRects = overlay.records.filter((call) => call.name === 'fillRect');
    const paths = overlay.records.filter((call) => call.name === 'moveTo' || call.name === 'lineTo');
    const halfLeg = 16 * Math.SQRT1_2;
    expect(fillRects.some((call) => call.args.join(',') === '0,0,16,16' && call.fillStyle === '#f00')).toBe(true);
    expect(paths.some((call) => call.name === 'moveTo' && call.args.join(',') === '16,0' && call.fillStyle === '#f00')).toBe(true);
    expect(paths.some((call) => call.name === 'lineTo' && call.args[0] === 16 - halfLeg + 16 && call.args[1] === 0 && call.fillStyle === '#f00')).toBe(true);
    expect(paths.some((call) => call.name === 'moveTo' && call.args[0] === 32 + halfLeg && call.args[1] === 0 && call.fillStyle === '#00f')).toBe(true);
    expect(paths.some((call) => call.name === 'lineTo' && call.args.join(',') === '32,16' && call.fillStyle === '#00f')).toBe(true);
    expect(fillRects.some((call) => call.args.join(',') === '48,0,16,16' && call.fillStyle === '#ffffff')).toBe(true);
    expect(paths.some((call) => call.name === 'moveTo' && call.args[0] === 48 && (call.strokeStyle === '#f00' || call.strokeStyle === '#00f'))).toBe(false);
    expect(paths.some((call) => call.name === 'moveTo' && call.args.join(',') === '64,0' && call.fillStyle === '#f00')).toBe(true);
    expect(paths.some((call) => call.name === 'moveTo' && call.args.join(',') === '80,16' && call.fillStyle === '#f00')).toBe(true);
    expect(paths.some((call) => call.fillStyle === '#00f' && Number(call.args[0]) >= 64)).toBe(false);
    expect(fillRects.some((call) => call.args[0] === 80)).toBe(false);
    renderer.dispose();
  });

  it('repaints affected grid and crossing backstitches above a pending mask', () => {
    const document = chart(3, 1);
    document.kind[1] = CellKind.Full;
    document.colors[4] = 35;
    document.backstitches = {
      ids: new Uint32Array([1, 2]),
      x1: new Uint32Array([2, 9]),
      y1: new Uint32Array([2, 2]),
      x2: new Uint32Array([6, 11]),
      y2: new Uint32Array([2, 2]),
      colors: new Uint16Array([35, 35]),
      completed: new Uint8Array([0, 0])
    };
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 20),
      viewport: { x: 0, y: 0, zoom: 20 },
      style: { gridColor: '#00aa00', majorGridColor: '#00aa00', gridInterval: 1 },
      overlay: {
        pendingCells: [{ x: 1, y: 0 }],
        pendingCellStates: [{ index: 1, cell: { x: 1, y: 0 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }]
      }
    });
    renderer.renderNow();

    const maskIndex = overlay.records.findIndex((call) => call.name === 'fillRect' && call.args.join(',') === '20,0,20,20' && call.fillStyle === '#ffffff');
    const stateIndex = overlay.records.findIndex((call) => call.name === 'fillRect' && call.args.join(',') === '20,0,20,20' && call.fillStyle === '#f00');
    const gridIndices = overlay.records
      .map((call, index, records) => call.name === 'moveTo' && call.strokeStyle === '#00aa00' && records[index + 1]?.name === 'lineTo' && records[index + 2]?.name === 'stroke' ? index : -1)
      .filter((index) => index >= 0);
    const backstitchIndices = overlay.records
      .map((call, index, records) => call.name === 'moveTo' && call.strokeStyle === '#00f' && records[index + 1]?.name === 'lineTo' && records[index + 2]?.name === 'stroke' ? index : -1)
      .filter((index) => index >= 0);
    expect(maskIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeGreaterThan(maskIndex);
    expect(gridIndices.length).toBe(4);
    expect(backstitchIndices).toHaveLength(1);
    expect(gridIndices[0]).toBeGreaterThan(stateIndex);
    expect(backstitchIndices[0]).toBeGreaterThan(gridIndices.at(-1) ?? -1);
    for (const index of gridIndices) {
      const from = overlay.records[index].args as number[];
      const to = overlay.records[index + 1].args as number[];
      expect(overlay.records[index + 1].name).toBe('lineTo');
      expect(from[0]).toBeGreaterThanOrEqual(20);
      expect(from[0]).toBeLessThanOrEqual(40);
      expect(to[0]).toBeGreaterThanOrEqual(20);
      expect(to[0]).toBeLessThanOrEqual(40);
      expect(from[1]).toBeGreaterThanOrEqual(0);
      expect(from[1]).toBeLessThanOrEqual(20);
      expect(to[1]).toBeGreaterThanOrEqual(0);
      expect(to[1]).toBeLessThanOrEqual(20);
    }
    renderer.dispose();
  });

  it('clips pending backstitch repairs to the sparse pending-cell union', () => {
    const document = chart(4, 1);
    document.kind[1] = CellKind.Full;
    document.colors[4] = 1;
    document.kind[3] = CellKind.Full;
    document.colors[12] = 1;
    document.backstitches = {
      ids: new Uint32Array([1, 2]),
      x1: new Uint32Array([2, 9]),
      y1: new Uint32Array([2, 2]),
      x2: new Uint32Array([14, 11]),
      y2: new Uint32Array([2, 2]),
      colors: new Uint16Array([35, 35]),
      completed: new Uint8Array([0, 0])
    };
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(64, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { gridColor: '#00aa00', majorGridColor: '#00aa00', gridInterval: 1 },
      overlay: {
        pendingCellStates: [
          { index: 1, cell: { x: 1, y: 0 }, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 },
          { index: 3, cell: { x: 3, y: 0 }, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }
        ]
      }
    });
    renderer.renderNow();

    const backstitchMoves = overlay.records
      .filter((call, index, records) => call.name === 'moveTo' && call.strokeStyle === '#00f' && records[index + 1]?.name === 'lineTo' && records[index + 2]?.name === 'stroke')
      .map((call) => call.args as number[]);
    const backstitchLines = overlay.records
      .filter((call, index, records) => call.name === 'lineTo' && call.strokeStyle === '#00f' && records[index - 1]?.name === 'moveTo' && records[index + 1]?.name === 'stroke')
      .map((call) => call.args as number[]);
    expect(backstitchMoves).toEqual([[16, 8], [48, 8]]);
    expect(backstitchLines).toEqual([[32, 8], [56, 8]]);
    expect(backstitchMoves.some(([x]) => x === 8)).toBe(false);
    for (const [x, y] of [...backstitchMoves, ...backstitchLines]) {
      expect(y).toBe(8);
      expect(x === 16 || x === 32 || x === 48 || x === 56).toBe(true);
    }
    renderer.dispose();
  });

  it('omits pending backstitch repair at overview LOD', () => {
    const document = chart(2, 1);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    document.backstitches = {
      ids: new Uint32Array([1]),
      x1: new Uint32Array([0]),
      y1: new Uint32Array([2]),
      x2: new Uint32Array([8]),
      y2: new Uint32Array([2]),
      colors: new Uint16Array([35]),
      completed: new Uint8Array([0])
    };
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { gridColor: '#00aa00', majorGridColor: '#00aa00' },
      overlay: {
        pendingCellStates: [{ index: 0, cell: { x: 0, y: 0 }, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }]
      }
    });
    expect(renderer.renderNow().lod).toBe('overview');
    expect(overlay.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#00f')).toBe(false);
    expect(overlay.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#00aa00')).toBe(false);
    renderer.dispose();
  });

  it('keeps color presentation distinct while Symbol Overview paints actual glyphs', () => {
    const modeColor = (mode: 'color' | 'grayscale' | 'symbol' | 'combined'): string => {
      const atlasContext = recordingContext();
      const renderer = createCanvasRenderer({
        document: chart(1, 1),
        targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(20, 20),
        viewport: { x: 0, y: 0, zoom: 1 },
        style: { mode },
        atlasTargetFactory: () => target(atlasContext, new FakeCanvasImageSource(1, 1))
      });
      renderer.getDocument().kind[0] = CellKind.Full;
      renderer.getDocument().colors[0] = 1;
      renderer.renderNow();
      renderer.dispose();
      const stitch = atlasContext.records.filter((call) => call.name === 'fillRect').at(-1);
      return stitch?.fillStyle ?? '';
    };
    const color = modeColor('color');
    const grayscale = modeColor('grayscale');
    const combined = modeColor('combined');
    expect(color).toBe('#f00');
    expect(grayscale).toMatch(/^#([0-9a-f]{2})\1\1$/i);
    expect(combined).not.toBe(color);
    expect(combined).not.toBe(grayscale);

    const sourceContext = recordingContext();
    const base = recordingContext();
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const symbolRenderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 20),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: {
        mode: 'symbol',
        symbolColor: '#123456',
        symbolBackgroundColor: '#abcdef'
      },
      atlasTargetFactory: (width, height) => target(sourceContext, new FakeCanvasImageSource(width, height))
    });
    symbolRenderer.renderNow();
    expect(base.records.some((call) => call.name === 'drawImage')).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillText' && call.fillStyle === '#123456')).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#abcdef')).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillRect' && call.fillStyle !== '#abcdef')).toBe(false);
    symbolRenderer.dispose();
  });

  it('preserves a custom Symbol glyph at Detail, Compact, and Overview zooms', () => {
    const render = (zoom: number): { base: RecordingContext; source: RecordingContext } => {
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol: '☆' };
      document.kind[0] = CellKind.Full;
      document.colors[0] = 1;
      const base = recordingContext();
      const source = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(32, 32),
        viewport: { x: 0, y: 0, zoom },
        style: { mode: 'symbol' },
        atlasTargetFactory: (width, height) => target(source, new FakeCanvasImageSource(width, height))
      });
      renderer.renderNow();
      renderer.dispose();
      return { base, source };
    };

    const detail = render(16);
    const compact = render(8);
    const overview = render(1);
    expect(detail.base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    expect(compact.base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    expect(overview.base.records.some((call) => call.name === 'drawImage')).toBe(true);
    expect(overview.base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(false);
    expect(overview.source.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
  });

  it('keeps Symbol glyph behavior at every LOD threshold boundary', () => {
    for (const [zoom, expectedLod] of [[3.99, 'overview'], [4, 'compact'], [11.99, 'compact'], [12, 'detail']] as const) {
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol: '☆' };
      document.kind[0] = CellKind.Full;
      document.colors[0] = 1;
      const base = recordingContext();
      const source = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(32, 32),
        viewport: { x: 0, y: 0, zoom },
        style: { mode: 'symbol' },
        atlasTargetFactory: (width, height) => target(source, new FakeCanvasImageSource(width, height))
      });
      expect(renderer.renderNow().lod).toBe(expectedLod);
      if (expectedLod === 'overview') {
        expect(source.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
        expect(base.records.some((call) => call.name === 'drawImage')).toBe(true);
      } else {
        expect(base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
      }
      renderer.dispose();
    }
  });

  it('reuses the Symbol overview atlas across viewport, grid, and overlay changes', () => {
    const document = chart(2, 2);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const sources: RecordingContext[] = [];
    let builds = 0;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol' },
      atlasTargetFactory: (width, height) => {
        builds += 1;
        const source = recordingContext();
        sources.push(source);
        return target(source, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    expect(builds).toBe(1);
    const firstSourceGlyphs = sources[0].records.filter((call) => call.name === 'fillText').length;

    const completionOnlyDocument = {
      ...document,
      completed: document.completed.slice(),
      revision: document.revision + 1
    };
    renderer.setDocument(completionOnlyDocument);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records.filter((call) => call.name === 'fillText')).toHaveLength(firstSourceGlyphs);
    const firstDrawImages = base.records.filter((call) => call.name === 'drawImage').length;

    renderer.setViewport({ x: 0.25, y: 0.1, zoom: 2 });
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records.filter((call) => call.name === 'fillText')).toHaveLength(firstSourceGlyphs);
    expect(base.records.filter((call) => call.name === 'drawImage').length).toBe(firstDrawImages + 1);

    renderer.setOverlay({ cursor: { x: 0, y: 0 } });
    renderer.renderNow();
    renderer.setStyle({ showGrid: false });
    renderer.renderNow();
    expect(builds).toBe(1);

    const changedDocument = chart(2, 2);
    changedDocument.palette[0] = { ...changedDocument.palette[0], symbol: '☆' };
    changedDocument.kind[0] = CellKind.Full;
    changedDocument.colors[0] = 1;
    changedDocument.revision = document.revision + 1;
    renderer.setDocument(changedDocument);
    renderer.renderNow();
    expect(builds).toBe(2);

    for (const styleChange of [
      { symbolFont: '600 0.8em sans-serif' },
      { symbolColor: '#123456' },
      { symbolBackgroundColor: '#abcdef' },
      { showSymbols: false }
    ]) {
      renderer.setStyle(styleChange);
      renderer.renderNow();
    }
    expect(builds).toBe(6);
    renderer.dispose();
  });

  it('reuses the Symbol overview atlas for unused palette changes but rebuilds for a used symbol mutation', () => {
    const document = chart(2, 2);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    const sources: RecordingContext[] = [];
    let builds = 0;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol' },
      atlasTargetFactory: (width, height) => {
        builds += 1;
        const source = recordingContext();
        sources.push(source);
        return target(source, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    const firstSourceGlyphs = sources[0].records.filter((call) => call.name === 'fillText').length;

    const appended = {
      ...document,
      palette: [...document.palette, { ...document.palette[1], id: 99, name: 'Unused', symbol: '◇' }],
      revision: document.revision + 1
    };
    renderer.setDocument(appended);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records.filter((call) => call.name === 'fillText')).toHaveLength(firstSourceGlyphs);

    const unusedUpdated = {
      ...appended,
      palette: appended.palette.map((entry) => entry.id === 99 ? { ...entry, symbol: '◈' } : entry),
      revision: appended.revision + 1
    };
    renderer.setDocument(unusedUpdated);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(sources[0].records.filter((call) => call.name === 'fillText')).toHaveLength(firstSourceGlyphs);

    (unusedUpdated.palette[0] as { symbol: string }).symbol = '★';
    unusedUpdated.revision += 1;
    renderer.setDocument(unusedUpdated);
    renderer.renderNow();
    expect(builds).toBe(2);
    expect(sources[1].records.some((call) => call.name === 'fillText' && call.args[0] === '★')).toBe(true);
    renderer.dispose();
  });

  it('falls back to direct Symbol glyphs when overview atlas allocation fails', () => {
    const base = recordingContext();
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol', symbolColor: '#123456', symbolBackgroundColor: '#abcdef' },
      atlasTargetFactory: () => undefined
    });
    expect(() => renderer.renderNow()).not.toThrow();
    expect(base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#abcdef')).toBe(true);
    expect(base.records.filter((call) => call.name === 'fillRect').every((call) => call.fillStyle === '#ffffff' || call.fillStyle === '#abcdef')).toBe(true);
    renderer.dispose();
  });

  it('falls back to direct Symbol glyphs when the atlas context cannot paint text', () => {
    const base = recordingContext();
    const source = recordingContext();
    source.fillText = undefined;
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol' },
      atlasTargetFactory: (width, height) => target(source, new FakeCanvasImageSource(width, height))
    });
    expect(() => renderer.renderNow()).not.toThrow();
    expect(base.records.some((call) => call.name === 'fillText' && call.args[0] === '☆')).toBe(true);
    expect(base.records.some((call) => call.name === 'drawImage')).toBe(false);
    renderer.dispose();
  });

  it('keeps Symbol geometry when neither atlas nor base text painting is available', () => {
    const base = recordingContext();
    base.fillText = undefined;
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol', symbolBackgroundColor: '#abcdef' },
      atlasTargetFactory: () => undefined
    });
    expect(() => renderer.renderNow()).not.toThrow();
    expect(base.records.some((call) => call.name === 'fillText')).toBe(false);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#abcdef')).toBe(true);
    expect(base.records.filter((call) => call.name === 'fillRect').every((call) => call.fillStyle === '#ffffff' || call.fillStyle === '#abcdef')).toBe(true);
    renderer.dispose();
  });

  it('keeps the dense 1000x1000 Symbol overview source within the pixel budget and cached', () => {
    const document = chart(1000, 1000);
    document.palette[0] = { ...document.palette[0], symbol: '☆' };
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const base = recordingContext();
    let builds = 0;
    let allocation: { width: number; height: number } | undefined;
    let source: RecordingContext | undefined;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 32),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode: 'symbol' },
      atlasTargetFactory: (width, height) => {
        builds += 1;
        allocation = { width, height };
        source = recordingContext();
        expect(width * height).toBeLessThanOrEqual(MAX_ATLAS_PIXELS);
        return target(source, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    expect(allocation).toEqual({ width: 4000, height: 4000 });
    expect(builds).toBe(1);
    const sourceGlyphs = source?.records.filter((call) => call.name === 'fillText').length;
    renderer.setViewport({ x: 0, y: 0, zoom: 2 });
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(source?.records.filter((call) => call.name === 'fillText').length).toBe(sourceGlyphs);
    renderer.dispose();
  });

  it('creates a real default atlas source when OffscreenCanvas is available', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: FakeOffscreenCanvas
    });
    try {
      const atlas = createDefaultAtlasTarget(8, 8);
      expect(atlas).toBeDefined();
      expect(isCanvasImageSource(atlas?.source)).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'OffscreenCanvas', original);
      else delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    }
  });

  it('draws resize-mode corner handles on the overlay canvas at the projected image corners', () => {
    const source = { width: 20, height: 10 };
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document: chart(2, 1),
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      traceImage: { source, width: 20, height: 10, chartBounds: { x: 0, y: 0, width: 2, height: 1 } }
    });
    renderer.setOverlay({ imageResizeHandles: true });
    renderer.renderNow();
    const handles = overlay.records.filter((call) => call.name === 'fillRect' && call.args[2] === 8 && call.args[3] === 8);
    // Corners at (0,0),(32,0),(0,16),(32,16); each 8x8 square centered there.
    expect(handles).toHaveLength(4);
    expect(handles[0]).toMatchObject({ fillStyle: 'rgba(255, 255, 255, 0.95)', args: [-4, -4, 8, 8] });
    expect(overlay.records.some((call) => call.name === 'strokeRect')).toBe(true);
    renderer.setOverlay({});
    renderer.dispose();
  });

  it('renders and disposes a trace image through the base renderer API', () => {
    const base = recordingContext();
    let disposed = 0;
    const source = { width: 20, height: 10 };
    const trace: TraceImage = { source, width: 20, height: 10, opacity: 0.5, dispose: () => { disposed += 1; } };
    const renderer = createCanvasRenderer({
      document: chart(2, 1),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16, { dpr: 2 }),
      viewport: { x: 0, y: 0, zoom: 16 },
      traceImage: trace
    });
    renderer.renderNow();
    const image = base.records.find((call) => call.name === 'drawImage');
    expect(image?.args).toEqual([source, 0, 0, 20, 10, 0, 0, 32, 16]);
    expect(image?.globalAlpha).toBe(0.5);
    expect(renderer.getTraceImage()).toBe(trace);
    renderer.clearTraceImage();
    expect(disposed).toBe(1);
    renderer.renderNow();
    renderer.dispose();
    expect(disposed).toBe(1);
  });

  it('keeps bitmap ownership across trace presentation updates and closes once on replacement', () => {
    const source = { width: 20, height: 10 };
    let closes = 0;
    const dispose = () => { closes += 1; };
    const renderer = createCanvasRenderer({
      document: chart(2, 1),
      targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      traceImage: { source, width: 20, height: 10, visible: true, opacity: 1, dispose }
    });
    renderer.setTraceImage({ source, width: 20, height: 10, visible: false, opacity: 0, dispose });
    expect(closes).toBe(0);
    renderer.setTraceImage({ source: { width: 20, height: 10 }, width: 20, height: 10, dispose });
    expect(closes).toBe(1);
    renderer.clearTraceImage();
    expect(closes).toBe(2);
    renderer.dispose();
    expect(closes).toBe(2);
  });

  it('keeps Overview trace pixels above committed atlas cells and preserves empty background', () => {
    const base = recordingContext();
    const atlas = recordingContext();
    const traceSource = { width: 20, height: 10 };
    const renderer = createCanvasRenderer({
      document: chart(2, 1),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 10),
      viewport: { x: 0, y: 0, zoom: 1 },
      traceImage: { source: traceSource, width: 20, height: 10 },
      atlasTargetFactory: (width, height) => target(atlas, new FakeCanvasImageSource(width, height))
    });
    renderer.renderNow();
    const images = base.records.filter((call) => call.name === 'drawImage');
    expect(images).toHaveLength(2);
    expect(images[0].args[0]).toBeInstanceOf(FakeCanvasImageSource);
    expect(images[1].args[0]).toBe(traceSource);
    expect(atlas.records.some((call) => call.name === 'fillRect')).toBe(false);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#ffffff' && call.args.join(',') === '0,0,20,10')).toBe(true);
    renderer.dispose();
  });

  it('draws the trace after regular cells, grid, chart border, and backstitches', () => {
    const base = recordingContext();
    const traceSource = { width: 32, height: 16 };
    const document = chart(2, 1);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    document.backstitches = {
      ids: new Uint32Array([1]),
      x1: new Uint32Array([0]),
      y1: new Uint32Array([2]),
      x2: new Uint32Array([16]),
      y2: new Uint32Array([2]),
      colors: new Uint16Array([1]),
      completed: new Uint8Array([0])
    };
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      traceImage: { source: traceSource, width: 32, height: 16 }
    });

    const stats = renderer.renderNow();
    expect(stats.lod).not.toBe('overview');
    expect(stats.drawnBackstitches).toBe(1);
    const traceIndex = base.records.findIndex((call) => call.name === 'drawImage' && call.args[0] === traceSource);
    const committedPaintIndices = base.records
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => ['fillRect', 'fill', 'fillText', 'stroke', 'strokeRect', 'moveTo', 'lineTo'].includes(call.name))
      .map(({ index }) => index);
    expect(traceIndex).toBeGreaterThan(Math.max(...committedPaintIndices));
    renderer.dispose();
  });

  it('falls back without ever passing an invalid atlas object to drawImage', () => {
    const base = recordingContext();
    const document = chart(2, 2);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 20),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: () => undefined
    });
    const stats = renderer.renderNow();
    expect(stats.lod).toBe('overview');
    expect(stats.visitedCells).toBe(4);
    expect(base.records.some((call) => call.name === 'drawImage')).toBe(false);
    renderer.dispose();
  });

  it('keeps large-pattern work bounded to visible cells and atlas dimensions', () => {
    for (const size of [500, 1000]) {
      const document = chart(size, size);
      const detail = createCanvasRenderer({
        document,
        targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(500, 500),
        viewport: { x: 0, y: 0, zoom: 16 }
      });
      expect(detail.renderNow().visitedCells).toBe(visibleCellRect(detail.getViewport(), getCanvasMetrics(500, 500), document).width * visibleCellRect(detail.getViewport(), getCanvasMetrics(500, 500), document).height);
      detail.dispose();

      const compact = createCanvasRenderer({
        document,
        targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(500, 500),
        viewport: { x: 0, y: 0, zoom: 8 }
      });
      expect(compact.renderNow().visitedCells).toBe(visibleCellRect(compact.getViewport(), getCanvasMetrics(500, 500), document).width * visibleCellRect(compact.getViewport(), getCanvasMetrics(500, 500), document).height);
      compact.dispose();

      let allocation: { width: number; height: number } | undefined;
      const overview = createCanvasRenderer({
        document,
        targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(500, 500),
        viewport: { x: 0, y: 0, zoom: 1 },
        atlasTargetFactory: (width, height) => {
          allocation = { width, height };
          expect(width * height).toBeLessThanOrEqual(MAX_ATLAS_PIXELS);
          return target(recordingContext(), new FakeCanvasImageSource(width, height));
        }
      });
      expect(overview.renderNow().lod).toBe('overview');
      expect(allocation).toEqual({ width: size, height: size });
      overview.dispose();
    }
  });

  it('keeps an adaptive overview grid visible and bounded at low zoom', () => {
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document: chart(1_000, 1_000),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(160, 120),
      viewport: { x: 500, y: 500, zoom: 0.15 },
      atlasTargetFactory: (width, height) => target(recordingContext(), new FakeCanvasImageSource(width, height)),
      style: { gridColor: '#00ff00', majorGridColor: '#ff0000' }
    });

    expect(renderer.renderNow().lod).toBe('overview');
    const gridLines = base.records.filter((call) =>
      (call.name === 'moveTo' || call.name === 'lineTo')
      && (call.strokeStyle === '#00ff00' || call.strokeStyle === '#ff0000')
    );
    expect(gridLines.length).toBeGreaterThan(0);
    expect(gridLines.length).toBeLessThanOrEqual(2 * (160 / 8 + 2 + 120 / 8 + 2));
    expect(base.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#4b4b4b')).toBe(true);
    renderer.dispose();
  });

  it('hides every grid tier together when showGrid is false', () => {
    const document = chart(20, 10);
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(320, 160, { dpr: 2 }),
      viewport: { x: 0, y: 0, zoom: 24 },
      style: { gridColor: '#00ff00', midGridColor: '#0000ff', majorGridColor: '#ff0000', gridInterval: 10, midGridInterval: 5, showGrid: false }
    });
    renderer.renderNow();
    const gridRecords = base.records.filter((call) =>
      call.strokeStyle === '#00ff00' || call.strokeStyle === '#0000ff' || call.strokeStyle === '#ff0000'
    );
    expect(gridRecords).toEqual([]);
    // The chart border is independent of the grid toggle and still renders.
    expect(base.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#4b4b4b')).toBe(true);
    renderer.dispose();
  });
});
