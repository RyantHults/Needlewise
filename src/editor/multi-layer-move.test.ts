import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CellKind,
  LayerType,
  applyCommand,
  applyLayerStructureCommand,
  commitLayerSurface,
  createLayeredDocument,
  findLayer,
  layerAddCommand,
  layerSurface,
  type DomainCommand,
  type LayeredDocument,
  type SpecialtyLayer,
  type StitchLayer
} from '../domain';
import { type PersistencePreparationClient, type ProjectMetadata, type ProjectRecord, type SaveResult } from '../persistence';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { ProjectSession } from '../application/session';
import type { WorkspaceRepository } from '../application/types';
import { clearClipboard } from './clipboard-store';
import { EditorSurfaceController } from './controller';
import type { CanvasRenderer, RenderStats, RendererStyle, Viewport } from './contracts';
import { getCanvasMetrics } from './coordinates';
import { createFillWorkerClient } from './fill';
import { createWorkspaceEditorGateway, type WorkspaceEditorBoundary } from './gateway';
import type { PointerSample } from './input';
import { createUiStore } from './ui-store';

class MemoryRepository implements WorkspaceRepository {
  async save(projectId: string, _metadata: ProjectMetadata, document: LayeredDocument): Promise<SaveResult> {
    const head = { projectId, revision: document.revision, checksum: '0'.repeat(64) };
    return { committed: true, stale: false, revision: document.revision, head };
  }

  async load(): Promise<ProjectRecord | undefined> {
    return undefined;
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [];
  }

  async deleteProject(): Promise<void> {
    return undefined;
  }

  async exportProject(): Promise<Uint8Array> {
    throw new Error('Not used by these tests.');
  }
}

const unusedPreparationClient: PersistencePreparationClient = {
  prepare: () => Promise.reject(new Error('Not used by these tests.')),
  getRequestId: () => '',
  dispose: () => undefined
};

/** Bottom to top: stitch 1, specialty 2, stitch 3. */
function layeredDocument(): LayeredDocument {
  const document = createLayeredDocument({
    width: 8,
    height: 8,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette: [{ id: 1, name: 'Red', color: '#d33', active: true }, { id: 2, name: 'Blue', color: '#36c', active: true }]
  });
  applyLayerStructureCommand(document, layerAddCommand(LayerType.Stitch));
  return document;
}

/** Apply a command straight to one layer, bypassing the editor, to arrange a test. */
function seed(document: LayeredDocument, layerId: number, command: DomainCommand): void {
  const result = applyCommand(layerSurface(document, layerId), command);
  commitLayerSurface(document, layerId, result.document);
}

function full(x: number, y: number, color = 1): DomainCommand {
  return { type: 'set-full', x, y, color };
}

function backstitch(x1: number, y1: number, x2: number, y2: number, color = 1): DomainCommand {
  return { type: 'add-backstitch', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color };
}

function rendererFixture(): CanvasRenderer {
  let viewport: Viewport = { x: 0, y: 0, zoom: 16 };
  const renderer = {
    lastStats: { lod: 'detail', visitedCells: 0, drawnCells: 0, drawnBackstitches: 0, baseRendered: false, overlayRendered: false } as RenderStats,
    getDocument: () => undefined,
    getViewport: () => viewport,
    getStyle: () => ({}) as RendererStyle,
    getTraceImage: () => undefined,
    setDocument: () => undefined,
    setViewport: (next: Viewport) => { viewport = next; },
    setMetrics: () => undefined,
    setStyle: () => undefined,
    setTraceImage: () => undefined,
    clearTraceImage: () => undefined,
    setOverlay: () => undefined,
    invalidate: () => undefined,
    requestRender: () => undefined,
    render: () => renderer.lastStats,
    renderNow: () => renderer.lastStats,
    getLastInvalidation: () => ({ base: false, overlay: false, reasons: [] }),
    dispose: () => undefined,
    destroy: () => undefined
  } as unknown as CanvasRenderer;
  return renderer;
}

/** Screen point at the center of a cell for the fixture's zoom of 16. */
function at(x: number, y: number): PointerSample {
  return { pointerId: 1, pointerType: 'mouse', screenX: x * 16 + 8, screenY: y * 16 + 8, button: 0, buttons: 1, isPrimary: true };
}

const sessions: ProjectSession[] = [];

