import { describe, expect, it, vi } from 'vitest';
import { CellKind, createDocument, createEditor, type CommandResult, type DomainCommand, type PatternDocument } from '../domain';
import { getCanvasMetrics } from './coordinates';
import { EditorSurfaceController, type EditorSurfaceControllerOptions } from './controller';
import { StaleEditorTransactionError, type EditorRevisionToken, type EditorTransaction, type WorkspaceEditorGateway, type WorkspaceEditorSnapshot } from './gateway';
import { createUiStore } from './ui-store';
import { nearestDmcColor } from '../catalog';
import type { CanvasRenderer, Invalidation, OverlayState, RendererStyle, RenderStats, TraceImage, TraceRgb, Viewport } from './contracts';
import type { PointerSample } from './input';

class FakeGateway implements WorkspaceEditorGateway {
  private editor: ReturnType<typeof createEditor>;
  private project = 'project-a';
  private readonly listeners = new Set<(snapshot: WorkspaceEditorSnapshot) => void>();
  readonly commands: DomainCommand[] = [];

  constructor(document = createDocument({ width: 8, height: 8, palette: [{ id: 1, name: 'Thread', color: '#123456' }] })) {
    this.editor = createEditor(document);
  }

  getSnapshot(): WorkspaceEditorSnapshot {
    return { projectId: this.project, revision: this.editor.revision, document: this.editor.document };
  }

  get undoDepth(): number {
    return this.editor.undoDepth;
  }

  getDocumentSnapshot(): WorkspaceEditorSnapshot {
    return this.getSnapshot();
  }

