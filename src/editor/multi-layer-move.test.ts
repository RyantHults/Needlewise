import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CellKind,
  LayerType,
  applyLayerStructureCommand,
  findLayer,
  layerAddCommand,
  layerSurface,
  type DomainCommand,
  type LayeredDocument
} from '../domain';
import { createPersistencePreparationClient, type ProjectMetadata } from '../persistence';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { ProjectSession } from '../application/session';
import { MemoryRepository } from '../application/test-support';
import { clearClipboard } from './clipboard-store';
import { EditorSurfaceController } from './controller';
import { getCanvasMetrics } from './coordinates';
import { createWorkspaceEditorGateway, type WorkspaceEditorBoundary } from './gateway';
import { createUiStore } from './ui-store';
import { applyCommand, commitLayerSurface, createLayeredDocument, specialtyLayer, stitchLayer, cell } from '../domain/test-fixtures';
import { drag, rendererFixture } from './test-support';

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
  return cell(8, { type: 'set-full', x, y, color });
}

function backstitch(x1: number, y1: number, x2: number, y2: number, color = 1): DomainCommand {
  return { type: 'add-backstitch', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color };
}

const sessions: ProjectSession[] = [];

/** A controller over a real session, so batches run through layered history. */
function fixture(document: LayeredDocument, primary: number, others: readonly number[] = []) {
  const metadata: ProjectMetadata = { id: 'layers', title: 'Layers', notes: '', createdAt: 0, updatedAt: 0, revision: document.revision };
  const session = new ProjectSession({ repository: new MemoryRepository(), metadata, document, preparationClient: createPersistencePreparationClient({ useWorker: false }), clock: { now: () => 0 }, debounceMs: 60_000 });
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
    redo: () => session.redo(),
    get canUndo() { return session.historyUndoDepth > 0; },
    get canRedo() { return session.historyRedoDepth > 0; },
    resolvePaste: (type) => session.resolvePaste(type),
    resolveMultiLayerPaste: (type) => session.resolveMultiLayerPaste(type),
    commitPaste: (fragment, position, destinations, expectedRevision, palette) => session.commitPaste(fragment, position, destinations, expectedRevision, palette),
    markProgress: (command) => session.markProgress(command),
    undoMark: () => session.undoMark(),
    redoMark: () => session.redoMark()
  };
  const gateway = createWorkspaceEditorGateway(boundary);
  const uiStore = createUiStore({ tool: { tool: 'select' } });
  const notices: string[] = [];
  const controller = new EditorSurfaceController({
    gateway,
    uiStore,
    renderer: rendererFixture().renderer,
    metrics: getCanvasMetrics(128, 128),
    onNotice: (message) => notices.push(message)
  });
  controller.start();
  controller.handleFocus();
  return { session, controller, uiStore, executed, notices };
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
    expect(stitchLayer(session.layeredDocument, 1).kind[0]).toBe(CellKind.Empty);
    expect(stitchLayer(session.layeredDocument, 1).kind[16]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 3).kind[1]).toBe(CellKind.Empty);
    expect(stitchLayer(session.layeredDocument, 3).kind[17]).toBe(CellKind.Full);

    controller.handleKeyDown(undo);
    expect(stitchLayer(session.layeredDocument, 1).kind[0]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 1).kind[16]).toBe(CellKind.Empty);
    expect(stitchLayer(session.layeredDocument, 3).kind[1]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 3).kind[17]).toBe(CellKind.Empty);
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
    expect(Array.from(floating.backstitches!.ids)).toEqual([...specialtyLayer(session.layeredDocument, 2).backstitches.ids]);
    drag(controller, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(stitchLayer(session.layeredDocument, 1).kind[2]).toBe(CellKind.Full);
    expect(Array.from(specialtyLayer(session.layeredDocument, 2).backstitches.x1)).toEqual([8]);
    expect(Array.from(specialtyLayer(session.layeredDocument, 2).backstitches.x2)).toEqual([12]);
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
    expect(stitchLayer(session.layeredDocument, 1).kind[3]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 3).kind[0]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 3).kind[3]).toBe(CellKind.Empty);
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
    expect(stitchLayer(session.layeredDocument, 1).kind[0]).toBe(CellKind.Empty);
    expect(stitchLayer(session.layeredDocument, 1).kind[24]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 1).kind[1]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 3).kind[8]).toBe(CellKind.Empty);
    expect(stitchLayer(session.layeredDocument, 3).kind[32]).toBe(CellKind.Full);
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
    expect(stitchLayer(session.layeredDocument, 1).kind[0]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 1).kind[16]).toBe(CellKind.Empty);
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

  it('deletes the selection from every selected visible layer as one undo step', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0));
    seed(document, 2, backstitch(0, 0, 4, 4));
    seed(document, 3, full(0, 0, 2));
    const { session, controller, executed } = fixture(document, 1, [2, 3]);
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.deleteSelection()).toBe(true);
    expect(executed).toHaveLength(1);
    expect(stitchLayer(session.layeredDocument, 1).kind[0]).toBe(CellKind.Empty);
    expect(stitchLayer(session.layeredDocument, 3).kind[0]).toBe(CellKind.Empty);
    expect(specialtyLayer(session.layeredDocument, 2).backstitches.ids).toHaveLength(0);
    controller.handleKeyDown(undo);
    expect(stitchLayer(session.layeredDocument, 1).kind[0]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 3).kind[0]).toBe(CellKind.Full);
    expect(specialtyLayer(session.layeredDocument, 2).backstitches.ids).toHaveLength(1);
    controller.dispose();
  });
});