/** A controller over a real session, so batches run through layered history. */
function fixture(document: LayeredDocument, primary: number, others: readonly number[] = []) {
  const metadata: ProjectMetadata = { id: 'layers', title: 'Layers', notes: '', createdAt: 0, updatedAt: 0, revision: document.revision };
  const session = new ProjectSession({ repository: new MemoryRepository(), metadata, document, preparationClient: unusedPreparationClient, clock: { now: () => 0 }, debounceMs: 60_000 });
  sessions.push(session);
  session.setActiveLayer(primary);
  for (const id of others) session.toggleLayerSelected(id);
  if (others.length > 0) session.toggleLayerSelected(primary);
  if (others.length > 0) session.toggleLayerSelected(primary);
  const executed: DomainCommand[] = [];
  const boundary: WorkspaceEditorBoundary = {
    activeProjectId: 'layers',
    get document() { return session.document; },
    get layeredDocument() { return session.layeredDocument; },
    get activeLayerId() { return session.activeLayerId; },
    get selectedLayerIds() { return session.layerSelection.layerIds; },
    activeLayerSurface: () => session.activeLayerSurface(),
    getEditorLayerSnapshot: () => session.getEditorLayerSnapshot(),
    subscribe: (listener) => session.subscribe(listener),
    execute: (command) => {
      executed.push(command);
      return session.execute(command);
    },
    executeBatch: (commands) => session.executeBatch(commands),
    undo: () => session.undo(),
    redo: () => session.redo()
  };
  const gateway = createWorkspaceEditorGateway(boundary);
  const uiStore = createUiStore({ tool: { tool: 'select' } });
  const notices: string[] = [];
  const controller = new EditorSurfaceController({
    gateway,
    uiStore,
    renderer: rendererFixture(),
    metrics: getCanvasMetrics(128, 128),
    fillClient: createFillWorkerClient({ workerFactory: () => null, requestIdFactory: () => 'fill' }),
    onNotice: (message) => notices.push(message)
  });
  controller.start();
  controller.handleFocus();
  return { session, controller, uiStore, executed, notices };
}

function drag(controller: EditorSurfaceController, from: { x: number; y: number }, to: { x: number; y: number }): void {
  controller.handlePointerDown(at(from.x, from.y));
  controller.handlePointerMove(at(to.x, to.y));
  controller.handlePointerUp(at(to.x, to.y));
}

function stitch(session: ProjectSession, id: number): StitchLayer {
  return findLayer(session.layeredDocument, id) as StitchLayer;
}

function specialty(session: ProjectSession, id: number): SpecialtyLayer {
  return findLayer(session.layeredDocument, id) as SpecialtyLayer;
}

const undo = { key: 'z', ctrlKey: true, preventDefault: () => undefined };

beforeEach(clearClipboard);
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

describe('multi-layer move', () => {
  it('moves every selected stitch layer as one batch, and one undo restores both', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 3, full(1, 0, 2));
    const { session, controller, executed } = fixture(document, 1, [3]);
    expect(session.layerSelection.layerIds).toEqual([1, 3]);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    drag(controller, { x: 0, y: 0 }, { x: 0, y: 2 });
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ type: 'batch', commands: [{ type: 'move-fragment', layerId: 1 }, { type: 'move-fragment', layerId: 3 }] });
    expect(stitch(session, 1).kind[0]).toBe(CellKind.Empty);
    expect(stitch(session, 1).kind[16]).toBe(CellKind.Full);
    expect(stitch(session, 3).kind[1]).toBe(CellKind.Empty);
    expect(stitch(session, 3).kind[17]).toBe(CellKind.Full);

    controller.handleKeyDown(undo);
    expect(stitch(session, 1).kind[0]).toBe(CellKind.Full);
    expect(stitch(session, 1).kind[16]).toBe(CellKind.Empty);
    expect(stitch(session, 3).kind[1]).toBe(CellKind.Full);
    expect(stitch(session, 3).kind[17]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('carries cells and the contained backstitches of a stitch and a specialty layer', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    seed(document, 2, backstitch(0, 0, 4, 4));
    const { session, controller, uiStore } = fixture(document, 1, [2]);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(controller.moveSelection()).toBe(true);
    const floating = uiStore.getState().overlay.floatingPaste!;
    expect(floating.fragment.kind[0]).toBe(CellKind.Full);
    expect(Array.from(floating.backstitches!.ids)).toEqual([...specialty(session, 2).backstitches.ids]);
    drag(controller, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(stitch(session, 1).kind[2]).toBe(CellKind.Full);
    expect(Array.from(specialty(session, 2).backstitches.x1)).toEqual([8]);
    expect(Array.from(specialty(session, 2).backstitches.x2)).toEqual([12]);
    controller.dispose();
  });

  it('leaves a hidden selected layer untouched', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    seed(document, 3, full(0, 0, 2));
    const { session, controller } = fixture(document, 1, [3]);
    session.setLayerVisibility(3, false);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    drag(controller, { x: 0, y: 0 }, { x: 3, y: 0 });
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(stitch(session, 1).kind[3]).toBe(CellKind.Full);
    expect(stitch(session, 3).kind[0]).toBe(CellKind.Full);
    expect(stitch(session, 3).kind[3]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('filters each layer by Focus Color', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    seed(document, 3, full(0, 1, 1));
    const { session, controller, uiStore } = fixture(document, 1, [3]);
    uiStore.setState({ paletteId: 1 });
    controller.setFocusColor(true);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(controller.moveSelection()).toBe(true);
    drag(controller, { x: 0, y: 0 }, { x: 0, y: 3 });
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(stitch(session, 1).kind[0]).toBe(CellKind.Empty);
    expect(stitch(session, 1).kind[24]).toBe(CellKind.Full);
    expect(stitch(session, 1).kind[1]).toBe(CellKind.Full);
    expect(stitch(session, 3).kind[8]).toBe(CellKind.Empty);
    expect(stitch(session, 3).kind[32]).toBe(CellKind.Full);
    controller.dispose();
  });

  it('refuses the whole move when Focus Color protects one layer', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 3, full(0, 0, 1));
    seed(document, 3, full(0, 2, 2));
    const { session, controller, uiStore, notices } = fixture(document, 1, [3]);
    uiStore.setState({ paletteId: 1 });
    controller.setFocusColor(true);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    drag(controller, { x: 0, y: 0 }, { x: 0, y: 2 });
    expect(controller.confirmFloatingPaste()).toBe(false);
    expect(notices).toHaveLength(1);
    expect(stitch(session, 1).kind[0]).toBe(CellKind.Full);
    expect(stitch(session, 1).kind[16]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('discards a floating move when the layer selection changes', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    const { session, controller, uiStore } = fixture(document, 1, [3]);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    session.toggleLayerSelected(2);
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    controller.dispose();
  });

  it('copies from the primary layer only', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 3, full(1, 0, 2));
    const { session, controller } = fixture(document, 1, [3]);
    session.toggleLayerSelected(3);
    session.toggleLayerSelected(3);
    expect(session.layerSelection.primary).toBe(3);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    const copied = controller.copySelection()!;
    expect(Array.from(copied.kind)).toEqual([CellKind.Empty, CellKind.Full]);
    controller.dispose();
  });

  it('deletes the selection from every selected visible layer as one undo step', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    seed(document, 2, backstitch(0, 0, 4, 4));
    seed(document, 3, full(0, 0, 2));
    const { session, controller, executed } = fixture(document, 1, [2, 3]);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.deleteSelection()).toBe(true);
    expect(executed).toHaveLength(1);
    expect(stitch(session, 1).kind[0]).toBe(CellKind.Empty);
    expect(stitch(session, 3).kind[0]).toBe(CellKind.Empty);
    expect(specialty(session, 2).backstitches.ids).toHaveLength(0);
    controller.handleKeyDown(undo);
    expect(stitch(session, 1).kind[0]).toBe(CellKind.Full);
    expect(stitch(session, 3).kind[0]).toBe(CellKind.Full);
    expect(specialty(session, 2).backstitches.ids).toHaveLength(1);
    controller.dispose();
  });
});