  subscribe(listener: (snapshot: WorkspaceEditorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginTransaction(): EditorTransaction {
    const token = this.token();
    let committed = false;
    return {
      token,
      commit: (command) => {
        if (committed) throw new StaleEditorTransactionError(token, this.getSnapshot());
        const result = this.execute(command, token);
        committed = true;
        return result;
      },
      commitBatch: (commands) => {
        if (committed) throw new StaleEditorTransactionError(token, this.getSnapshot());
        const result = this.executeBatch(commands, token);
        committed = true;
        return result;
      }
    };
  }

  execute(command: DomainCommand, expected?: EditorRevisionToken): CommandResult {
    this.assertToken(expected);
    this.commands.push(command);
    const result = this.editor.execute(command);
    this.emit();
    return result;
  }

  executeBatch(commands: readonly DomainCommand[], expected?: EditorRevisionToken): CommandResult {
    this.assertToken(expected);
    const result = this.editor.executeBatch(commands);
    this.emit();
    return result;
  }

  undo(expected?: EditorRevisionToken): CommandResult {
    this.assertToken(expected);
    const result = this.editor.undo();
    this.emit();
    return result;
  }

  redo(expected?: EditorRevisionToken): CommandResult {
    this.assertToken(expected);
    const result = this.editor.redo();
    this.emit();
    return result;
  }

  switchProject(): void {
    this.project = 'project-b';
    this.editor = createEditor(createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    this.emit();
  }

  dispose(): void {}

  private token(): EditorRevisionToken {
    return { projectId: this.project, revision: this.editor.revision };
  }

  private assertToken(expected: EditorRevisionToken | undefined): void {
    const actual = this.getSnapshot();
    if (expected && (expected.projectId !== actual.projectId || expected.revision !== actual.revision)) throw new StaleEditorTransactionError(expected, actual);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function rendererFixture() {
  let viewport: Viewport = { x: 0, y: 0, zoom: 16 };
  const calls = {
    setDocument: [] as Array<{ document: PatternDocument; invalidation?: Invalidation }>,
    setViewport: [] as Viewport[],
    setMetrics: [] as unknown[],
    setStyle: [] as Partial<RendererStyle>[],
    setOverlay: [] as OverlayState[],
    setPatternDimmed: [] as boolean[]
  };
  let traceImage: TraceImage | undefined;
  const renderer = {
    lastStats: { lod: 'detail', visitedCells: 0, drawnCells: 0, drawnBackstitches: 0, baseRendered: false, overlayRendered: false } as RenderStats,
    getDocument: () => undefined,
    getViewport: () => viewport,
    getStyle: () => ({}) as RendererStyle,
    getTraceImage: () => traceImage,
    setDocument: (document: PatternDocument, invalidation?: Invalidation) => calls.setDocument.push({ document, invalidation }),
    setViewport: (next: Viewport) => { viewport = next; calls.setViewport.push(next); },
    setMetrics: (metrics: unknown) => calls.setMetrics.push(metrics),
    setStyle: (style: Partial<RendererStyle>) => calls.setStyle.push(style),
    setTraceImage: (next: TraceImage | undefined) => { traceImage = next; },
    clearTraceImage: () => { traceImage = undefined; },
    setOverlay: (overlay: OverlayState) => calls.setOverlay.push(overlay),
    setPatternDimmed: (dimmed: boolean) => { calls.setPatternDimmed.push(dimmed); },
    invalidate: () => undefined,
    requestRender: () => undefined,
    render: () => renderer.lastStats,
    renderNow: () => renderer.lastStats,
    getLastInvalidation: () => ({ base: false, overlay: false, reasons: [] }),
    dispose: () => undefined,
    destroy: () => undefined
  } as unknown as CanvasRenderer;
  return { renderer, calls };
}

function pointer(pointerId: number, screenX: number, screenY: number, pointerType = 'mouse', button = 0): PointerSample {
  return { pointerId, pointerType, screenX, screenY, button, buttons: button === 0 ? 1 : 4, isPrimary: true };
}

function controllerFixture(options: Partial<EditorSurfaceControllerOptions> = {}) {
  const gateway = new FakeGateway();
  const uiStore = createUiStore();
  const renderer = rendererFixture();
  const controller = new EditorSurfaceController({ gateway, uiStore, renderer: renderer.renderer, metrics: getCanvasMetrics(128, 128), ...options });
  controller.start();
  return { gateway, uiStore, controller, ...renderer };
}

describe('EditorSurfaceController', () => {
  it('adds the nearest DMC color to the palette and activates the paint brush when sampling the reference image', () => {
    const sampled: TraceRgb[] = [];
    const trace: TraceImage = { source: {}, width: 4, height: 4 };
    const rgb = { r: 12, g: 34, b: 56 };
    const { gateway, uiStore, controller } = controllerFixture({
      traceImage: trace,
      traceSampler: () => ({ ...rgb }),
      onTraceSample: (value) => sampled.push(value)
    });
    controller.setTool({ tool: 'eyedropper' });
    const matched = nearestDmcColor(rgb);
    expect(matched).toBeDefined();
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(sampled).toEqual([{ ...rgb }]);
    const create = gateway.commands.find((command) => command.type === 'palette-create');
    expect(create).toMatchObject({ type: 'palette-create', name: matched!.name, color: matched!.hex, active: true });
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === matched!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: added!.id } });
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    controller.dispose();
  });

  it('activates the eyedropper at the keyboard cursor and adds the matched color to the palette', () => {
    const sampled: TraceRgb[] = [];
    const points: Array<{ x: number; y: number }> = [];
    const rgb = { r: 201, g: 102, b: 3 };
    const { gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: (_trace, _document, _viewport, _metrics, point) => {
        points.push(point);
        return { ...rgb };
      },
      onTraceSample: (value) => sampled.push(value)
    });
    uiStore.setKeyboardCursor({ x: 2, y: 3 });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handleKeyDown({ key: 'Enter' })).toBe(true);
    expect(points).toEqual([{ x: 40, y: 56 }]);
    expect(sampled).toEqual([{ ...rgb }]);
    expect(gateway.commands.some((command) => command.type === 'palette-create')).toBe(true);
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === nearestDmcColor(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    controller.dispose();
  });

  it('uses the keyboard cursor for trace sampling and adds the matched color to the palette', () => {
    const sampled: TraceRgb[] = [];
    const rgb = { r: 7, g: 8, b: 9 };
    const { gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ ...rgb }),
      onTraceSample: (value) => sampled.push(value)
    });
    uiStore.setKeyboardCursor({ x: 3, y: 4 });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(true);
    expect(sampled).toEqual([{ ...rgb }]);
    expect(gateway.commands.some((command) => command.type === 'palette-create')).toBe(true);
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === nearestDmcColor(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: added!.id } });
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    controller.dispose();
  });

  it('eyedroppers a chart cell palette color and activates the paint brush', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    controller.setTool({ tool: 'eyedropper' });
    const before = gateway.commands.length;
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(uiStore.getState().paletteId).toBe(1);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(gateway.commands.length).toBe(before);
    controller.dispose();
  });

  it('eyedroppers an empty cell of the reference image and adds the closest DMC color to the palette', () => {
    const sampled: TraceRgb[] = [];
    const rgb = { r: 18, g: 52, b: 86 };
    const { gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ ...rgb }),
      onTraceSample: (value) => sampled.push(value)
    });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(sampled).toEqual([{ ...rgb }]);
    expect(gateway.commands.some((command) => command.type === 'palette-create')).toBe(true);
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === nearestDmcColor(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: added!.id } });
    controller.dispose();
  });

  it('supersedes a pending eyedropper color when another unused color is activated', () => {
    const rgb1 = { r: 18, g: 52, b: 86 };
    const { gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ ...rgb1 })
    });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    const pending = uiStore.getState().pendingPaletteId;
    expect(pending).not.toBeNull();

    gateway.execute({ type: 'palette-create', name: 'Purple', color: '#66AA22', catalog: { catalogId: 'c', sourceId: 's', code: 'P9', name: 'Purple', hex: '#66AA22', rgb: [102, 170, 34] } });
    const created = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === 'P9');
    expect(created).toBeDefined();

    controller.selectPalette(created!.id);
    expect(gateway.getSnapshot().document?.palette.find((entry) => entry.id === pending)?.active).toBe(false);
    expect(uiStore.getState().pendingPaletteId).toBe(created!.id);
    expect(uiStore.getState().paletteId).toBe(created!.id);
    controller.dispose();
  });

  it('highlights an already-referenced palette color without disturbing the pending entry', () => {
    const rgb = { r: 18, g: 52, b: 86 };
    const { gateway, uiStore, controller } = controllerFixture({ traceImage: { source: {}, width: 4, height: 4 }, traceSampler: () => ({ ...rgb }) });
    gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    const pending = uiStore.getState().pendingPaletteId;
    const commands = gateway.commands.slice();

    controller.selectPalette(1);
    expect(uiStore.getState().paletteId).toBe(1);
    expect(gateway.commands.slice()).toEqual(commands);
    expect(uiStore.getState().pendingPaletteId).toBe(pending);
    controller.dispose();
  });

  it('processes the final pointer-up sample before its single commit', () => {
    const { gateway, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 72, 8));
    expect(gateway.commands).toHaveLength(1);
    expect(gateway.commands[0].type).toBe('bulk-cell');
    expect(gateway.commands[0].indices).toEqual(new Uint32Array([0, 1, 2, 3, 4]));
    controller.dispose();

    const finalSegment = controllerFixture();
    finalSegment.controller.handlePointerDown(pointer(1, 8, 8));
    finalSegment.controller.handlePointerMove(pointer(1, 24, 8));
    finalSegment.controller.handlePointerUp(pointer(1, 72, 8));
    expect(finalSegment.gateway.commands).toHaveLength(1);
    expect(finalSegment.gateway.commands[0].indices).toEqual(new Uint32Array([0, 1, 2, 3, 4]));
    finalSegment.controller.dispose();
  });

  it('uses unclamped paint hit testing and drops paint on cancellation or lost capture', () => {
    const outside = controllerFixture();
    expect(outside.controller.handlePointerDown(pointer(1, -1, -1))).toBe(false);
    outside.controller.handlePointerUp(pointer(1, -1, -1));
    expect(outside.gateway.commands).toHaveLength(0);
    outside.controller.handlePointerDown(pointer(2, 56, 8));
    outside.controller.handlePointerMove(pointer(2, 300, 8));
    outside.controller.handlePointerUp(pointer(2, 300, 8));
    expect(outside.gateway.commands[0].indices).toEqual(new Uint32Array([3]));
    outside.controller.dispose();

    const cancelled = controllerFixture();
    cancelled.controller.handlePointerDown(pointer(1, 8, 8));
    cancelled.controller.handlePointerMove(pointer(1, 40, 8));
    expect(cancelled.uiStore.getState().overlay.pendingCells).toHaveLength(3);
    cancelled.controller.handlePointerCancel(pointer(1, 40, 8));
    expect(cancelled.gateway.commands).toHaveLength(0);
    expect(cancelled.uiStore.getState().overlay.pendingCells).toBeUndefined();
    cancelled.controller.handlePointerUp(pointer(1, 40, 8));
    expect(cancelled.gateway.commands).toHaveLength(0);

    cancelled.controller.handlePointerDown(pointer(2, 8, 8));
    cancelled.controller.handlePointerMove(pointer(2, 40, 8));
    cancelled.controller.handlePointerLostCapture(pointer(2, 40, 8));
    expect(cancelled.gateway.commands).toHaveLength(0);
    expect(cancelled.uiStore.getState().overlay.pendingCells).toBeUndefined();
    cancelled.controller.dispose();
  });

  it('suspends interpolation across off-chart travel and starts a new origin on re-entry', () => {
    const horizontal = controllerFixture();
    horizontal.controller.handlePointerDown(pointer(1, 24, 40));
    horizontal.controller.handlePointerMove(pointer(1, 40, 40));
    horizontal.controller.handlePointerMove(pointer(1, 220, 40));
    horizontal.controller.handlePointerMove(pointer(1, 88, 40));
    horizontal.controller.handlePointerUp(pointer(1, 88, 40));
    expect(horizontal.gateway.commands[0].indices).toEqual(new Uint32Array([17, 18, 21]));
    horizontal.controller.dispose();

    const vertical = controllerFixture();
    vertical.controller.handlePointerDown(pointer(1, 8, 8));
    vertical.controller.handlePointerMove(pointer(1, 8, 40));
    vertical.controller.handlePointerMove(pointer(1, 8, -80));
    vertical.controller.handlePointerMove(pointer(1, 8, 88));
    vertical.controller.handlePointerUp(pointer(1, 8, 88));
    expect(vertical.gateway.commands[0].indices).toEqual(new Uint32Array([0, 8, 16, 40]));
    vertical.controller.dispose();

    const reverse = controllerFixture();
    reverse.controller.handlePointerDown(pointer(1, 104, 104));
    reverse.controller.handlePointerMove(pointer(1, 88, 104));
    reverse.controller.handlePointerMove(pointer(1, -80, 104));
    reverse.controller.handlePointerMove(pointer(1, 40, 104));
    reverse.controller.handlePointerUp(pointer(1, 40, 104));
    expect(reverse.gateway.commands[0].indices).toEqual(new Uint32Array([50, 53, 54]));
    reverse.controller.dispose();
  });

  it('keeps a paint stroke transient and commits one deduplicated bulk command', () => {
    const { gateway, uiStore, controller, calls } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 72, 8));
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    expect(uiStore.getState().overlay.pendingCells).toHaveLength(5);
    expect(uiStore.getState().overlay.pendingCellStates?.slice(0, 2)).toMatchObject([
      { index: 0, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 1, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerMove(pointer(1, 40, 8));
    controller.handlePointerUp(pointer(1, 40, 8));
    expect(gateway.getSnapshot().document?.kind.slice(0, 5)).toEqual(new Uint8Array([1, 1, 1, 1, 1]));
    expect(calls.setDocument).toHaveLength(2);
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({ layer: 'base', cellRect: { x: 0, y: 0, width: 5, height: 1 } });
    expect(uiStore.getState().overlay.pendingCells).toBeUndefined();
    expect(uiStore.getState().status).toBe('Painted 5 cells');
    expect(gateway.undoDepth).toBe(1);
    gateway.undo({ projectId: 'project-a', revision: 1 });
    expect(gateway.getSnapshot().document?.kind.slice(0, 5)).toEqual(new Uint8Array(5));
    expect(gateway.undoDepth).toBe(0);
    controller.dispose();
  });

  it('previews and commits both diagonal half-stitch authoring variants', () => {
    const slash = controllerFixture();
    slash.controller.setAuthoringBrush({ kind: 'half', direction: '/', paletteId: 1 });
    slash.controller.handlePointerDown(pointer(1, 8, 8));
    expect(slash.uiStore.getState().overlay.pendingCellStates).toMatchObject([{ kind: CellKind.HalfSlash, colors: [1, 0, 0, 0] }]);
    slash.controller.handlePointerUp(pointer(1, 8, 8));
    expect(slash.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.HalfSlash);
    slash.controller.dispose();

    const backslash = controllerFixture();
    backslash.controller.setAuthoringBrush({ kind: 'half', direction: '\\', paletteId: 1 });
    backslash.controller.handlePointerDown(pointer(1, 8, 8));
    expect(backslash.uiStore.getState().overlay.pendingCellStates).toMatchObject([{ kind: CellKind.HalfBackslash }]);
    backslash.controller.handlePointerUp(pointer(1, 8, 8));
    expect(backslash.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.HalfBackslash);
    backslash.controller.dispose();
  });

  it('discards cancelled paint once and rejects a stale stroke', () => {
    const { gateway, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 40, 8));
    gateway.execute({ type: 'bulk-cell', indices: new Uint32Array([20]), edit: { kind: 'full', color: 1 } });
    controller.handlePointerCancel(pointer(1, 40, 8));
    controller.handlePointerCancel(pointer(1, 40, 8));
    expect(gateway.getSnapshot().document?.kind[0]).toBe(0);
    controller.dispose();

    const second = controllerFixture();
    second.controller.handlePointerDown(pointer(1, 8, 8));
    second.controller.handlePointerMove(pointer(1, 40, 8));
    second.controller.handlePointerCancel(pointer(1, 40, 8));
    expect(second.gateway.getSnapshot().document?.kind[0]).toBe(0);
    second.controller.handlePointerUp(pointer(1, 40, 8));
    expect(second.gateway.getSnapshot().document?.revision).toBe(0);
    second.controller.dispose();
  });

  it('pans touch and pinch gestures without painting, and anchors wheel zoom', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 24, 24, 'touch'));
    controller.handlePointerMove(pointer(1, 4, 24, 'touch'));
    expect(gateway.getSnapshot().document?.revision).toBe(0);
    controller.handlePointerDown(pointer(2, 44, 24, 'touch'));
    controller.handlePointerMove(pointer(2, 84, 24, 'touch'));
    expect(uiStore.getState().viewport.zoom).toBeGreaterThan(16);
    controller.handlePointerUp(pointer(1, 4, 24, 'touch'));
    controller.handlePointerUp(pointer(2, 84, 24, 'touch'));
    const before = uiStore.getState().viewport;
    controller.handleWheel({ screenX: 64, screenY: 64, deltaY: -100 });
    expect(uiStore.getState().viewport.zoom).toBeGreaterThan(before.zoom);
    expect(gateway.getSnapshot().document?.revision).toBe(0);
    controller.dispose();
  });

  it('reserves Space for temporary pan and clears the modifier on stop and text targets', () => {
    const first = controllerFixture();
    first.controller.handleKeyDown({ key: 'Space', preventDefault: () => undefined });
    expect(first.gateway.commands).toHaveLength(0);
    first.controller.handleKeyUp({ key: 'Space' });
    first.controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(first.gateway.commands).toHaveLength(1);
    first.controller.stop();
    first.controller.handlePointerDown(pointer(2, 8, 8));
    first.controller.handlePointerMove(pointer(2, 24, 8));
    first.controller.handlePointerUp(pointer(2, 24, 8));
    expect(first.gateway.commands).toHaveLength(2);
    expect(first.controller.handleKeyDown({ key: 'Space', target: { tagName: 'INPUT' } })).toBe(false);
    expect(first.controller.handleKeyUp({ key: 'Space', target: { tagName: 'INPUT' } })).toBe(false);
    first.controller.dispose();
  });

  it('rebases an explicit pinch pair when one active pointer lifts and ignores extras', () => {
    const { controller, uiStore, gateway } = controllerFixture();
    controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    controller.handlePointerMove(pointer(2, 100, 20, 'touch'));
    const zoomed = uiStore.getState().viewport;
    controller.handlePointerDown(pointer(3, 400, 400, 'touch'));
    controller.handlePointerMove(pointer(3, 1, 1, 'touch'));
    expect(uiStore.getState().viewport).toEqual(zoomed);
    controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    const rebased = uiStore.getState().viewport;
    controller.handlePointerMove(pointer(2, 100, 20, 'touch'));
    expect(uiStore.getState().viewport).toEqual(rebased);
    expect(gateway.commands).toHaveLength(0);
    controller.handlePointerCancel(pointer(2, 100, 20, 'touch'));
    controller.handlePointerCancel(pointer(3, 1, 1, 'touch'));
    controller.dispose();
  });

  it('updates metrics, viewport projection, fit behavior, and selected-cell semantics', () => {
    const { gateway, uiStore, controller, calls } = controllerFixture();
    const metrics = getCanvasMetrics(64, 64, { dpr: 2 });
    controller.setMetrics(metrics);
    expect(calls.setMetrics).toContain(metrics);
    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    expect(uiStore.getState().selectedCell).toMatchObject({ row: 1, column: 2, geometry: 'empty', paletteId: null, completion: { summary: 'No stitch' } });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(uiStore.getState().selectedCell).toMatchObject({ row: 1, column: 2, geometry: 'full', paletteId: 1, paletteName: 'Thread', completion: { completed: 0, total: 1 } });
    expect(uiStore.getState().status).toBe('Painted cell (1, 0)');
    gateway.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
    expect(uiStore.getState().selectedCell?.geometry).toBe('full');
    controller.handleKeyDown({ key: '0', preventDefault: () => undefined });
    expect(uiStore.getState().viewport.zoom).toBeGreaterThan(0);
    controller.dispose();
  });

  it('fills the whole pattern with the Fit routine', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    uiStore.setViewport({ x: 2, y: 2, zoom: 64 });
    controller.handleKeyDown({ key: '0', preventDefault: () => undefined });
    const viewport = uiStore.getState().viewport;
    const document = gateway.getSnapshot().document!;
    expect(viewport.zoom).toBe(128 / Math.max(document.width, document.height));
    expect(viewport.x).toBeLessThanOrEqual(0);
    expect(viewport.y).toBeLessThanOrEqual(0);
    expect(viewport.x + 128 / viewport.zoom).toBeGreaterThanOrEqual(document.width);
    expect(viewport.y + 128 / viewport.zoom).toBeGreaterThanOrEqual(document.height);
    controller.dispose();
  });

  it('updates the rendered document without recreating interaction state', () => {
    const { controller, uiStore, calls, gateway } = controllerFixture();
    const viewport = { x: 3, y: -2, zoom: 20 };
    const brush = { kind: 'half', direction: '/', paletteId: 1 } as const;
    uiStore.setViewport(viewport);
    controller.setBrushSize(4);
    controller.setAuthoringBrush(brush);
    uiStore.setKeyboardCursor({ x: 2, y: 3 });
    const next = createDocument({ width: 12, height: 6, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
    next.revision = gateway.getSnapshot().revision! + 1;

    controller.setDocument(next);

    expect(calls.setDocument.at(-1)).toMatchObject({
      document: next,
      invalidation: { layer: 'all', full: true, reason: 'external-document' }
    });
    expect(uiStore.getState().viewport).toEqual(viewport);
    expect(uiStore.getState().brushSize).toBe(4);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush });
    expect(uiStore.getState().keyboardCursor).toEqual({ x: 2, y: 3 });
    expect(uiStore.getState().selectedCell).toMatchObject({ row: 4, column: 3, geometry: 'empty' });
    expect(gateway.getSnapshot().document).not.toBe(next);
    controller.dispose();
  });

  it('projects UI state one way, supports keyboard editing/history, and ignores text controls', () => {
    const { gateway, uiStore, controller, calls } = controllerFixture();
    uiStore.setViewport({ x: 1, y: 2, zoom: 20 });
    uiStore.setMode('symbol');
    expect(calls.setViewport.at(-1)).toEqual({ x: 1, y: 2, zoom: 20 });
    expect(calls.setStyle.at(-1)).toEqual({ mode: 'symbol' });
    let prevented = 0;
    expect(controller.handleKeyDown({ key: 'ArrowRight', target: { tagName: 'INPUT' }, preventDefault: () => { prevented += 1; } })).toBe(false);
    expect(prevented).toBe(0);
    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented += 1; } });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1; } });
    expect(gateway.getSnapshot().document?.revision).toBe(1);
    controller.handleKeyUp({ key: 'Space' });
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => { prevented += 1; } });
    expect(gateway.getSnapshot().document?.revision).toBe(2);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, shiftKey: true, preventDefault: () => { prevented += 1; } });
    expect(gateway.getSnapshot().document?.revision).toBe(3);
    expect(uiStore.getState().status).toBe('Redid action');
    controller.dispose();
  });

  it('toggles grid visibility as session-scoped view state', () => {
    const { uiStore, controller, calls, gateway } = controllerFixture();
    expect(uiStore.getState().gridVisible).toBe(true);
    expect(calls.setStyle[0]).toMatchObject({ showGrid: true });
    controller.setGridVisible(false);
    expect(uiStore.getState().gridVisible).toBe(false);
    expect(calls.setStyle.at(-1)).toEqual({ showGrid: false });
    controller.setGridVisible(true);
    expect(uiStore.getState().gridVisible).toBe(true);
    expect(calls.setStyle.at(-1)).toEqual({ showGrid: true });
    expect(gateway.undoDepth).toBe(0);
    controller.dispose();
  });

  it('deletes a selection before falling back to cursor or selected-backstitch deletion', () => {
    const { gateway, uiStore, controller, calls } = controllerFixture();
    gateway.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    gateway.execute({ type: 'set-completion', x: 1, y: 1, completed: true });
    gateway.execute({ type: 'set-full', x: 2, y: 2, color: 1 });
    gateway.execute({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 12 }, color: 1 });
    gateway.execute({ type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 12, y: 12 }, color: 1 });
    const historyBeforeDelete = gateway.undoDepth;
    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });

    expect(controller.handleKeyDown({ key: 'Delete', preventDefault: () => undefined })).toBe(true);
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'delete-region', x: 1, y: 1, width: 2, height: 2 });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.completed[9]).toBe(0);
    expect(gateway.getSnapshot().document?.backstitches.ids).toEqual(new Uint32Array([2]));
    expect(controller.getSelection()).toBeUndefined();
    expect(gateway.undoDepth).toBe(historyBeforeDelete + 1);
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({ layer: 'base', full: true });
    expect(calls.setDocument.at(-1)?.invalidation?.cellRect).toBeUndefined();

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.backstitches.ids).toEqual(new Uint32Array([1, 2]));
    expect(uiStore.getState().status).toBe('Undid action');
    controller.dispose();
  });

  it('rejects non-finite pointer, wheel, selection, and keyboard coordinates without touching cell zero', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    const invalid = (screenX: number, screenY: number): PointerSample => pointer(1, screenX, screenY);
    expect(controller.handlePointerDown(invalid(Number.NaN, 8))).toBe(false);
    expect(controller.handlePointerDown(invalid(Number.POSITIVE_INFINITY, 8))).toBe(false);
    expect(controller.setSelection({ x: Number.NaN, y: 0 })).toBeUndefined();
    expect(controller.handleWheel({ screenX: 8, screenY: Number.NaN, deltaY: -100 })).toBe(false);
    expect(controller.handlePointerDown(pointer(2, 8, 8))).toBe(true);
    expect(controller.handlePointerUp(invalid(Number.NaN, 8))).toBe(false);
    expect(gateway.commands).toHaveLength(0);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    uiStore.setKeyboardCursor({ x: Number.POSITIVE_INFINITY, y: 0 });
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(true);
    expect(gateway.commands).toHaveLength(0);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('clips centered paint brush stamps at chart edges and previews exact after-states', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    expect(uiStore.getState().brushSize).toBe(1);
    controller.setBrushSize(3);
    expect(uiStore.getState().brushSize).toBe(3);
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.pendingCells).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }
    ]);
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { index: 0, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 1, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 8, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 9, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerUp(pointer(1, 8, 8));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 8, 9]) });
    expect(gateway.getSnapshot().document?.kind.slice(0, 2)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full]));
    expect(gateway.getSnapshot().document?.kind.slice(8, 10)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full]));
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.dispose();
  });

  it('deduplicates overlapping multi-cell brush drag stamps and paints half geometry', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    controller.setBrushSize(2);
    controller.handlePointerDown(pointer(1, 24, 24));
    controller.handlePointerMove(pointer(1, 40, 24));
    controller.handlePointerUp(pointer(1, 40, 24));
    expect(gateway.commands.at(-1)).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([0, 1, 2, 8, 9, 10])
    });
    expect(gateway.undoDepth).toBe(1);

    controller.setAuthoringBrush({ kind: 'half', direction: '/', paletteId: 1 });
    controller.handlePointerDown(pointer(2, 24, 24));
    expect(uiStore.getState().overlay.pendingCellStates?.map((state) => state.kind)).toEqual([
      CellKind.HalfSlash, CellKind.HalfSlash, CellKind.HalfSlash, CellKind.HalfSlash
    ]);
    controller.handlePointerUp(pointer(2, 24, 24));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-cell', edit: { kind: 'half', direction: '/' } });
    controller.dispose();
  });

  it('erases a clipped multi-cell brush as one command and suppresses no-op stamps', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    gateway.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    gateway.commands.length = 0;
    controller.setBrushSize(2);
    controller.setTool({ tool: 'eraser', mode: 'whole-cell' });
    controller.handlePointerDown(pointer(1, 24, 24));
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { index: 0, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 },
      { index: 9, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerUp(pointer(1, 24, 24));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'mixed-erase', wholeCellIndices: new Uint32Array([0, 1, 8, 9]) });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);

    gateway.commands.length = 0;
    gateway.execute({ type: 'set-full', x: 3, y: 3, color: 1 });
    gateway.commands.length = 0;
    controller.setBrushSize(1);
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    const revisionBeforeNoop = gateway.getSnapshot().revision;
    controller.handlePointerDown(pointer(2, 56, 56));
    controller.handlePointerUp(pointer(2, 56, 56));
    expect(gateway.commands).toHaveLength(0);
    expect(gateway.getSnapshot().document?.revision).toBe(revisionBeforeNoop);
    controller.dispose();
  });

  it('exposes and validates the bounded brush-size setting', () => {
    const { uiStore, controller } = controllerFixture();
    uiStore.setBrushSize(10);
    expect(controller.getBrushSize()).toBe(10);
    expect(() => uiStore.setBrushSize(0)).toThrow(/integer/);
    expect(() => uiStore.setBrushSize(11)).toThrow(/integer/);
    expect(() => uiStore.setBrushSize(1.5)).toThrow(/integer/);
    expect(() => uiStore.setState({ brushSize: Number.NaN })).toThrow(/integer/);
    expect(() => controller.setBrushSize(-1)).toThrow(/integer/);
    controller.dispose();
  });

  it('normalizes a brush-less paint tool using the first active palette color', () => {
    const uiStore = createUiStore({ tool: { tool: 'pan' }, paletteId: null });
    const { controller } = controllerFixture({ uiStore });
    controller.setTool({ tool: 'paint' } as never);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    controller.dispose();
  });

  it('entering paint after a no-brush start and selecting a color does not crash', () => {
    const gateway = new FakeGateway(createDocument({
      width: 8,
      height: 8,
      palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true }, { id: 2, name: 'Sky', color: '#48c', active: true }]
    }));
    const uiStore = createUiStore({ tool: { tool: 'pan' }, paletteId: null });
    const { controller } = controllerFixture({ gateway, uiStore });
    controller.setTool({ tool: 'paint' } as never);
    controller.selectPalette(2);
    expect(uiStore.getState().paletteId).toBe(2);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 2 } });
    controller.dispose();
  });

  it('carries the active paint brush into a brush-less fill tool', () => {
    const { uiStore, controller } = controllerFixture();
    controller.setTool({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.setTool({ tool: 'fill' });
    expect(uiStore.getState().tool).toEqual({ tool: 'fill', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.dispose();
  });

  it('selecting a color while painting with a half brush keeps the half kind and new color', () => {
    const gateway = new FakeGateway(createDocument({
      width: 8,
      height: 8,
      palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true }, { id: 2, name: 'Sky', color: '#48c', active: true }]
    }));
    const { uiStore, controller } = controllerFixture({ gateway });
    controller.setTool({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.selectPalette(2);
    expect(uiStore.getState().paletteId).toBe(2);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 2 } });
    controller.dispose();
  });

  it('selecting a color tolerates a brush-less paint state', () => {
    const { uiStore, controller } = controllerFixture();
    uiStore.setState({ tool: { tool: 'paint' } as never });
    controller.selectPalette(2);
    expect(uiStore.getState().paletteId).toBe(2);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 2 } });
    controller.dispose();
  });

  it('enters move-image mode when a trace image is present and dims the pattern', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, calls, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'move-image' });
    expect(uiStore.getState().tool).toEqual({ tool: 'move-image' });
    expect(calls.setPatternDimmed).toEqual([true]);
    controller.dispose();
  });

  it('ignores move-image requests without a trace image', () => {
    const { uiStore, calls, controller } = controllerFixture();
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'move-image' });
    expect(uiStore.getState().tool).toEqual(before);
    expect(calls.setPatternDimmed).toEqual([]);
    controller.dispose();
  });

  it('drag-moves the reference image and commits the final bounds on release', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 4, height: 4 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(controller.handlePointerMove(pointer(1, 24, 24))).toBe(true);
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.getTraceImage()?.chartBounds).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.handlePointerUp(pointer(1, 24, 24))).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });

  it('exits move-image with Escape back to the previous tool', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, calls, controller } = controllerFixture({ traceImage: trace });
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'move-image' });
    expect(uiStore.getState().tool).toEqual({ tool: 'move-image' });
    expect(controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined })).toBe(true);
    expect(uiStore.getState().tool).toEqual(before);
    expect(calls.setPatternDimmed).toEqual([true, false]);
    controller.dispose();
  });

  it('exits move-image when another tool is selected and forgets the remembered tool', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, calls, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'move-image' });
    controller.setTool({ tool: 'pan' });
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    expect(calls.setPatternDimmed.at(-1)).toBe(false);
    // The remembered tool was cleared: Escape no longer returns to paint.
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    controller.dispose();
  });

  it('toggles move-image off when the active tool is clicked again and refreshes on re-entry', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, controller } = controllerFixture({ traceImage: trace });
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'move-image' });
    expect(uiStore.getState().tool).toEqual({ tool: 'move-image' });
    controller.setTool({ tool: 'move-image' });
    expect(uiStore.getState().tool).toEqual(before);
    // Re-entering from a different tool remembers the new tool for Escape.
    controller.setTool({ tool: 'pan' });
    controller.setTool({ tool: 'move-image' });
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    controller.dispose();
  });

  it('preserves the exact brush kind when a half-brush paint tool is restored from move-image', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.setTool({ tool: 'move-image' });
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.dispose();
  });

  it('exits move-image with Escape even when the keydown is dispatched on the window, not the canvas', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, calls, controller } = controllerFixture({ traceImage: trace });
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'move-image' });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const prevented = vi.fn();
    Object.defineProperty(event, 'preventDefault', { value: prevented });
    globalThis.dispatchEvent(event);
    expect(prevented).toHaveBeenCalled();
    expect(uiStore.getState().tool).toEqual(before);
    expect(calls.setPatternDimmed).toEqual([true, false]);
    controller.dispose();
  });

  it('does not react to window-level Escape after leaving move-image', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } };
    const { uiStore, controller } = controllerFixture({ traceImage: trace });
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'move-image' });
    controller.setTool({ tool: 'pan' });
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    expect(before).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    controller.dispose();
  });

  it('nudges the reference image one cell with arrow keys and persists the new bounds', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    // The window listener is the feature seam; drive it directly via dispatch.
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 5, y: 4, width: 2, height: 2 });
    expect(callback).toHaveBeenCalledWith({ x: 5, y: 4, width: 2, height: 2 });
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 5, y: 5, width: 2, height: 2 });
    expect(callback).toHaveBeenCalledWith({ x: 5, y: 5, width: 2, height: 2 });
    controller.dispose();
  });

  it('tap-nudges the image toward the dominant axis when tapping outside the image', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    // Tap left of the image at chart (3,5): screen (48,80) at zoom 16. Center is (5,5),
    // so dx=-2 dominates → x−1.
    controller.handlePointerDown(pointer(9, 48, 80));
    controller.handlePointerUp(pointer(9, 48, 80));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 3, y: 4, width: 2, height: 2 });
    expect(callback).toHaveBeenCalledWith({ x: 3, y: 4, width: 2, height: 2 });
    // Tap above the image at chart (5,3): screen (80,48). dy=−2 dominates → y−1.
    controller.handlePointerDown(pointer(10, 80, 48));
    controller.handlePointerUp(pointer(10, 80, 48));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 3, y: 3, width: 2, height: 2 });
    controller.dispose();
  });

  it('tap-nudge picks the dominant axis for a diagonal tap', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    // Tap at chart (2,2): dx=-1, dy=-1 relative to center (5,5); diagonal, |dx|==|dy|
    // so the tie-break picks x if dx!=0.
    controller.handlePointerDown(pointer(11, 32, 32));
    controller.handlePointerUp(pointer(11, 32, 32));
    expect(callback).toHaveBeenCalledWith({ x: 3, y: 4, width: 2, height: 2 });
    controller.dispose();
  });

  it('does not nudge when the tap lands inside the reference image', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    // Tap at chart (5,5) — inside the image — does nothing.
    controller.handlePointerDown(pointer(12, 80, 80));
    controller.handlePointerUp(pointer(12, 80, 80));
    expect(controller.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 2, height: 2 });
    expect(callback).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('touch-drag moves the image and commits the bounds on release', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 4, height: 4 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    expect(controller.handlePointerDown(pointer(5, 8, 8, 'touch'))).toBe(true);
    expect(controller.handlePointerMove(pointer(5, 24, 24, 'touch'))).toBe(true);
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.handlePointerUp(pointer(5, 24, 24, 'touch'))).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });

  it('touch tap outside the image nudges cardinally', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'move-image' });
    // Touch tap at chart (7,5) — right of the image → x+1.
    controller.handlePointerDown(pointer(13, 112, 80, 'touch'));
    controller.handlePointerUp(pointer(13, 112, 80, 'touch'));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 5, y: 4, width: 2, height: 2 });
    expect(callback).toHaveBeenCalledWith({ x: 5, y: 4, width: 2, height: 2 });
    controller.dispose();
  });

  it('enters resize-image mode with trace image, dims the pattern, and shows handles', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { uiStore, calls, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    expect(uiStore.getState().tool).toEqual({ tool: 'resize-image' });
    expect(uiStore.getState().overlay.imageResizeHandles).toBe(true);
    expect(calls.setPatternDimmed).toEqual([true]);
    controller.dispose();
  });

  it('ignores resize-image requests without a trace image', () => {
    const { uiStore, calls, controller } = controllerFixture();
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'resize-image' });
    expect(uiStore.getState().tool).toEqual(before);
    expect(calls.setPatternDimmed).toEqual([]);
    controller.dispose();
  });

  it('resizes from the southeast corner anchored at the opposite corner', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 96));
    controller.handlePointerMove(pointer(1, 112, 64));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 3, height: 1 });
    controller.handlePointerUp(pointer(1, 112, 64));
    expect(callback).toHaveBeenCalledWith({ x: 4, y: 4, width: 3, height: 1 });
    controller.dispose();
  });

  it('resizes from the northwest corner shrinking toward the anchor', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 64, 64));
    controller.handlePointerMove(pointer(1, 32, 32));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    controller.handlePointerUp(pointer(1, 32, 32));
    expect(callback).toHaveBeenCalledWith({ x: 2, y: 2, width: 4, height: 4 });
    controller.dispose();
  });

  it('resizes from the northeast corner', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 64));
    controller.handlePointerMove(pointer(1, 112, 32));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 2, width: 3, height: 4 });
    controller.handlePointerUp(pointer(1, 112, 32));
    controller.dispose();
  });

  it('resizes from the southwest corner', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 64, 96));
    controller.handlePointerMove(pointer(1, 32, 112));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 2, y: 4, width: 4, height: 3 });
    controller.handlePointerUp(pointer(1, 32, 112));
    controller.dispose();
  });

  it('enforces a minimum 1x1 cell size when resizing', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 96));
    controller.handlePointerMove(pointer(1, 80, 80));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    // Dragging past the anchor clamps to the minimum instead of inverting.
    controller.handlePointerMove(pointer(1, 40, 40));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    controller.handlePointerUp(pointer(1, 40, 40));
    expect(callback).toHaveBeenCalledWith({ x: 4, y: 4, width: 1, height: 1 });
    controller.dispose();
  });

  it('pointer down away from a corner in resize mode is a no-op', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    expect(controller.handlePointerDown(pointer(1, 10, 10))).toBe(false);
    expect(controller.handlePointerUp(pointer(1, 10, 10))).toBe(false);
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 2, height: 2 });
    expect(callback).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('Escape exits resize mode, restores dimming, and clears the handles', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { uiStore, calls, controller } = controllerFixture({ traceImage: trace });
    const before = uiStore.getState().tool;
    controller.setTool({ tool: 'resize-image' });
    expect(uiStore.getState().overlay.imageResizeHandles).toBe(true);
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(uiStore.getState().tool).toEqual(before);
    expect(uiStore.getState().overlay.imageResizeHandles).toBe(false);
    expect(calls.setPatternDimmed).toEqual([true, false]);
    controller.dispose();
  });

  it('arrow keys do nothing in resize mode', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 2, height: 2 });
    expect(callback).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('touch drag resizes the image from a corner and commits on release', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    expect(controller.handlePointerDown(pointer(5, 96, 96, 'touch'))).toBe(true);
    expect(controller.handlePointerMove(pointer(5, 112, 112, 'touch'))).toBe(true);
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 3, height: 3 });
    expect(controller.handlePointerUp(pointer(5, 112, 112, 'touch'))).toBe(true);
    expect(callback).toHaveBeenCalledWith({ x: 4, y: 4, width: 3, height: 3 });
    controller.dispose();
  });

  it('applies keyboard paint with clipped brush stamps and one undoable revision', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    controller.setBrushSize(3);
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(true);
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 8, 9]) });
    expect(gateway.undoDepth).toBe(1);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.dispose();
  });

  it('applies keyboard half-stitch brush stamps across multiple cells', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    controller.setBrushSize(2);
    controller.setAuthoringBrush({ kind: 'half', direction: '/', paletteId: 1 });
    uiStore.setKeyboardCursor({ x: 2, y: 2 });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(gateway.commands.at(-1)).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([9, 10, 17, 18]),
      edit: { kind: 'half', direction: '/' }
    });
    for (const index of [9, 10, 17, 18]) expect(gateway.getSnapshot().document?.kind[index]).toBe(CellKind.HalfSlash);
    expect(gateway.undoDepth).toBe(1);
    controller.dispose();
  });

  it('applies keyboard erase stamps, supports undo/redo, suppresses no-ops, and rejects off-chart cursors', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    gateway.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    gateway.commands.length = 0;
    controller.setBrushSize(2);
    controller.setTool({ tool: 'eraser', mode: 'whole-cell' });
    uiStore.setKeyboardCursor({ x: 1, y: 1 });
    const historyBeforeErase = gateway.undoDepth;
    controller.handleKeyDown({ key: 'Backspace', preventDefault: () => undefined });
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 8, 9]), edit: { kind: 'erase-cell' } });
    expect(gateway.undoDepth).toBe(historyBeforeErase + 1);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });

    gateway.commands.length = 0;
    controller.setBrushSize(1);
    controller.setTool({ tool: 'eraser', mode: 'whole-cell' });
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.handleKeyDown({ key: 'Backspace', preventDefault: () => undefined });
    expect(gateway.commands).toHaveLength(0);
    uiStore.setKeyboardCursor({ x: -1, y: 0 });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    uiStore.setKeyboardCursor({ x: Number.POSITIVE_INFINITY, y: 0 });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(gateway.commands).toHaveLength(0);
    controller.dispose();
  });

  it('keeps off-chart origins in the UI viewport and uses Fit chart as recovery', () => {
    const { controller, uiStore, calls, gateway } = controllerFixture();
    uiStore.setViewport({ x: 100, y: -100, zoom: 16 });
    expect(uiStore.getState().viewport).toEqual({ x: 100, y: -100, zoom: 16 });
    expect(calls.setViewport.at(-1)).toEqual({ x: 100, y: -100, zoom: 16 });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(false);
    expect(gateway.commands).toHaveLength(0);
    controller.handleKeyDown({ key: '0', preventDefault: () => undefined });
    expect(uiStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 16 });
    controller.dispose();
  });

  it('resets transient state when the active project changes', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.pendingCells).toHaveLength(1);
    gateway.switchProject();
    expect(uiStore.getState().overlay.pendingCells).toBeUndefined();
    expect(uiStore.getState().keyboardCursor).toBeNull();
    controller.handlePointerUp(pointer(1, 8, 8));
    expect(gateway.getSnapshot().document?.width).toBe(4);
    controller.dispose();
  });

  it('cancels paint and pinch baselines before applying new canvas metrics', () => {
    const paint = controllerFixture();
    paint.controller.handlePointerDown(pointer(1, 8, 8));
    paint.controller.handlePointerMove(pointer(1, 40, 8));
    expect(paint.uiStore.getState().overlay.pendingCells).toHaveLength(3);
    paint.controller.setMetrics(getCanvasMetrics(96, 96, { dpr: 2 }));
    expect(paint.uiStore.getState().overlay.pendingCells).toBeUndefined();
    expect(paint.gateway.commands).toHaveLength(0);
    paint.controller.handlePointerUp(pointer(1, 40, 8));
    expect(paint.gateway.commands).toHaveLength(0);
    paint.controller.dispose();

    const pinch = controllerFixture();
    pinch.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    pinch.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    pinch.controller.handlePointerMove(pointer(2, 100, 20, 'touch'));
    const beforeResize = pinch.uiStore.getState().viewport;
    pinch.controller.setMetrics(getCanvasMetrics(128, 128, { dpr: 2 }));
    expect(pinch.uiStore.getState().viewport).toEqual(beforeResize);
    pinch.controller.handlePointerMove(pointer(2, 140, 20, 'touch'));
    expect(pinch.uiStore.getState().viewport).toEqual(beforeResize);
    expect(pinch.gateway.commands).toHaveLength(0);
    pinch.controller.dispose();
  });
});
