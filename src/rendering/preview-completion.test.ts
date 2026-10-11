import { describe, expect, it } from 'vitest';
import { CellKind, createDocument } from '../domain';
import { getCanvasMetrics } from '../editor/coordinates';
import type { CanvasContextAdapter, CanvasTarget, RendererStyle } from '../editor/contracts';
import { ThreeQuarterPair } from '../editor/cell-kinds';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { createCanvasRenderer } from './renderer';

type Call = [string, ...unknown[]];

/** Every painter call with the style it ran under, so two renders compare exactly. */
function recordingTarget(): { target: CanvasTarget; calls: Call[] } {
  const calls: Call[] = [];
  const context: CanvasContextAdapter = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    clearRect: () => undefined,
    fillRect: (...args) => void calls.push(['fillRect', context.fillStyle, context.globalAlpha, ...args]),
    beginPath: () => undefined,
    moveTo: (...args) => void calls.push(['moveTo', ...args]),
    lineTo: (...args) => void calls.push(['lineTo', ...args]),
    fill: () => void calls.push(['fill', context.fillStyle, context.globalAlpha]),
    stroke: () => void calls.push(['stroke', context.strokeStyle, context.lineWidth, context.lineCap, context.globalAlpha]),
    save: () => undefined,
    restore: () => undefined,
    setTransform: () => undefined
  };
  return { target: { context, width: 0, height: 0, resize() {} }, calls };
}

function sampleDocument(completed: boolean) {
  const document = createDocument({
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    width: 4,
    height: 2,
    palette: [
      { id: 1, name: 'Red', color: '#ff0000' },
      { id: 35, name: 'Blue', color: '#0000ff' }
    ]
  });
  document.kind[0] = CellKind.Full;
  document.colors[0] = 1;
  document.kind[1] = CellKind.HalfBackslash;
  document.colors[4] = 35;
  document.kind[2] = ThreeQuarterPair;
  document.colors.set([1, 0, 35, 0], 8);
  document.kind[3] = CellKind.Full;
  document.colors[12] = 35;
  document.backstitches = {
    ids: new Uint32Array([1]),
    x1: new Uint32Array([0]),
    y1: new Uint32Array([0]),
    x2: new Uint32Array([16]),
    y2: new Uint32Array([0]),
    colors: new Uint16Array([1]),
    completed: new Uint8Array([completed ? 1 : 0])
  };
  document.nextBackstitchId = 2;
  if (completed) {
    document.completed[0] = 1;
    document.completed[1] = 1;
    document.completed[2] = 5;
    document.completed[3] = 1;
  }
  return document;
}

const DETAIL_ZOOM = 16;
const OVERVIEW_ZOOM = 2;

function render(completed: boolean, style: Partial<RendererStyle>, zoom = DETAIL_ZOOM): Call[] {
  const base = recordingTarget();
  const renderer = createCanvasRenderer({
    document: sampleDocument(completed),
    targets: { base: base.target, overlay: recordingTarget().target },
    metrics: getCanvasMetrics(64, 32),
    viewport: { x: 0, y: 0, zoom },
    style,
    // No atlas target: the renderer paints cell by cell, and jsdom's canvas is never touched.
    atlasTargetFactory: () => undefined
  });
  renderer.renderNow();
  renderer.dispose();
  return base.calls;
}

describe('Preview completion suppression', () => {
  describe.each([['detail', DETAIL_ZOOM], ['overview', OVERVIEW_ZOOM]] as const)('at %s level of detail', (_name, zoom) => {
    it.each([
      ['flat', { mode: 'color' as const }],
      ['symbols', { mode: 'symbol' as const }],
      ['threads', { mode: 'color' as const, threadView: true, showGrid: false }]
    ])('draws the same calls with completion planes set or unset in the %s view when showCompletion is off', (_view, style) => {
      const withMarks = render(true, { ...style, showCompletion: false }, zoom);
      expect(withMarks.length).toBeGreaterThan(0);
      expect(withMarks).toEqual(render(false, { ...style, showCompletion: false }, zoom));
    });
  });

  it.each([['detail', DETAIL_ZOOM], ['overview', OVERVIEW_ZOOM]])('is a real effect at %s: the same document differs with showCompletion on', (_name, zoom) => {
    const style = { mode: 'color' as const, showCompletion: true };
    expect(render(true, style, zoom)).not.toEqual(render(false, style, zoom));
  });

  it('paints thread strokes at detail zoom', () => {
    const calls = render(true, { showCompletion: false, threadView: true, showGrid: false });
    expect(calls.some((call) => call[0] === 'stroke' && call[3] === 'round')).toBe(true);
  });

  it('keeps the thread view subject to the same suppression even when showCompletion is on', () => {
    const style = { showCompletion: true, threadView: true, showGrid: false };
    expect(render(true, style)).toEqual(render(false, style));
  });

  it('falls back to flat cells below the thread detail size', () => {
    const calls = render(false, { showCompletion: false, threadView: true, showGrid: false }, 2);
    expect(calls.some((call) => call[0] === 'stroke' && call[3] === 'round')).toBe(false);
    expect(calls.some((call) => call[0] === 'fillRect')).toBe(true);
  });
});