describe('move source hole', () => {
  it('publishes fabric for the cells a single-layer move lifts', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    const { controller, uiStore } = fixture(document, 1);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste?.sourceHole).toEqual([
      { index: 0, cell: { x: 0, y: 0 }, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }
    ]);
    controller.dispose();
  });

  it('shows an unselected lower layer through the hole', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 3, full(0, 0, 2));
    const { controller, uiStore } = fixture(document, 3);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste?.sourceHole).toMatchObject([{ index: 0, kind: CellKind.Full, colors: [1, 0, 0, 0] }]);
    controller.dispose();
  });

  it('drops a lifted cell an unselected upper layer covers', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 1));
    seed(document, 3, full(0, 0, 2));
    const { controller, uiStore } = fixture(document, 1);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste?.sourceHole?.map((state) => state.index)).toEqual([1]);
    controller.dispose();
  });

  it('holes only the focus-color cells under Focus Color', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    const { controller, uiStore } = fixture(document, 1);
    uiStore.setState({ paletteId: 1 });
    controller.setFocusColor(true);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste?.sourceHole?.map((state) => state.index)).toEqual([0]);
    controller.dispose();
  });

  it('lifts exactly the moved backstitch ids', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(0, 0, 4, 4));
    seed(document, 2, backstitch(16, 16, 20, 20));
    const { session, controller, uiStore } = fixture(document, 2);
    const inside = specialty(session, 2).backstitches.ids[0];
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(controller.moveSelection()).toBe(true);
    const floating = uiStore.getState().overlay.floatingPaste!;
    expect([...floating.liftedBackstitchIds!]).toEqual([inside]);
    expect(Array.from(floating.backstitches!.ids)).toEqual([inside]);
    expect(floating.sourceHole).toEqual([]);
    controller.dispose();
  });

  it('clears the hole on cancel and on commit', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    const { controller, uiStore } = fixture(document, 1);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste?.sourceHole).toHaveLength(1);
    expect(controller.cancelFloatingPaste()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();

    expect(controller.moveSelection()).toBe(true);
    const hole = uiStore.getState().overlay.floatingPaste?.sourceHole;
    drag(controller, { x: 0, y: 0 }, { x: 2, y: 0 });
    // A drag only moves the destination, so the hole is the same array.
    expect(uiStore.getState().overlay.floatingPaste?.sourceHole).toBe(hole);
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    controller.dispose();
  });
});