/** Copy cells (0,0)-(1,1) and paste them with their top-left at (4,4). */
function copyAndPaste(from: EditorSurfaceController, to: EditorSurfaceController = from): void {
  from.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
  expect(from.copySelection()).toBeDefined();
  to.setSelection({ x: 4, y: 4 });
  expect(to.pasteSelection()).toBe(true);
  expect(to.confirmFloatingPaste()).toBe(true);
}

describe('multi-layer copy', () => {
  it('pastes stitch and specialty layers onto one new layer of each type as one undo step', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 1));
    seed(document, 3, full(0, 0, 2));
    seed(document, 2, backstitch(0, 0, 4, 4));
    const { session, controller } = fixture(document, 1, [2, 3]);
    copyAndPaste(controller);
    const pasted = stitchLayer(session.layeredDocument, 4);
    // The top layer's cell wins where both stitch layers have one.
    expect(pasted.kind[36]).toBe(CellKind.Full);
    expect(pasted.colors[36 * 4]).toBe(2);
    expect(pasted.kind[37]).toBe(CellKind.Full);
    expect(pasted.colors[37 * 4]).toBe(1);
    const lines = specialtyLayer(session.layeredDocument, 5).backstitches;
    expect(Array.from(lines.x1)).toEqual([16]);
    expect(Array.from(lines.x2)).toEqual([20]);
    expect([...session.layerSelection.layerIds].sort()).toEqual([4, 5]);

    controller.handleKeyDown(undo);
    expect(findLayer(session.layeredDocument, 4)).toBeUndefined();
    expect(findLayer(session.layeredDocument, 5)).toBeUndefined();
    controller.dispose();
  });

  it('merges the stitch part onto the topmost visible stitch layer when the stitch group is full', () => {
    const document = layeredDocument();
    applyLayerStructureCommand(document, layerAddCommand(LayerType.Stitch));
    seed(document, 1, full(0, 0, 1));
    seed(document, 2, backstitch(0, 0, 4, 4));
    const { session, controller } = fixture(document, 1, [2]);
    copyAndPaste(controller);
    expect(stitchLayer(session.layeredDocument, 4).kind[36]).toBe(CellKind.Full);
    expect(findLayer(session.layeredDocument, 5)?.type).toBe(LayerType.Specialty);
    expect(specialtyLayer(session.layeredDocument, 5).backstitches.ids).toHaveLength(1);
    expect(session.layeredDocument.layers.filter((layer) => layer.type === LayerType.Stitch)).toHaveLength(3);
    controller.dispose();
  });

  it('takes nothing from a hidden selected layer', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 2, backstitch(0, 0, 4, 4));
    seed(document, 3, full(1, 0, 2));
    const { session, controller } = fixture(document, 1, [2, 3]);
    session.setLayerVisibility(3, false);
    copyAndPaste(controller);
    const pasted = stitchLayer(session.layeredDocument, 4);
    expect(pasted.kind[36]).toBe(CellKind.Full);
    expect(pasted.kind[37]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('copies as one layer when the other selected layer is hidden, so the paste lands on the selected layer', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 3, full(1, 0, 2));
    const { session, controller } = fixture(document, 1, [3]);
    session.setLayerVisibility(3, false);
    copyAndPaste(controller);
    expect(stitchLayer(session.layeredDocument, 1).kind[36]).toBe(CellKind.Full);
    expect(stitchLayer(session.layeredDocument, 1).kind[37]).toBe(CellKind.Empty);
    expect(findLayer(session.layeredDocument, 4)).toBeUndefined();
    controller.dispose();
  });

  it('filters each layer by Focus Color', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    seed(document, 3, full(0, 1, 1));
    seed(document, 3, full(1, 1, 2));
    const { session, controller, uiStore } = fixture(document, 1, [3]);
    uiStore.setState({ paletteId: 1 });
    controller.setFocusColor(true);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(controller.copySelection()).toBeDefined();
    controller.setFocusColor(false);
    controller.setSelection({ x: 4, y: 4 });
    expect(controller.pasteSelection()).toBe(true);
    expect(controller.confirmFloatingPaste()).toBe(true);
    const pasted = stitchLayer(session.layeredDocument, 4);
    expect(pasted.kind[36]).toBe(CellKind.Full);
    expect(pasted.kind[44]).toBe(CellKind.Full);
    expect(pasted.kind[37]).toBe(CellKind.Empty);
    expect(pasted.kind[45]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('pastes into the next pattern after a project switch', () => {
    const source = layeredDocument();
    seed(source, 1, full(0, 0, 1));
    seed(source, 2, backstitch(0, 0, 4, 4));
    const first = fixture(source, 1, [2]);
    first.controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(first.controller.copySelection()).toBeDefined();
    first.controller.dispose();

    const second = fixture(layeredDocument(), 1);
    second.controller.setSelection({ x: 4, y: 4 });
    expect(second.controller.pasteSelection()).toBe(true);
    expect(second.controller.confirmFloatingPaste()).toBe(true);
    expect(stitchLayer(second.session.layeredDocument, 4).kind[36]).toBe(CellKind.Full);
    expect(specialtyLayer(second.session.layeredDocument, 5).backstitches.ids).toHaveLength(1);
    second.controller.dispose();
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
    const inside = specialtyLayer(session.layeredDocument, 2).backstitches.ids[0];
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
