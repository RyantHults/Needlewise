import { describe, expect, it } from 'vitest';
import { CellKind, createDocument, createPatternFragment } from '../domain';
import { cellToScreenRect, fitViewport, getCanvasMetrics, visibleCellRect } from '../editor/coordinates';
import { DEFAULT_RENDERER_STYLE, type CanvasContextAdapter, type CanvasTarget, type PendingCellState, type RendererStyle, type TraceImage } from '../editor/contracts';
import { ThreeQuarterNW, ThreeQuarterPair } from '../editor/cell-kinds';
import { MAX_ATLAS_PIXELS, createDefaultAtlasTarget } from './context';
import { isCanvasImageSource } from './atlas';
import { createCanvasRenderer } from './renderer';
import { sparseSelectionGeometry } from '../editor/lasso';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { getSymbolOutline, SYMBOL_IDS } from '../symbols';

// Fixtures must name real pool slugs: an unknown slug is deliberately not
// drawable, so a stale glyph here would quietly assert nothing.
const [STAR_ID, DIAMOND_ID, HOLLOW_DIAMOND_ID] = SYMBOL_IDS;

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
    drawImage: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'drawImage', args); },
    save: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'save', args); },
    restore: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'restore', args); },
    setTransform: function (this: RecordingContext, ...args: number[]): void { record(this, 'setTransform', args); },
    setLineDash: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'setLineDash', args); },
    translate: function (this: RecordingContext, ...args: number[]): void { record(this, 'translate', args); },
    scale: function (this: RecordingContext, ...args: number[]): void { record(this, 'scale', args); },
    arc: function (this: RecordingContext, ...args: number[]): void { record(this, 'arc', args); }
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

/**
 * Every recorded call that painted a symbol outline, keyed by the Path2D it
 * carried. Detected by the path data rather than `instanceof Path2D`, because one
 * test removes that global to simulate a host that cannot paint outlines.
 */
const isPathArgument = (value: unknown): value is { d: string } =>
  typeof value === 'object' && value !== null && typeof (value as { d?: unknown }).d === 'string';

function symbolInkCalls(context: RecordingContext): RecordingContext['records'] {
  return context.records.filter((call) => (call.name === 'fill' || call.name === 'stroke') && isPathArgument(call.args[0]));
}

/**
 * Cell-geometry fills, which are the `fill()` calls that carry no path argument.
 * A symbol paints through `fill(path)`, so the raw name is no longer exclusive.
 */
function cellFills(context: RecordingContext): RecordingContext['records'] {
  return context.records.filter((call) => call.name === 'fill' && call.args.length === 0);
}

/** The path data actually drawn, for tests that care about which symbol appeared. */
function drawnPaths(context: RecordingContext): string[] {
  return symbolInkCalls(context).map((call) => (call.args[0] as { d: string }).d);
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
  return createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
    width,
    height,
    palette: [
      { id: 1, name: 'Red', color: '#f00' },
      { id: 35, name: 'Blue', color: '#00f' }
    ]
  });
}

describe('Canvas 2D chart renderer', () => {
  it('uses the neutral Aida background when a legacy runtime document has no background setting', () => {
    const document = chart(1, 1);
    document.settings = { ...document.settings, backgroundColor: undefined } as unknown as typeof document.settings;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(16, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { backgroundColor: '#123456' }
    });
    renderer.renderNow();

    expect(base.records.some((call) => call.name === 'fillRect' && call.args.join(',') === '0,0,16,16' && call.fillStyle === '#F3EEE5')).toBe(true);
    renderer.dispose();
  });

  it('uses the document Aida background for pattern fills and keys overview atlases by it', () => {
    const document = chart(2, 1);
    document.settings = Object.assign({}, document.settings, { backgroundColor: '#aabbcc' });
    const sourceDocument = chart(1, 1);
    sourceDocument.kind[0] = CellKind.Full;
    sourceDocument.colors[0] = 1;
    const fragment = createPatternFragment(sourceDocument, { x: 0, y: 0, width: 1, height: 1 });
    const base = recordingContext();
    const overlay = recordingContext();
    const detailRenderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { backgroundColor: '#010203', showGrid: false },
      overlay: {
        pendingCellStates: [{ index: 0, cell: { x: 0, y: 0 }, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }],
        floatingPaste: { fragment, destination: { x: 1, y: 0, width: 1, height: 1 } }
      }
    });
    detailRenderer.renderNow();

    expect(base.records.some((call) => call.name === 'fillRect' && call.args.join(',') === '0,0,32,16' && call.fillStyle === '#aabbcc')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'fillRect' && call.args.join(',') === '0,0,16,16' && call.fillStyle === '#aabbcc')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'fillRect' && call.args.join(',') === '16,0,16,16' && call.fillStyle === '#aabbcc')).toBe(true);
    detailRenderer.dispose();

    for (const mode of ['color', 'symbol'] as const) {
      const overviewDocument = chart(2, 1);
      overviewDocument.settings = Object.assign({}, overviewDocument.settings, { backgroundColor: '#aabbcc' });
      const atlasSources: RecordingContext[] = [];
      let atlasBuilds = 0;
      const overviewRenderer = createCanvasRenderer({
        document: overviewDocument,
        targets: { base: target(recordingContext()), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(2, 1),
        viewport: { x: 0, y: 0, zoom: 1 },
        style: { mode },
        atlasTargetFactory: (width, height) => {
          atlasBuilds += 1;
          const atlasSource = recordingContext();
          atlasSources.push(atlasSource);
          return target(atlasSource, new FakeCanvasImageSource(width, height));
        }
      });
      overviewRenderer.renderNow();
      expect(atlasBuilds).toBe(1);
      expect(atlasSources[0].records.some((call) => call.name === 'fillRect' && call.fillStyle === '#aabbcc')).toBe(true);
      const changedBackground = {
        ...overviewDocument,
        settings: Object.assign({}, overviewDocument.settings, { backgroundColor: '#ddeeff' }),
        revision: overviewDocument.revision + 1
      };
      overviewRenderer.setDocument(changedBackground);
      overviewRenderer.renderNow();
      expect(atlasBuilds).toBe(2);
      expect(atlasSources[1].records.some((call) => call.name === 'fillRect' && call.fillStyle === '#ddeeff')).toBe(true);
      expect(overviewRenderer.lastStats.baseRendered).toBe(true);
      overviewRenderer.dispose();
    }
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

    expect(overlay.records.some((record) => record.name === 'fillRect' && record.fillStyle === document.settings.backgroundColor)).toBe(true);
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
    const source = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 128, height: 128, palette: [{ id: 1, name: 'Red', color: '#f00' }] });
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

  it('renders the palette symbol stored on the entry instead of deriving one from the id', () => {
    const document = chart(1, 1);
    const [id] = SYMBOL_IDS;
    document.palette[0] = { ...document.palette[0], symbol: id };
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
    expect(drawnPaths(base)).toContain(getSymbolOutline(id)?.d);
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
    expect(symbolInkCalls(base).some((call) => call.fillStyle === '#242424')).toBe(true);
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
    expect(symbolInkCalls(base).some((call) => call.fillStyle === '#ffffff')).toBe(true);
    expect(symbolInkCalls(base).some((call) => call.fillStyle === '#242424')).toBe(false);
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
    expect(symbolInkCalls(base).some((call) => call.fillStyle === '#242424')).toBe(true);
    renderer.dispose();
  });

  it('scales the symbol outline to the grid cell size in combined mode', () => {
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
    // height = zoom), and outlines are drawn in a unit cell, so the painter is
    // handed 16 and the symbol fills its cell at any zoom.
    expect(base.records.some((call) => call.name === 'scale' && call.args[0] === 16 && call.args[1] === 16)).toBe(true);
    renderer.dispose();
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
    expect(symbolInkCalls(base).length).toBeGreaterThan(0);
    expect(base.records.find((call) => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0 && call.args[2] === 16 && call.args[3] === 16)).toMatchObject({ fillStyle: '#f00' });
    expect(base.records.some((call) => call.name === 'moveTo' && call.args[0] === 16 && call.args[1] === 0)).toBe(true);
  });

  describe('device-pixel snapping for full-cell fills', () => {
    // Fractional zoom (6.5 px/cell, between the Overview and Detail cutoffs)
    // is where seams show up: without snapping, each cell's anti-aliased
    // edge lands at a different sub-pixel offset than its neighbour's.
    function renderAdjacentFullCells(dpr: number): number[][] {
      const document = chart(2, 1);
      document.kind.set([CellKind.Full, CellKind.Full]);
      document.colors[0] = 1;
      document.colors[4] = 1;
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(20, 10, { dpr }),
        viewport: { x: 0, y: 0, zoom: 6.5 }
      });
      renderer.renderNow();
      return base.records
        .filter((call) => call.name === 'fillRect' && call.fillStyle === '#f00')
        .map((call) => call.args as number[]);
    }

    it.each([1, 2])('shares an exact device-pixel edge between adjacent cells at dpr %i', (dpr) => {
      const [cellA, cellB] = renderAdjacentFullCells(dpr);
      const cellARight = cellA[0] + cellA[2];
      // No gap or overlap: the shared edge is bit-for-bit the same value.
      expect(cellARight).toBe(cellB[0]);
      // Every edge lands on a device-pixel boundary (an integer once scaled
      // by dpr), not a fractional CSS pixel that would anti-alias.
      for (const edge of [cellA[0], cellARight, cellB[0] + cellB[2]]) {
        expect(edge * dpr).toBe(Math.round(edge * dpr));
      }
    });
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
      .filter((call) => (call.fillStyle === '#f00' || call.fillStyle === '#00f') && call.strokeStyle !== '#4b4b4b' && call.strokeStyle !== '#ffffff' && call.args[1] !== 4 && (call.name === 'moveTo' || call.name === 'lineTo'))
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

  describe('three-quarter pair seam', () => {
    function seamStrokes(setup: (document: ReturnType<typeof chart>) => void, zoom = 16, style: Partial<RendererStyle> = { mode: 'color' }) {
      const document = chart(1, 1);
      setup(document);
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(zoom, zoom),
        viewport: { x: 0, y: 0, zoom },
        style
      });
      renderer.renderNow();
      renderer.dispose();
      const records = base.records;
      return records.flatMap((call, position) => {
        if (call.name !== 'stroke' || call.strokeStyle === '#4b4b4b') return [];
        const path = records.slice(0, position).filter((entry) => entry.name === 'moveTo' || entry.name === 'lineTo').slice(-2);
        return [{ strokeStyle: call.strokeStyle, lineWidth: call.lineWidth, path: path.map((entry) => entry.args as number[]) }];
      });
    }

    it('strokes the anti-diagonal for a same-colour NW+SE pair', () => {
      const strokes = seamStrokes((document) => {
        document.kind[0] = ThreeQuarterPair;
        document.colors.set([1, 0, 1, 0], 0);
      });
      expect(strokes).toContainEqual({ strokeStyle: '#ffffff', lineWidth: 1, path: [[16, 0], [0, 16]] });
    });

    it('strokes the main diagonal for an NE+SW pair', () => {
      const strokes = seamStrokes((document) => {
        document.kind[0] = ThreeQuarterPair;
        document.colors.set([0, 1, 0, 1], 0);
      });
      expect(strokes).toContainEqual({ strokeStyle: '#ffffff', lineWidth: 1, path: [[0, 0], [16, 16]] });
    });

    it('draws no seam at overview zoom, or for single three-quarter and full cells', () => {
      const diagonal = (strokes: ReturnType<typeof seamStrokes>) => strokes.filter((stroke) => stroke.path[0]?.[0] !== stroke.path[1]?.[0] && stroke.path[0]?.[1] !== stroke.path[1]?.[1]);
      expect(diagonal(seamStrokes((document) => {
        document.kind[0] = ThreeQuarterPair;
        document.colors.set([1, 0, 1, 0], 0);
      }, 2))).toEqual([]);
      expect(diagonal(seamStrokes((document) => {
        document.kind[0] = ThreeQuarterNW;
        document.colors.set([1, 0, 0, 0], 0);
      }))).toEqual([]);
      expect(diagonal(seamStrokes((document) => {
        document.kind[0] = CellKind.Full;
        document.colors.set([1, 0, 0, 0], 0);
      }))).toEqual([]);
    });
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
    expect(overlay.records.find((call) => call.name === 'stroke' && call.strokeStyle === '#242424')?.globalAlpha).toBe(1);
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

  it('renders a brush preview as an opaque, high-contrast outer footprint outline', () => {
    const document = chart(5, 5);
    document.palette[0] = { ...document.palette[0], color: '#ffffff' };
    document.palette[1] = { ...document.palette[1], color: '#000' };
    for (const [index, paletteId] of [[1, 35], [5, 1], [6, 35], [7, 35], [11, 35]]) {
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = paletteId;
    }
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(80, 80),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [
            { index: 1, cell: { x: 1, y: 0 }, kind: CellKind.Full, colors: [35, 0, 0, 0], completed: 0 },
            { index: 5, cell: { x: 0, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 6, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 7, cell: { x: 2, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
            { index: 11, cell: { x: 1, y: 2 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }
          ]
        }
      }
    });
    renderer.renderNow();
    expect(base.records.some((call) => call.name === 'fillRect' && call.args.join(',') === '16,0,16,16' && call.fillStyle === '#000')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.args.join(',') === '0,16,16,16' && call.fillStyle === '#ffffff')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'fillRect' && call.globalAlpha < 0.3)).toBe(false);
    expect(overlay.records.filter((call) => call.name === 'fill').length).toBe(0);
    expect(overlay.records.some((call) => call.name === 'stroke' && call.globalAlpha === 1)).toBe(true);
    // Exact per-edge colors below depend on the *committed* neighbour across
    // each edge (mixing painted cells and out-of-bounds/background), not on a
    // single per-cell proposed color, so only the overall geometry and the
    // restricted {ink, keyline} palette are asserted here (via the `stroke()`
    // calls, since strokeStyle is set right before each stroke, not before the
    // moveTo/lineTo that defines its path). See the dedicated committed-color
    // regressions below for exact ink/keyline assertions.
    // The 5-cell plus-shaped footprint has 12 outer edges; each gets its own
    // solid keyline stroke plus a dashed ink stroke on top.
    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBe(24);
    expect(new Set(strokes.map((call) => call.globalAlpha))).toEqual(new Set([1]));
    expect(strokes.every((call) => call.strokeStyle === '#242424' || call.strokeStyle === '#ffffff')).toBe(true);
    renderer.dispose();
  });

  it('derives the brush-preview ink from committed colour, ignoring the pending paint colour (dark region)', () => {
    // Regression: the hover outline must read the colour it is drawn OVER
    // (the committed document), never the pending/proposed selected thread.
    const document = chart(3, 3);
    document.palette[0] = { ...document.palette[0], color: '#000000' }; // id 1: committed region colour
    document.palette[1] = { ...document.palette[1], color: '#ffffff' }; // id 35: the (irrelevant) selected thread
    for (let index = 0; index < 9; index += 1) {
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = 1;
    }
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 48),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          // Hover the center cell; its proposed paint colour (id 35, light)
          // is the opposite of the committed colour underneath it and must
          // have zero effect on the outline.
          states: [{ index: 4, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [35, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((call) => call.globalAlpha === 1)).toBe(true);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const keylineStrokes = strokes.filter((call) => call.lineWidth === keylineWidth);
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    expect(inkStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    expect(keylineStrokes.every((call) => call.strokeStyle === '#242424')).toBe(true);
    renderer.dispose();
  });

  it('derives the brush-preview ink from committed colour, ignoring the pending paint colour (light region)', () => {
    const document = chart(3, 3);
    document.palette[0] = { ...document.palette[0], color: '#ffffff' }; // id 1: committed region colour
    document.palette[1] = { ...document.palette[1], color: '#000000' }; // id 35: the (irrelevant) selected thread
    for (let index = 0; index < 9; index += 1) {
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = 1;
    }
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 48),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          // Proposed paint colour is DARK (selected thread); committed region
          // is white, so a correct outline stays dark-ink/white-keyline
          // regardless of what is about to be painted.
          states: [{ index: 4, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [35, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#ffffff')).toBe(true);
    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((call) => call.globalAlpha === 1)).toBe(true);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const keylineStrokes = strokes.filter((call) => call.lineWidth === keylineWidth);
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    expect(keylineStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    expect(inkStrokes.every((call) => call.strokeStyle === '#242424')).toBe(true);
    expect(keylineWidth).toBeGreaterThan(inkStrokes[0]?.lineWidth ?? 0);
    renderer.dispose();
  });

  it('keys the outline from the committed neighbour across each footprint edge (mixed colours)', () => {
    // A hovered black cell ringed entirely by white committed neighbours puts
    // both candidate inks {white, symbolColor} in front of every edge; the
    // renderer must make the worst-case-contrast choice consistently rather
    // than leaking the (unused) proposed colour.
    const document = chart(3, 3);
    document.palette[0] = { ...document.palette[0], color: '#000000' }; // id 1: the hovered cell
    document.palette[1] = { ...document.palette[1], color: '#ffffff' }; // id 35: its committed neighbours
    for (let index = 0; index < 9; index += 1) {
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = index === 4 ? 1 : 35;
    }
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 48),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [{ index: 4, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [35, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    const allowedInks = new Set(['#ffffff', '#242424']);
    expect(strokes.every((call) => allowedInks.has(call.strokeStyle))).toBe(true);
    expect(new Set(strokes.map((call) => call.strokeStyle)).size).toBe(2);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const keylineStrokes = strokes.filter((call) => call.lineWidth === keylineWidth);
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    // Ink and keyline must always differ, and (since every neighbour is
    // uniformly white) the choice is uniform across every edge.
    expect(keylineStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    expect(inkStrokes.every((call) => call.strokeStyle === '#242424')).toBe(true);
    renderer.dispose();
  });

  it('strokes the keyline solid and wider, then the ink dashed and narrower', () => {
    const document = chart(3, 3);
    document.palette[0] = { ...document.palette[0], color: '#000000' };
    document.palette[1] = { ...document.palette[1], color: '#ffffff' };
    for (let index = 0; index < 9; index += 1) {
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = 1;
    }
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 48),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [{ index: 4, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    const records = overlay.records;
    const strokeIndices: number[] = [];
    records.forEach((call, index) => { if (call.name === 'stroke') strokeIndices.push(index); });
    expect(strokeIndices.length).toBeGreaterThanOrEqual(2);
    const [firstStrokeIndex, secondStrokeIndex] = strokeIndices;
    const lastDashBefore = (index: number): unknown => {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (records[cursor].name === 'setLineDash') return records[cursor].args[0];
      }
      return undefined;
    };
    // Keyline: solid, wider. Ink: dashed, narrower. Keyline strokes first.
    expect(records[firstStrokeIndex].lineWidth).toBeGreaterThan(records[secondStrokeIndex].lineWidth);
    expect(lastDashBefore(firstStrokeIndex)).toEqual([]);
    const inkDash = lastDashBefore(secondStrokeIndex);
    expect(Array.isArray(inkDash) && (inkDash as unknown[]).length > 0).toBe(true);
    renderer.dispose();
  });

  it('treats a 3-digit #000 shorthand palette colour the same as full black for ink selection', () => {
    const document = chart(3, 3);
    document.palette[0] = { ...document.palette[0], color: '#000' };
    document.palette[1] = { ...document.palette[1], color: '#fff' };
    for (let index = 0; index < 9; index += 1) {
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = 1;
    }
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(48, 48),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [{ index: 4, cell: { x: 1, y: 1 }, kind: CellKind.Full, colors: [35, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    expect(inkStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    renderer.dispose();
  });

  it('keys a split-cell outline from its painted slot plus the exposed light background', () => {
    // Regression: unpainted quarters expose the pattern background as an
    // underlying colour too (not just the one painted dark slot), so a light
    // background must pull the outline toward a dark ink / white keyline.
    const document = chart(1, 1);
    document.settings = { ...document.settings, backgroundColor: '#ffffff' };
    document.palette[0] = { ...document.palette[0], color: '#ffffff' };
    document.palette[1] = { ...document.palette[1], color: '#000' };
    document.kind[0] = CellKind.Quarters;
    document.colors.set([35, 0, 0, 0], 0);
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(16, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [{ index: 0, cell: { x: 0, y: 0 }, kind: CellKind.Quarters, colors: [35, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === document.settings.backgroundColor)).toBe(true);
    expect(base.records.some((call) => call.name === 'fill' && call.fillStyle === '#000')).toBe(true);
    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((call) => call.globalAlpha === 1)).toBe(true);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const keylineStrokes = strokes.filter((call) => call.lineWidth === keylineWidth);
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    // Underlying colours here are {dark painted slot, white background}: the
    // worst-case-contrast choice is a dark ink (style.symbolColor) with a
    // white keyline beneath it.
    expect(keylineStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    expect(inkStrokes.every((call) => call.strokeStyle === '#242424')).toBe(true);
    renderer.dispose();
  });

  it('keys a half-stitch outline from its exposed corner background, not just its painted band', () => {
    // Regression: HalfBackslash/HalfSlash paint a diagonal hexagon that
    // leaves two corner triangles as exposed pattern background. Without
    // that background, an edge shared with an equally-coloured committed
    // neighbour sees only one (duplicated) colour and picks the *worse*
    // worst-case ink; the exposed white background must pull it back to
    // the correct dark ink / white keyline pair.
    const document = chart(2, 1);
    document.settings = { ...document.settings, backgroundColor: '#ffffff' };
    document.palette[0] = { ...document.palette[0], color: '#4d4d4d' };
    document.kind[0] = CellKind.HalfBackslash;
    document.colors[0] = 1;
    document.kind[1] = CellKind.Full;
    document.colors[4] = 1;
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [{ index: 0, cell: { x: 0, y: 0 }, kind: CellKind.HalfBackslash, colors: [1, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    expect(base.records.some((call) => call.name === 'fill' && call.fillStyle === '#4d4d4d')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#4d4d4d')).toBe(true);
    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const keylineStrokes = strokes.filter((call) => call.lineWidth === keylineWidth);
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    // Every edge (including the one shared with the equally-dark Full
    // neighbour) must resolve to the same dark-ink/white-keyline pair.
    expect(inkStrokes.every((call) => call.strokeStyle === '#242424')).toBe(true);
    expect(keylineStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    renderer.dispose();
  });

  it('keys a directional three-quarter outline from its exposed corner background', () => {
    // Same regression as the half-stitch case above, for a single-direction
    // three-quarter stitch (ThreeQuarterNW/NE/SE/SW), which paints one
    // triangle and leaves the opposite corner as exposed background.
    const document = chart(2, 1);
    document.settings = { ...document.settings, backgroundColor: '#ffffff' };
    document.palette[0] = { ...document.palette[0], color: '#4d4d4d' };
    document.kind[0] = CellKind.ThreeQuarterSE;
    document.colors[0] = 1;
    document.kind[1] = CellKind.Full;
    document.colors[4] = 1;
    const base = recordingContext();
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(overlay) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      overlay: {
        brushPreview: {
          kind: 'paint',
          states: [{ index: 0, cell: { x: 0, y: 0 }, kind: CellKind.ThreeQuarterSE, colors: [1, 0, 0, 0], completed: 0 }]
        }
      }
    });
    renderer.renderNow();

    expect(base.records.some((call) => call.name === 'fill' && call.fillStyle === '#4d4d4d')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#4d4d4d')).toBe(true);
    const strokes = overlay.records.filter((call) => call.name === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    const keylineWidth = Math.max(...strokes.map((call) => call.lineWidth));
    const keylineStrokes = strokes.filter((call) => call.lineWidth === keylineWidth);
    const inkStrokes = strokes.filter((call) => call.lineWidth < keylineWidth);
    expect(inkStrokes.length).toBeGreaterThan(0);
    expect(inkStrokes.every((call) => call.strokeStyle === '#242424')).toBe(true);
    expect(keylineStrokes.every((call) => call.strokeStyle === '#ffffff')).toBe(true);
    renderer.dispose();
  });

  it('dims the committed pattern while move-image dimming is active', () => {
    const document = chart(1, 1);
    document.kind[0] = CellKind.Full;
    document.colors[0] = 1;
    document.completed[0] = 1;
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(16, 16),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { completedOpacity: 1 }
    });
    const cellFills = () => base.records.filter((call) => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0 && call.args[2] === 16 && call.args[3] === 16);
    const completionMarks = () => base.records.filter((call) => call.name === 'stroke' && call.strokeStyle === '#242424');
    renderer.renderNow();
    // The background fill and the (0,0) cell fill share the same rect; the cell
    // is drawn last, so it is the final record while the background stays opaque.
    expect(cellFills().at(-1)?.globalAlpha).toBe(1);
    expect(completionMarks().at(-1)?.globalAlpha).toBe(1);
    base.calls.length = 0;
    base.records.length = 0;
    renderer.setPatternDimmed?.(true);
    renderer.renderNow();
    expect(cellFills().at(-1)?.globalAlpha).toBe(0.5);
    expect(completionMarks().at(-1)?.globalAlpha).toBe(0.5);
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

  it.each([
    { mode: 'color' as const, atlas: true },
    { mode: 'color' as const, atlas: false },
    { mode: 'symbol' as const, atlas: true },
    { mode: 'symbol' as const, atlas: false }
  ])('strokes backstitches over the $mode overview (atlas: $atlas)', ({ mode, atlas }) => {
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
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(32, 16),
      viewport: { x: 0, y: 0, zoom: 1 },
      style: { mode },
      atlasTargetFactory: atlas ? (width, height) => target(recordingContext(), new FakeCanvasImageSource(width, height)) : () => undefined
    });
    const stats = renderer.renderNow();
    expect(stats.lod).toBe('overview');
    expect(stats.drawnBackstitches).toBe(1);
    expect(base.calls.includes('drawImage')).toBe(atlas);
    expect(base.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#00f')).toBe(true);
    renderer.dispose();
  });

  describe('partial redraws snap to device pixels', () => {
    // A brush stroke invalidates its bounding cell rect, which lands on
    // fractional CSS coordinates at a fractional zoom and dpr. The redraw must
    // reach 2px past it (perimeter grid-line halves) and sit on device pixels.
    const dpr = 1.5;
    const cellRect = { x: 2, y: 3, width: 2, height: 1 };
    const viewport = { x: 0, y: 0, zoom: 6.5 };
    const raw = cellToScreenRect(cellRect, viewport);
    const onDevicePixel = (value: number): boolean => Math.abs(value * dpr - Math.round(value * dpr)) < 1e-9;
    const expectExpandedSnappedClear = (context: RecordingContext): void => {
      const clears = context.records.filter((call) => call.name === 'clearRect' && (call.args[0] as number) > 0);
      expect(clears).toHaveLength(1);
      const [x, y, width, height] = clears[0].args as number[];
      for (const edge of [x, y, x + width, y + height]) expect(onDevicePixel(edge)).toBe(true);
      expect(x).toBeLessThanOrEqual(raw.x - 2);
      expect(y).toBeLessThanOrEqual(raw.y - 2);
      expect(x + width).toBeGreaterThanOrEqual(raw.x + raw.width + 2);
      expect(y + height).toBeGreaterThanOrEqual(raw.y + raw.height + 2);
      expect(x).toBeGreaterThan(raw.x - 2 - 1 / dpr);
      expect(x + width).toBeLessThan(raw.x + raw.width + 2 + 1 / dpr);
    };

    it('expands and snaps the base clear', () => {
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document: chart(20, 20),
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(100, 100, { dpr }),
        viewport
      });
      expect(renderer.renderNow().lod).not.toBe('overview');
      base.calls.length = 0;
      base.records.length = 0;
      renderer.invalidate({ layer: 'base', cellRect, reason: 'paint-cell' });
      renderer.renderNow();
      expectExpandedSnappedClear(base);
      renderer.dispose();
    });

    it('expands and snaps the overlay clear', () => {
      const overlay = recordingContext();
      const renderer = createCanvasRenderer({
        document: chart(20, 20),
        targets: { base: target(recordingContext()), overlay: target(overlay) },
        metrics: getCanvasMetrics(100, 100, { dpr }),
        viewport
      });
      renderer.renderNow();
      overlay.calls.length = 0;
      overlay.records.length = 0;
      renderer.invalidate({ layer: 'overlay', cellRect, reason: 'pending-cells' });
      renderer.renderNow();
      expectExpandedSnappedClear(overlay);
      renderer.dispose();
    });
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
    expect(cellFills(sources[0])).toHaveLength(1);
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
    expect(cellFills(sources[1])).toHaveLength(1);
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
    // The 2px seam margin reaches half a cell at zoom 4, so the redraw covers a
    // ring of neighbours around the two invalidated cells.
    expect(renderer.lastStats.visitedCells).toBe(12);
    expect(base.records.some((call) => call.name === 'clip')).toBe(true);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,40,40')).toBe(false);
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '18,22,12,8')).toBe(true);
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
    // One cell plus the ring of neighbours the 2px seam margin reaches.
    expect(renderer.lastStats.visitedCells).toBe(9);
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

  it('repaints only the invalidated cells of an overview atlas for a changed document', () => {
    const original = chart(2, 2);
    original.kind[0] = CellKind.Full;
    original.colors[0] = 1;
    const next = chart(2, 2);
    next.kind[0] = CellKind.Full;
    next.colors[0] = 35;
    next.revision = original.revision + 1;
    const base = recordingContext();
    const atlasContexts: RecordingContext[] = [];
    const renderer = createCanvasRenderer({
      document: original,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(20, 20),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: (width, height) => {
        const context = recordingContext();
        atlasContexts.push(context);
        return target(context, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    atlasContexts[0].records.length = 0;
    base.records.length = 0;
    renderer.setDocument(next, {
      layer: 'base',
      cellRect: { x: 0, y: 0, width: 1, height: 1 },
      reason: 'document-overview'
    });
    renderer.renderNow();
    expect(atlasContexts).toHaveLength(1);
    const patched = atlasContexts[0].records;
    const fills = patched.filter((call) => call.name === 'fillRect');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((call) => call.args.join(',') === '0,0,1,1')).toBe(true);
    expect(renderer.lastStats.lod).toBe('overview');
    expect(base.records.some((call) => call.name === 'clearRect' && call.args.join(',') === '0,0,20,20')).toBe(true);

    // A document change without known cells rebuilds.
    const unknown = { ...next, kind: next.kind.slice(), colors: next.colors.slice(), revision: next.revision + 1 };
    renderer.setDocument(unknown, { layer: 'base', full: true, reason: 'external-document' });
    renderer.renderNow();
    expect(atlasContexts).toHaveLength(2);
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

  it('keeps compact geometry and Symbol outlines while Combined remains detail-only', () => {
    const compactContext = recordingContext();
    const compactDocument = chart(5, 5);
    compactDocument.palette[0] = { ...compactDocument.palette[0], symbol: STAR_ID };
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
    expect(symbolInkCalls(compactContext).length).toBeGreaterThan(0);
    expect(symbolInkCalls(compactCombinedContext).length).toBe(0);
    expect(symbolInkCalls(detailContext).length).toBeGreaterThan(0);
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

  describe('grid contrast with the stitches it separates', () => {
    const LIGHT = 2;
    const DARK = 3;
    const gridStyle = {
      gridColor: '#00ff00',
      majorGridColor: '#00ff00',
      lightStitchGridColor: '#111111',
      lightStitchMajorGridColor: '#111111',
      darkStitchGridColor: '#eeeeee',
      darkStitchMajorGridColor: '#eeeeee',
      gridInterval: 10
    };
    const toneChart = (ids: readonly number[]) => {
      const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
        width: ids.length,
        // Two identical rows: the grid only shows when zoomed past the fit, so the second row sits below the canvas.
        height: 2,
        palette: [
          { id: LIGHT, name: 'Cream', color: '#ffffcc' },
          { id: DARK, name: 'Charcoal', color: '#202020' }
        ]
      });
      ids.forEach((id, x) => {
        if (id === 0) return;
        for (const index of [x, ids.length + x]) {
          document.kind[index] = CellKind.Full;
          document.colors[index * 4] = id;
        }
      });
      return document;
    };
    const gridSegments = (context: RecordingContext) => context.records
      .map((call, index, records) => call.name === 'moveTo' && records[index + 1]?.name === 'lineTo'
        ? { from: call.args as number[], to: records[index + 1].args as number[], color: call.strokeStyle }
        : undefined)
      .filter((segment) => segment !== undefined)
      .filter((segment) => ['#00ff00', '#111111', '#eeeeee'].includes(segment.color));
    const verticalAt = (context: RecordingContext, x: number) => gridSegments(context)
      .filter((segment) => segment.from[0] === x && segment.to[0] === x)
      .map((segment) => segment.color);
    const render = (document: ReturnType<typeof toneChart>, style: Partial<RendererStyle> = {}) => {
      const base = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(document.width * 20, 20),
        viewport: { x: 0, y: 0, zoom: 20 },
        style: { ...gridStyle, ...style }
      });
      renderer.renderNow();
      renderer.dispose();
      return base;
    };

    it('darkens lines between light stitches and lightens lines between dark stitches', () => {
      const base = render(toneChart([LIGHT, LIGHT, DARK, DARK]));
      expect(verticalAt(base, 20)).toEqual(['#111111']);
      expect(verticalAt(base, 40)).toEqual(['#00ff00']);
      expect(verticalAt(base, 60)).toEqual(['#eeeeee']);
      // The line between the rows splits into one run per tone instead of one stroke per cell.
      const between = gridSegments(base).filter((segment) => segment.from[1] === 20 && segment.to[1] === 20);
      expect(between.map((segment) => [segment.from[0], segment.to[0], segment.color])).toEqual([
        [0, 40, '#111111'],
        [40, 80, '#eeeeee']
      ]);
    });

    it('keeps a uniform line as a single stroke', () => {
      const base = render(toneChart([LIGHT, LIGHT, LIGHT, LIGHT]));
      const between = gridSegments(base).filter((segment) => segment.from[1] === 20 && segment.to[1] === 20);
      expect(between.map((segment) => [segment.from[0], segment.to[0], segment.color])).toEqual([[0, 80, '#111111']]);
    });

    it('treats fabric as its background tone and keeps the theme color on blank fabric', () => {
      const base = render(toneChart([LIGHT, 0, 0, DARK]));
      // The default fabric is light: light stitch beside it reads light, dark stitch beside it is mixed.
      expect(verticalAt(base, 20)).toEqual(['#111111']);
      expect(verticalAt(base, 40)).toEqual(['#00ff00']);
      expect(verticalAt(base, 60)).toEqual(['#00ff00']);
      const blank = render(toneChart([0, 0, 0, 0]));
      expect(gridSegments(blank).length).toBeGreaterThan(0);
      expect(gridSegments(blank).every((segment) => segment.color === '#00ff00')).toBe(true);
    });

    it('keeps the theme colors in Symbol mode', () => {
      const base = render(toneChart([LIGHT, LIGHT, DARK, DARK]), { mode: 'symbol' });
      expect(gridSegments(base).length).toBeGreaterThan(0);
      expect(gridSegments(base).every((segment) => segment.color === '#00ff00')).toBe(true);
    });

    it('judges pending overlay cells by their pending colors', () => {
      const document = toneChart([0, 0, 0, 0]);
      const overlay = recordingContext();
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(recordingContext()), overlay: target(overlay) },
        metrics: getCanvasMetrics(80, 20),
        viewport: { x: 0, y: 0, zoom: 20 },
        style: gridStyle,
        overlay: {
          pendingCells: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
          pendingCellStates: [
            { index: 1, cell: { x: 1, y: 0 }, kind: CellKind.Full, colors: [DARK, 0, 0, 0], completed: 0 },
            { index: 2, cell: { x: 2, y: 0 }, kind: CellKind.Full, colors: [DARK, 0, 0, 0], completed: 0 }
          ]
        }
      });
      renderer.renderNow();
      expect(verticalAt(overlay, 40)).toEqual(['#eeeeee']);
      // Each pending cell borders light fabric on its outer side.
      expect(verticalAt(overlay, 20)).toEqual(['#00ff00']);
      expect(verticalAt(overlay, 60)).toEqual(['#00ff00']);
      renderer.dispose();
    });
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

  describe('lasso start dot', () => {
    function renderLasso(lassoPath: Record<string, unknown>): RecordingContext {
      const overlay = recordingContext();
      const renderer = createCanvasRenderer({
        document: chart(3, 3),
        targets: { base: target(recordingContext()), overlay: target(overlay) },
        metrics: getCanvasMetrics(30, 30),
        viewport: { x: 0, y: 0, zoom: 10 },
        overlay: { lassoPath } as never
      });
      renderer.renderNow();
      renderer.dispose();
      return overlay;
    }

    const arcs = (context: RecordingContext) => context.records.filter((call) => call.name === 'arc');

    it('draws a hollow dot at the start point', () => {
      const overlay = renderLasso({ points: [{ x: 1, y: 1 }, { x: 2, y: 1 }], start: { x: 1, y: 1 } });

      const [arc] = arcs(overlay);
      expect(arcs(overlay)).toHaveLength(1);
      expect(arc.args).toEqual([10, 10, 5, 0, Math.PI * 2]);
      expect(arc.fillStyle).toBe('#fffdf9');
      expect(arc.strokeStyle).toBe('#2266cc');
      expect(overlay.records.some((call) => call.name === 'fill' && call.fillStyle === '#fffdf9')).toBe(true);
    });

    it('draws a larger filled dot when closable', () => {
      const overlay = renderLasso({ points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }], start: { x: 1, y: 1 }, closable: true });

      const [arc] = arcs(overlay);
      expect(arc.args).toEqual([10, 10, 7, 0, Math.PI * 2]);
      expect(arc.fillStyle).toBe('#2266cc');
      expect(arc.strokeStyle).toBe('#2266cc');
    });

    it('draws the dot for a single point', () => {
      const overlay = renderLasso({ points: [{ x: 1, y: 1 }], start: { x: 1, y: 1 } });

      expect(arcs(overlay)).toHaveLength(1);
    });

    it('draws no dot without a start', () => {
      expect(arcs(renderLasso({ points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }))).toHaveLength(0);
    });

    const PREVIEW_FILL = 'rgba(110, 110, 110, 0.28)';
    const PREVIEW_STROKE = '#7d7873';
    const open = { points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }], start: { x: 1, y: 1 } };
    const boundary = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 }, kind: 'exterior' };

    it('fills preview runs as rects', () => {
      const overlay = renderLasso({ ...open, preview: { runs: [{ x: 1, y: 1, width: 2 }, { x: 0, y: 2, width: 1 }], boundaries: [] } });

      const fills = overlay.records.filter((call) => call.name === 'fillRect' && call.fillStyle === PREVIEW_FILL);
      expect(fills.map((call) => call.args)).toEqual([[10, 10, 20, 10], [0, 20, 10, 10]]);
    });

    it('strokes preview boundaries grey', () => {
      const overlay = renderLasso({ ...open, preview: { runs: [], boundaries: [boundary] } });

      const strokes = overlay.records.filter((call) => call.name === 'stroke' && call.strokeStyle === PREVIEW_STROKE);
      expect(strokes.length).toBeGreaterThan(0);
      expect(overlay.records.some((call) => call.name === 'moveTo' && call.args.join(',') === '10,10')).toBe(true);
    });

    it('keeps the path blue while open, with a blue dot', () => {
      const overlay = renderLasso(open);

      expect(overlay.records.some((call) => call.name === 'stroke' && call.strokeStyle === PREVIEW_STROKE)).toBe(false);
      const strokes = overlay.records.filter((call) => call.name === 'stroke' && call.strokeStyle === '#2266cc');
      expect(strokes.length).toBeGreaterThan(1);
      expect(overlay.records.find((call) => call.name === 'arc')!.strokeStyle).toBe('#2266cc');
    });

    it('draws a 3px filled dot for each anchor beyond the first', () => {
      const overlay = renderLasso({ ...open, anchors: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] });

      const arcs = overlay.records.filter((call) => call.name === 'arc');
      expect(arcs.map((call) => call.args)).toEqual([[20, 10, 3, 0, Math.PI * 2], [20, 20, 3, 0, Math.PI * 2], [10, 10, 5, 0, Math.PI * 2]]);
      expect(arcs[0].fillStyle).toBe('#2266cc');
      const anchorFills = overlay.records.filter((call) => call.name === 'fill' && call.fillStyle === '#2266cc');
      expect(anchorFills).toHaveLength(2);
    });

    it('draws no anchor dots without anchors', () => {
      expect(arcs(renderLasso(open))).toHaveLength(1);
    });

    it('skips off-screen anchors', () => {
      const overlay = renderLasso({ ...open, anchors: [{ x: 1, y: 1 }, { x: 50, y: 50 }, { x: 2, y: 2 }] });

      expect(arcs(overlay).map((call) => call.args.slice(0, 3))).toEqual([[20, 20, 3], [10, 10, 5]]);
    });

    it('fills nothing without a preview', () => {
      const overlay = renderLasso(open);

      expect(overlay.records.some((call) => call.name === 'fillRect' && call.fillStyle === PREVIEW_FILL)).toBe(false);
    });

    it('clips off-screen preview runs', () => {
      const overlay = renderLasso({
        ...open,
        preview: { runs: [{ x: -5, y: 0, width: 10 }, { x: 0, y: 50, width: 3 }], boundaries: [] }
      });

      const fills = overlay.records.filter((call) => call.name === 'fillRect' && call.fillStyle === PREVIEW_FILL);
      expect(fills.map((call) => call.args)).toEqual([[0, 0, 30, 10]]);
    });

    it('draws no dot when the start is outside the bounds', () => {
      const overlay = renderLasso({ points: [{ x: 1, y: 1 }, { x: 2, y: 1 }], start: { x: 50, y: 50 } });

      expect(arcs(overlay)).toHaveLength(0);
    });
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
    expect(fillRects.some((call) => call.args.join(',') === '48,0,16,16' && call.fillStyle === document.settings.backgroundColor)).toBe(true);
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
      // The pending stitch is dark, so its outer edges take the dark-stitch variant.
      style: { gridColor: '#00aa00', majorGridColor: '#00aa00', darkStitchGridColor: '#00aa00', darkStitchMajorGridColor: '#00aa00', gridInterval: 1 },
      overlay: {
        pendingCells: [{ x: 1, y: 0 }],
        pendingCellStates: [{ index: 1, cell: { x: 1, y: 0 }, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }]
      }
    });
    renderer.renderNow();

    const maskIndex = overlay.records.findIndex((call) => call.name === 'fillRect' && call.args.join(',') === '20,0,20,20' && call.fillStyle === document.settings.backgroundColor);
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

  it('repairs pending backstitches at overview LOD', () => {
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
    expect(overlay.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#00f')).toBe(true);
    expect(overlay.records.some((call) => call.name === 'moveTo' && call.strokeStyle === '#00aa00')).toBe(false);
    renderer.dispose();
  });

  it('keeps color presentation distinct while Symbol Overview paints actual outlines', () => {
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
    document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
    expect(symbolInkCalls(sourceContext).length).toBeGreaterThan(0);
    expect(symbolInkCalls(sourceContext).some((call) => call.fillStyle === '#123456')).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#abcdef')).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillRect' && call.fillStyle === document.settings.backgroundColor)).toBe(true);
    expect(sourceContext.records.some((call) => call.name === 'fillRect' && call.fillStyle !== '#abcdef' && call.fillStyle !== document.settings.backgroundColor)).toBe(false);
    symbolRenderer.dispose();
  });

  it('preserves the palette Symbol choice at Detail, Compact, and Overview zooms', () => {
    const render = (zoom: number): { base: RecordingContext; source: RecordingContext } => {
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
    expect(symbolInkCalls(detail.base).length).toBeGreaterThan(0);
    expect(symbolInkCalls(compact.base).length).toBeGreaterThan(0);
    expect(overview.base.records.some((call) => call.name === 'drawImage')).toBe(true);
    expect(symbolInkCalls(overview.base).length).toBe(0);
    expect(drawnPaths(overview.source).includes(getSymbolOutline(STAR_ID)?.d ?? '')).toBe(true);
  });

  it('keeps Symbol outline behavior at every LOD threshold boundary', () => {
    for (const [zoom, expectedLod] of [[3.99, 'overview'], [4, 'compact'], [11.99, 'compact'], [12, 'detail']] as const) {
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
        expect(drawnPaths(source).includes(getSymbolOutline(STAR_ID)?.d ?? '')).toBe(true);
        expect(base.records.some((call) => call.name === 'drawImage')).toBe(true);
      } else {
        expect(drawnPaths(base).includes(getSymbolOutline(STAR_ID)?.d ?? '')).toBe(true);
      }
      renderer.dispose();
    }
  });

  it('reuses the Symbol overview atlas across viewport, grid, and overlay changes', () => {
    const document = chart(2, 2);
    document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
    const firstSourceSymbols = symbolInkCalls(sources[0]).length;

    const completionOnlyDocument = {
      ...document,
      completed: document.completed.slice(),
      revision: document.revision + 1
    };
    renderer.setDocument(completionOnlyDocument);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(symbolInkCalls(sources[0])).toHaveLength(firstSourceSymbols);
    const firstDrawImages = base.records.filter((call) => call.name === 'drawImage').length;

    renderer.setViewport({ x: 0.25, y: 0.1, zoom: 2 });
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(symbolInkCalls(sources[0])).toHaveLength(firstSourceSymbols);
    expect(base.records.filter((call) => call.name === 'drawImage').length).toBe(firstDrawImages + 1);

    renderer.setOverlay({ cursor: { x: 0, y: 0 } });
    renderer.renderNow();
    renderer.setStyle({ showGrid: false });
    renderer.renderNow();
    expect(builds).toBe(1);

    const changedDocument = chart(2, 2);
    changedDocument.palette[0] = { ...changedDocument.palette[0], symbol: STAR_ID };
    changedDocument.kind[0] = CellKind.Full;
    changedDocument.colors[0] = 1;
    changedDocument.revision = document.revision + 1;
    renderer.setDocument(changedDocument);
    renderer.renderNow();
    expect(builds).toBe(2);

    // The symbol font is gone: outlines are pool geometry, so there is no font
    // left to invalidate the atlas, while these three still repaint it.
    for (const styleChange of [
      { symbolFont: '600 0.8em sans-serif' },
      { symbolColor: '#123456' },
      { symbolBackgroundColor: '#abcdef' },
      { showSymbols: false }
    ]) {
      renderer.setStyle(styleChange as Parameters<typeof renderer.setStyle>[0]);
      renderer.renderNow();
    }
    expect(builds).toBe(5);
    renderer.dispose();
  });

  it('reuses the Symbol overview atlas for unused palette changes but rebuilds for a used symbol mutation', () => {
    const document = chart(2, 2);
    document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
    const firstSourceSymbols = symbolInkCalls(sources[0]).length;

    const appended = {
      ...document,
      palette: [...document.palette, { ...document.palette[1], id: 99, name: 'Unused', symbol: DIAMOND_ID }],
      revision: document.revision + 1
    };
    renderer.setDocument(appended);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(symbolInkCalls(sources[0])).toHaveLength(firstSourceSymbols);

    const unusedUpdated = {
      ...appended,
      palette: appended.palette.map((entry) => entry.id === 99 ? { ...entry, symbol: HOLLOW_DIAMOND_ID } : entry),
      revision: appended.revision + 1
    };
    renderer.setDocument(unusedUpdated);
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(symbolInkCalls(sources[0])).toHaveLength(firstSourceSymbols);

    (unusedUpdated.palette[0] as { symbol: string }).symbol = DIAMOND_ID;
    unusedUpdated.revision += 1;
    renderer.setDocument(unusedUpdated);
    renderer.renderNow();
    expect(builds).toBe(2);
    expect(drawnPaths(sources[1])).toContain(getSymbolOutline(DIAMOND_ID)?.d ?? '');
    renderer.dispose();
  });

  it('falls back to direct Symbol outlines when overview atlas allocation fails', () => {
    const base = recordingContext();
    const document = chart(1, 1);
    document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
    expect(drawnPaths(base).includes(getSymbolOutline(STAR_ID)?.d ?? '')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === '#abcdef')).toBe(true);
    expect(base.records.filter((call) => call.name === 'fillRect').every((call) =>
      call.fillStyle === document.settings.backgroundColor || call.fillStyle === '#abcdef' || call.fillStyle === DEFAULT_RENDERER_STYLE.offCanvasColor
    )).toBe(true);
    renderer.dispose();
  });

  it('falls back to visible cells when the environment cannot construct Path2D', () => {
    // Path2D is a global capability, not a per-context one, so this is the one
    // remaining way symbol painting can be unavailable. It must degrade to
    // visible cells rather than throwing out of a render pass.
    const real = globalThis.Path2D;
    // @ts-expect-error deliberately removing a DOM global to simulate an old host
    globalThis.Path2D = undefined;
    try {
      const base = recordingContext();
      const document = chart(1, 1);
      document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
      document.kind[0] = CellKind.Full;
      document.colors[0] = 1;
      const renderer = createCanvasRenderer({
        document,
        targets: { base: target(base), overlay: target(recordingContext()) },
        metrics: getCanvasMetrics(32, 32),
        viewport: { x: 0, y: 0, zoom: 1 },
        style: { mode: 'symbol' },
        atlasTargetFactory: () => undefined
      });
      expect(() => renderer.renderNow()).not.toThrow();
      expect(symbolInkCalls(base).length).toBe(0);
      // Symbol-mode geometry is still painted; only the outline is missing.
      expect(base.records.some((call) => call.name === 'fillRect')).toBe(true);
      renderer.dispose();
    } finally {
      globalThis.Path2D = real;
    }
  });

  it('keeps the dense 1000x1000 Symbol overview source within the pixel budget and cached', () => {
    const document = chart(1000, 1000);
    document.palette[0] = { ...document.palette[0], symbol: STAR_ID };
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
    const sourceSymbols = source ? symbolInkCalls(source).length : 0;
    renderer.setViewport({ x: 0, y: 0, zoom: 2 });
    renderer.renderNow();
    expect(builds).toBe(1);
    expect(source ? symbolInkCalls(source).length : 0).toBe(sourceSymbols);
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
    const document = renderer.getDocument();
    expect(atlas.records.some((call) => call.name === 'fillRect' && call.fillStyle === document.settings.backgroundColor && call.args.join(',') === '0,0,2,1')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === DEFAULT_RENDERER_STYLE.offCanvasColor && call.args.join(',') === '0,0,20,10')).toBe(true);
    expect(base.records.some((call) => call.name === 'fillRect' && call.fillStyle === document.settings.backgroundColor && call.args.join(',') === '0,0,2,1')).toBe(true);
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
      .filter(({ call }) => ['fillRect', 'fill', 'stroke', 'strokeRect', 'moveTo', 'lineTo'].includes(call.name))
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

describe('canvas mask and canvas editing', () => {
  const FABRIC = '#aabbcc';

  function fabricChart(width: number, height: number) {
    const document = chart(width, height);
    document.settings = Object.assign({}, document.settings, { backgroundColor: FABRIC });
    return document;
  }

  function maskedChart(width: number, height: number, holes: readonly number[]) {
    const mask = new Uint8Array(width * height).fill(1);
    for (const index of holes) mask[index] = 0;
    return { ...fabricChart(width, height), canvasMask: mask };
  }

  /** Stroked line segments of one color as [x1, y1, x2, y2]; clip paths are not stroked, so they are skipped. */
  function strokes(context: RecordingContext, color: string): number[][] {
    const result: number[][] = [];
    context.records.forEach((call, index) => {
      const start = context.records[index - 1];
      const next = context.records[index + 1];
      if (call.name !== 'lineTo' || call.strokeStyle !== color || start?.name !== 'moveTo' || next?.name !== 'stroke') return;
      result.push([...(start.args as number[]), ...(call.args as number[])]);
    });
    return result;
  }

  function fills(context: RecordingContext, color: string): number[][] {
    return context.records.filter((call) => call.name === 'fillRect' && call.fillStyle === color).map((call) => call.args as number[]);
  }

  const workspace = { x: -2, y: -2, width: 8, height: 8 };

  it('paints off-canvas outside the box and over holes, and fabric only over active cells', () => {
    const document = maskedChart(4, 4, [5]);
    const base = pixelContext(96, 96);
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(96, 96, { dpr: 1 }),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { offCanvasColor: '#111111', showGrid: false }
    });
    renderer.renderNow();

    expect(fills(base, '#111111')).toContainEqual([0, 0, 96, 96]);
    expect(base.pixels[24][24]).toBe('#111111');
    expect(base.pixels[80][80]).toBe('#111111');
    expect(base.pixels[8][8]).toBe(FABRIC);
    expect(base.pixels[24][8]).toBe(FABRIC);
    expect(base.pixels[24][40]).toBe(FABRIC);
    for (const [x, y, width, height] of fills(base, FABRIC)) {
      expect(x < 32 && x + width > 16 && y < 32 && y + height > 16).toBe(false);
    }
    renderer.dispose();
  });

  it('keeps a full rectangle to one fabric fill over the box', () => {
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document: fabricChart(4, 4),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(96, 96, { dpr: 1 }),
      viewport: { x: 0, y: 0, zoom: 16 },
      style: { offCanvasColor: '#111111', showGrid: false }
    });
    renderer.renderNow();

    expect(fills(base, '#111111')).toEqual([[0, 0, 96, 96]]);
    expect(fills(base, FABRIC)).toEqual([[0, 0, 64, 64]]);
    renderer.dispose();
  });

  it('draws grid lines only along edges that border an active cell and outlines the holes', () => {
    const document = maskedChart(4, 4, [1, 2, 5, 6, 9, 10, 13, 14]);
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(64, 64, { dpr: 1 }),
      viewport: { x: 0, y: 0, zoom: 20 },
      style: { gridColor: '#00ff00', midGridColor: '#0000ff', majorGridColor: '#ff0000', gridInterval: 10, midGridInterval: 5, chartBorderColor: '#222222' }
    });
    renderer.renderNow();

    const minor = strokes(base, '#00ff00');
    const verticalXs = new Set(minor.filter(([x1, , x2]) => x1 === x2).map(([x]) => x));
    expect(verticalXs).toEqual(new Set([20, 60]));
    const rowOne = minor.filter(([, y1, , y2]) => y1 === 20 && y2 === 20);
    expect(rowOne).toEqual([[0, 20, 20, 20], [60, 20, 64, 20]]);
    const outline = strokes(base, '#222222');
    // The hole column's sides run the full visible height as single outline segments.
    expect(outline).toContainEqual([20, 0, 20, 64]);
    expect(outline).toContainEqual([60, 0, 60, 64]);
    expect(outline.some(([x1, , x2]) => x1 === 40 && x2 === 40)).toBe(false);
    renderer.dispose();
  });

  it('clips cached outline runs to the view and recomputes them for a new mask', () => {
    const document = maskedChart(6, 6, [14, 15, 20, 21]);
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(40, 40, { dpr: 1 }),
      viewport: { x: 3, y: 0, zoom: 10 },
      style: { chartBorderColor: '#222222', showGrid: false }
    });
    renderer.renderNow();
    // The 2x2 hole spans local columns 2-3 and rows 2-3; the view starts at column 3,
    // so only its right half and right side are visible.
    let outline = strokes(base, '#222222');
    expect(outline).toContainEqual([10, 20, 10, 40]);
    expect(outline).toContainEqual([0, 20, 10, 20]);
    expect(outline).toContainEqual([0, 40, 10, 40]);
    expect(outline.some(([x1, y1, x2, y2]) => x1 === x2 && x1 === 0 && y1 >= 20 && y2 <= 40)).toBe(false);

    base.records.length = 0;
    const moved = new Uint8Array(36).fill(1);
    moved[21] = 0;
    renderer.setDocument({ ...document, canvasMask: moved, revision: document.revision + 1 });
    renderer.renderNow();
    outline = strokes(base, '#222222');
    expect(outline).toContainEqual([0, 30, 0, 40]);
    expect(outline).toContainEqual([10, 30, 10, 40]);
    expect(outline).toContainEqual([0, 30, 10, 30]);
    expect(outline.some(([, y1, , y2]) => y1 === 20 && y2 === 20)).toBe(false);
    renderer.dispose();
  });

  it('draws the ghost grid in the base under the fabric only while canvas editing, within the workspace', () => {
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document: fabricChart(4, 4),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(192, 192, { dpr: 1 }),
      viewport: { x: -4, y: -4, zoom: 16 },
      style: { ghostGridColor: '#00ff00', ghostMajorGridColor: '#ff0000', gridInterval: 10, showGrid: false }
    });
    renderer.renderNow();
    expect(strokes(base, '#00ff00')).toEqual([]);
    expect(strokes(base, '#ff0000')).toEqual([]);

    base.records.length = 0;
    renderer.setOverlay({ canvasEditing: { workspace } });
    renderer.renderNow();
    expect(renderer.lastStats.baseRendered).toBe(true);
    const ghost = strokes(base, '#00ff00');
    expect(ghost.length).toBeGreaterThan(0);
    for (const value of ghost.flat()) {
      expect(value).toBeGreaterThanOrEqual(32);
      expect(value).toBeLessThanOrEqual(160);
    }
    expect(new Set(ghost.filter(([x1, , x2]) => x1 === x2).map(([x]) => x))).toEqual(new Set([32, 48, 80, 96, 112, 128, 144, 160]));
    // Local x = 0 keeps the canvas's major phase; the dashed workspace edge shares the major color.
    const major = base.records.filter((call, index) => call.name === 'lineTo' && call.strokeStyle === '#ff0000' && base.records[index + 1]?.name === 'stroke');
    expect(major.filter((call) => call.lineWidth === 1).map((call) => call.args)).toEqual(expect.arrayContaining([[64, 160], [160, 64]]));
    expect(strokes(base, '#ff0000')).toContainEqual([32, 32, 160, 32]);
    expect(base.records.some((call) => call.name === 'setLineDash')).toBe(true);
    const firstGhost = base.records.findIndex((call) => call.name === 'stroke' && call.strokeStyle === '#00ff00');
    const fabric = base.records.findIndex((call) => call.name === 'fillRect' && call.fillStyle === FABRIC);
    expect(firstGhost).toBeGreaterThanOrEqual(0);
    expect(firstGhost).toBeLessThan(fabric);

    renderer.setOverlay({ canvasEditing: { workspace: { ...workspace } } });
    renderer.renderNow();
    expect(renderer.lastStats.baseRendered).toBe(false);

    base.records.length = 0;
    renderer.setOverlay({});
    renderer.renderNow();
    expect(renderer.lastStats.baseRendered).toBe(true);
    expect(strokes(base, '#00ff00')).toEqual([]);
    expect(strokes(base, '#ff0000')).toEqual([]);
    renderer.dispose();
  });

  it('keeps only major ghost lines at overview zoom and drops them once they crowd together', () => {
    const style = { ghostGridColor: '#00ff00', ghostMajorGridColor: '#ff0000', gridInterval: 10, showGrid: false };
    const base = recordingContext();
    const renderer = createCanvasRenderer({
      document: fabricChart(4, 4),
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(192, 192, { dpr: 1 }),
      viewport: { x: -40, y: -40, zoom: 2 },
      style,
      overlay: { canvasEditing: { workspace: { x: -30, y: -30, width: 64, height: 64 } } }
    });
    renderer.renderNow();
    expect(strokes(base, '#00ff00')).toEqual([]);
    const majorXs = strokes(base, '#ff0000').filter(([x1, , x2]) => x1 === x2).map(([x]) => x);
    // Every tenth local column from -30 to 30, plus the workspace's dashed right edge at local 34.
    expect(new Set(majorXs)).toEqual(new Set([20, 40, 60, 80, 100, 120, 140, 148]));

    base.records.length = 0;
    renderer.setViewport({ x: -40, y: -40, zoom: 0.5 });
    renderer.renderNow();
    expect(strokes(base, '#00ff00')).toEqual([]);
    // Only the four dashed workspace edges remain.
    expect(strokes(base, '#ff0000')).toHaveLength(4);
    renderer.dispose();
  });

  it('previews added, removed and resized canvas cells on the overlay, outside the box too', () => {
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document: fabricChart(4, 4),
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(192, 192, { dpr: 1 }),
      viewport: { x: -4, y: -4, zoom: 16 },
      style: { canvasAddColor: '#00aa00', canvasRemoveColor: '#aa0000', chartBorderColor: '#222222' },
      overlay: { canvasEditing: { workspace, preview: { kind: 'add', rect: { x: -2, y: 0, width: 2, height: 2 }, cells: new Uint8Array([1, 0, 0, 1]) } } }
    });
    renderer.renderNow();
    expect(fills(overlay, '#00aa00')).toEqual([[32, 64, 16, 16], [48, 80, 16, 16]]);
    expect(overlay.records.find((call) => call.name === 'fillRect' && call.fillStyle === '#00aa00')?.globalAlpha).toBe(0.35);

    overlay.records.length = 0;
    renderer.setOverlay({ canvasEditing: { workspace, preview: { kind: 'remove', rect: { x: 1, y: 1, width: 1, height: 1 } } } });
    renderer.renderNow();
    expect(fills(overlay, '#aa0000')).toEqual([[80, 80, 16, 16]]);
    expect(overlay.records.some((call) => call.name === 'clip')).toBe(true);
    const hatch = strokes(overlay, '#aa0000');
    expect(hatch.length).toBeGreaterThan(0);
    // Each hatch line runs diagonally (x + y constant).
    for (const [x1, y1, x2, y2] of hatch) expect(x1 + y1).toBeCloseTo(x2 + y2);

    overlay.records.length = 0;
    renderer.setOverlay({ canvasEditing: { workspace, preview: { kind: 'resize', box: { x: 0, y: 0, width: 6, height: 3 } } } });
    renderer.renderNow();
    expect(fills(overlay, '#00aa00')).toEqual([[128, 64, 32, 48]]);
    expect(fills(overlay, '#aa0000')).toEqual([[64, 112, 64, 16]]);
    expect(strokes(overlay, '#222222')).toEqual(expect.arrayContaining([[64, 64, 160, 64], [160, 64, 160, 112]]));
    expect(overlay.records.some((call) => call.name === 'setLineDash')).toBe(true);
    renderer.dispose();
  });

  describe('selection fill', () => {
    const FILL = 'rgba(34, 102, 204, 0.16)';

    function renderSelection(selection: Record<string, unknown>, viewport = { x: 0, y: 0, zoom: 10 }, extra: Record<string, unknown> = {}): RecordingContext {
      const overlay = recordingContext();
      const renderer = createCanvasRenderer({
        document: chart(3, 3),
        targets: { base: target(recordingContext()), overlay: target(overlay) },
        metrics: getCanvasMetrics(30, 30),
        viewport,
        overlay: { selection, ...extra } as never
      });
      renderer.renderNow();
      renderer.dispose();
      return overlay;
    }

    const fills = (context: RecordingContext) => context.records.filter((call) => call.name === 'fillRect' && call.fillStyle === FILL).map((call) => call.args);

    function sparse(indices: number[]): Record<string, unknown> {
      const geometry = sparseSelectionGeometry(new Uint32Array(indices), 3, 3)!;
      return { rect: geometry.bounds, kind: 'sparse', indices, boundaries: geometry.boundaries };
    }

    it('fills a rect selection', () => {
      expect(fills(renderSelection({ x: 0, y: 1, width: 2, height: 1 }))).toEqual([[0, 10, 20, 10]]);
    });

    it('fills the merged runs of a sparse selection', () => {
      expect(fills(renderSelection(sparse([0, 1, 2, 4])))).toEqual([[0, 0, 30, 10], [10, 10, 10, 10]]);
    });

    it('fills a canvas selection, including cells beyond the canvas', () => {
      const overlay = recordingContext();
      const renderer = createCanvasRenderer({
        document: fabricChart(4, 4),
        targets: { base: target(recordingContext()), overlay: target(overlay) },
        metrics: getCanvasMetrics(192, 192, { dpr: 1 }),
        viewport: { x: -4, y: -4, zoom: 16 },
        style: { selectionColor: '#0000ff' },
        overlay: { canvasEditing: { workspace, selection: { rect: { x: -3, y: 0, width: 3, height: 2 }, cells: new Uint8Array([1, 1, 0, 1, 0, 0]) } } }
      });
      renderer.renderNow();
      expect(fills(overlay)).toEqual([[16, 64, 32, 16], [16, 80, 16, 16]]);

      overlay.records.length = 0;
      renderer.setOverlay({ canvasEditing: { workspace, selection: { rect: { x: -3, y: 0, width: 3, height: 2 } } } });
      renderer.renderNow();
      expect(fills(overlay)).toEqual([[16, 64, 48, 32]]);
      renderer.dispose();
    });

    it('draws the fill before the outline', () => {
      const overlay = renderSelection(sparse([0, 1, 2, 4]));

      const fillAt = overlay.records.findIndex((call) => call.name === 'fillRect' && call.fillStyle === FILL);
      const strokeAt = overlay.records.findIndex((call) => call.name === 'stroke' && call.strokeStyle === '#2266cc');
      expect(fillAt).toBeGreaterThanOrEqual(0);
      expect(strokeAt).toBeGreaterThan(fillAt);
    });

    it('keeps the default fill when the overlay recolors the outline', () => {
      const overlay = renderSelection({ x: 0, y: 0, width: 1, height: 1 }, undefined, { color: '#ff0000' });

      expect(fills(overlay)).toEqual([[0, 0, 10, 10]]);
    });

    it('clips off-screen runs', () => {
      expect(fills(renderSelection(sparse([0, 1, 2, 4]), { x: 1, y: 0, zoom: 10 }))).toEqual([[0, 0, 20, 10], [0, 10, 10, 10]]);
    });

    it('leaves the lasso preview grey', () => {
      const overlay = renderLassoOnly();

      expect(overlay.records.some((call) => call.name === 'fillRect' && call.fillStyle === FILL)).toBe(false);
      expect(overlay.records.some((call) => call.name === 'fillRect' && call.fillStyle === 'rgba(110, 110, 110, 0.28)')).toBe(true);
    });

    function renderLassoOnly(): RecordingContext {
      const overlay = recordingContext();
      const renderer = createCanvasRenderer({
        document: chart(3, 3),
        targets: { base: target(recordingContext()), overlay: target(overlay) },
        metrics: getCanvasMetrics(30, 30),
        viewport: { x: 0, y: 0, zoom: 10 },
        overlay: { lassoPath: { points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }], start: { x: 1, y: 1 }, preview: { runs: [{ x: 1, y: 1, width: 1 }], boundaries: [] } } }
      });
      renderer.renderNow();
      renderer.dispose();
      return overlay;
    }
  });

  it('outlines a canvas selection that lies outside the box', () => {
    const overlay = recordingContext();
    const renderer = createCanvasRenderer({
      document: fabricChart(4, 4),
      targets: { base: target(recordingContext()), overlay: target(overlay) },
      metrics: getCanvasMetrics(192, 192, { dpr: 1 }),
      viewport: { x: -4, y: -4, zoom: 16 },
      style: { selectionColor: '#0000ff' },
      overlay: { canvasEditing: { workspace, selection: { rect: { x: -3, y: 0, width: 3, height: 2 }, cells: new Uint8Array([1, 1, 0, 1, 0, 0]) } } }
    });
    renderer.renderNow();
    const outline = strokes(overlay, '#0000ff');
    expect(outline.length).toBeGreaterThan(0);
    for (const [x1, y1, x2, y2] of outline) {
      for (const x of [x1, x2]) expect(x >= 16 && x <= 48).toBe(true);
      for (const y of [y1, y2]) expect(y >= 64 && y <= 96).toBe(true);
    }
    expect(outline.some(([x1, , x2]) => x1 === 16 && x2 === 16)).toBe(true);

    overlay.records.length = 0;
    renderer.setOverlay({ canvasEditing: { workspace, selection: { rect: { x: -3, y: 0, width: 3, height: 2 } } } });
    renderer.renderNow();
    expect(strokes(overlay, '#0000ff')).toContainEqual([16, 64, 64, 64]);

    overlay.records.length = 0;
    renderer.setOverlay({ showSelection: false, canvasEditing: { workspace, selection: { rect: { x: -3, y: 0, width: 3, height: 2 } } } });
    renderer.renderNow();
    expect(strokes(overlay, '#0000ff')).toEqual([]);
    renderer.dispose();
  });

  it('leaves holes transparent in the overview atlas and rebuilds it when the mask changes', () => {
    const atlasSources: Array<{ context: RecordingContext; width: number }> = [];
    const base = recordingContext();
    const document = maskedChart(2, 1, [1]);
    const renderer = createCanvasRenderer({
      document,
      targets: { base: target(base), overlay: target(recordingContext()) },
      metrics: getCanvasMetrics(2, 1),
      viewport: { x: 0, y: 0, zoom: 1 },
      atlasTargetFactory: (width, height) => {
        const context = recordingContext();
        atlasSources.push({ context, width });
        return target(context, new FakeCanvasImageSource(width, height));
      }
    });
    renderer.renderNow();
    expect(atlasSources).toHaveLength(1);
    const pixelsPerCell = atlasSources[0].width / 2;
    expect(fills(atlasSources[0].context, FABRIC)).toEqual([[0, 0, pixelsPerCell, pixelsPerCell]]);
    // The atlas carries the fabric, so the base does not walk the mask at overview.
    expect(fills(base, FABRIC)).toEqual([]);

    renderer.setDocument({ ...document, canvasMask: new Uint8Array([0, 1]), revision: document.revision + 1 });
    renderer.renderNow();
    expect(atlasSources).toHaveLength(2);
    expect(fills(atlasSources[1].context, FABRIC)).toEqual([[pixelsPerCell, 0, pixelsPerCell, pixelsPerCell]]);
    renderer.dispose();
  });
});
