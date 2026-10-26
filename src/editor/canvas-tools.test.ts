import { describe, expect, it } from 'vitest';
import {
  CellKind,
  LayerType,
  applyCanvasCommand,
  canvasCellsCommand,
  canvasWorkspace,
  commandLayerType,
  flattenDocument,
  layerSurface,
  requireEditableLayer,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type PatternDocument
} from '../domain';
import { EditorSurfaceController } from './controller';
import {
  CANVAS_BASIC_LOCKED_HINT,
  CANVAS_BASIC_TOOL_HINT,
  CANVAS_CROP_OFF_HINT,
  type CellRect
} from './contracts';
import {
  canvasCellSet,
  canvasEdgeDragDelta,
  canvasOvalSelection,
  canvasRectSelection,
  stampCanvasBrush
} from './canvas-tools';
import { getCanvasMetrics, screenToModel } from './coordinates';
import { createWorkspaceEditorGateway, type ActiveLayerId, type WorkspaceEditorBoundary } from './gateway';
import { createUiStore } from './ui-store';
import { atViewport, layeredDocument, rendererFixture } from './test-support';
import { applyCommand, commitLayerSurface, cell } from '../domain/test-fixtures';

const ZOOM = 16;

/**
 * A layered workspace that runs canvas commands through `applyCanvasCommand`
 * and layer commands on one layer surface, with whole-document undo. It keeps
 * these tests independent of how the session's history records canvas edits.
 */
class CanvasBoundary implements WorkspaceEditorBoundary {
  activeProjectId = 'project-a';
  readonly log: DomainCommand[] = [];
  activeLayerId: ActiveLayerId = 'canvas';
  layeredDocument: LayeredDocument;
  document: PatternDocument;
  readonly undoStack: LayeredDocument[] = [];
  readonly redoStack: LayeredDocument[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(layered: LayeredDocument) {
    this.layeredDocument = layered;
    this.document = flattenDocument(layered);
  }

  readonly selectedLayerIds = null;

  activeLayerSurface(): PatternDocument | null {
    return typeof this.activeLayerId === 'number' ? layerSurface(this.layeredDocument, this.activeLayerId) : null;
  }

  getEditorLayerSnapshot(): null {
    return null;
  }

  resolvePaste(): never {
    throw new Error('not used');
  }

  commitPaste(): never {
    throw new Error('not used');
  }

  markProgress(): never {
    throw new Error('not used');
  }

  undoMark(): never {
    throw new Error('not used');
  }

  redoMark(): never {
    throw new Error('not used');
  }

  setActiveLayer(id: ActiveLayerId): void {
    this.activeLayerId = id;
    this.emit();
  }

  /** Swap in another project's document, as a project switch does. */
  switchProject(projectId: string, layered: LayeredDocument): void {
    this.activeProjectId = projectId;
    this.layeredDocument = layered;
    this.document = flattenDocument(layered);
    this.undoStack.length = 0;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  execute(command: DomainCommand): CommandResult {
    this.log.push(command);
    if (command.type === 'canvas-resize' || command.type === 'canvas-cells') {
      const applied = applyCanvasCommand(this.layeredDocument, command);
      if (!applied.changed) return { document: this.document, changed: false, revision: this.layeredDocument.revision };
      this.commit({ ...applied.document, revision: this.layeredDocument.revision + 1 });
      return { document: this.document, changed: true, revision: this.layeredDocument.revision, compositeFull: true };
    }
    const layerId = (command.layerId as number | undefined) ?? (this.activeLayerId as number);
    requireEditableLayer(this.layeredDocument, layerId, commandLayerType(command));
    const result = applyCommand(layerSurface(this.layeredDocument, layerId), command);
    if (result.changed) commitLayerSurface(this.layeredDocument, layerId, result.document);
    this.document = flattenDocument(this.layeredDocument);
    this.emit();
    return { ...result, document: this.document };
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    return this.execute({ type: 'batch', commands: [...commands] });
  }

  undo(): CommandResult {
    const previous = this.undoStack.pop();
    if (!previous) return { document: this.document, changed: false, revision: this.layeredDocument.revision };
    this.redoStack.push(this.layeredDocument);
    this.restore({ ...previous, revision: this.layeredDocument.revision + 1 });
    return { document: this.document, changed: true, revision: this.layeredDocument.revision, compositeFull: true };
  }

  redo(): CommandResult {
    const next = this.redoStack.pop();
    if (!next) return { document: this.document, changed: false, revision: this.layeredDocument.revision };
    this.undoStack.push(this.layeredDocument);
    this.restore({ ...next, revision: this.layeredDocument.revision + 1 });
    return { document: this.document, changed: true, revision: this.layeredDocument.revision, compositeFull: true };
  }

  private commit(next: LayeredDocument): void {
    this.undoStack.push(this.layeredDocument);
    this.redoStack.length = 0;
    this.restore(next);
  }

  private restore(next: LayeredDocument): void {
    this.layeredDocument = next;
    this.document = flattenDocument(next);
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** A document whose column x = 3 is a hole: not a rectangle any more. */
function maskedDocument(): LayeredDocument {
  const document = layeredDocument(10, 10);
  const applied = applyCanvasCommand(document, canvasCellsCommand('remove', { x: 3, y: 0, width: 1, height: 10 }));
  return applied.document;
}

function fixture(document = layeredDocument(10, 10), activeLayerId: ActiveLayerId = 'canvas') {
  const boundary = new CanvasBoundary(document);
  boundary.activeLayerId = activeLayerId;
  const gateway = createWorkspaceEditorGateway(boundary);
  const uiStore = createUiStore({ viewport: { x: 0, y: 0, zoom: ZOOM } });
  const notices: string[] = [];
  const controller = new EditorSurfaceController({
    gateway,
    uiStore,
    renderer: rendererFixture().renderer,
    metrics: getCanvasMetrics(320, 320),
    onNotice: (message) => notices.push(message)
  });
  controller.start();
  controller.handleFocus();
  return { boundary, gateway, uiStore, controller, notices };
}

function bits(cells: Uint8Array | undefined): number[] {
  return cells ? Array.from(cells) : [];
}

function canvasCommands(boundary: CanvasBoundary) {
  return boundary.log.filter((command) => command.type === 'canvas-resize' || command.type === 'canvas-cells');
}

describe('canvas tool geometry', () => {
  it('stamps a disk clipped to the workspace and filtered by the caller', () => {
    const workspace: CellRect = { x: -2, y: -2, width: 4, height: 4 };
    const cells = new Set<number>();
    stampCanvasBrush(cells, { x: -3, y: -3 }, 2, workspace);
    // A size-2 disk is a 2x2 square with the hit cell top-left; only the cell inside the workspace survives.
    expect(canvasCellSet(cells, workspace)).toEqual({ rect: { x: -2, y: -2, width: 1, height: 1 }, cells: new Uint8Array([1]) });
    const whole = new Set<number>();
    stampCanvasBrush(whole, { x: -2, y: -2 }, 2, workspace);
    expect(canvasCellSet(whole, workspace)).toEqual({ rect: { x: -2, y: -2, width: 2, height: 2 }, cells: new Uint8Array([1, 1, 1, 1]) });
    const filtered = new Set<number>();
    stampCanvasBrush(filtered, { x: -1, y: -1 }, 2, workspace, (x, y) => x >= 0 && y >= 0);
    expect(canvasCellSet(filtered, workspace)).toEqual({ rect: { x: 0, y: 0, width: 1, height: 1 }, cells: new Uint8Array([1]) });
  });

  it('builds rect selections clipped to the workspace', () => {
    const workspace: CellRect = { x: -5, y: -5, width: 20, height: 20 };
    expect(canvasRectSelection({ x: 3, y: 2 }, { x: -9, y: 0 }, workspace)).toEqual({ rect: { x: -5, y: 0, width: 9, height: 3 } });
  });

  it('builds filled-oval selections as bitmaps clipped to the workspace', () => {
    const workspace: CellRect = { x: -5, y: -5, width: 20, height: 20 };
    expect(canvasOvalSelection({ x: 4, y: 2 }, { x: 0, y: 0 }, workspace)).toEqual({
      rect: { x: 0, y: 0, width: 5, height: 3 },
      cells: new Uint8Array([0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0])
    });
    // Only the oval's right part lies inside a workspace starting at x = 2.
    expect(canvasOvalSelection({ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 0, width: 10, height: 10 })).toEqual({
      rect: { x: 2, y: 0, width: 3, height: 3 },
      cells: new Uint8Array([1, 1, 0, 1, 1, 1, 1, 1, 0])
    });
    expect(canvasOvalSelection({ x: 20, y: 20 }, { x: 22, y: 22 }, workspace)).toBeUndefined();
  });

  it('rounds edge drags to whole cells and keeps the box at least one cell and inside the workspace', () => {
    const workspace: CellRect = { x: -10, y: -10, width: 30, height: 30 };
    expect(canvasEdgeDragDelta('right', 10, 10, workspace, { x: 10, y: 5 }, { x: 12.6, y: 9 })).toBe(3);
    expect(canvasEdgeDragDelta('right', 10, 10, workspace, { x: 10, y: 5 }, { x: 40, y: 5 })).toBe(10);
    expect(canvasEdgeDragDelta('left', 10, 10, workspace, { x: 0, y: 5 }, { x: 30, y: 5 })).toBe(-9);
    expect(canvasEdgeDragDelta('top', 10, 10, workspace, { x: 5, y: 0 }, { x: 5, y: -2.2 })).toBe(2);
    expect(canvasEdgeDragDelta('top', 10, 10, workspace, { x: 5, y: 0 }, { x: 5, y: -50 })).toBe(10);
    expect(canvasEdgeDragDelta('bottom', 10, 10, workspace, { x: 5, y: 10 }, { x: 5, y: 10.4 })).toBe(0);
  });
});

describe('canvas editing in the controller', () => {
  it('starts with crop mode off: Pan only, no canvasEditing overlay', () => {
    const { controller, uiStore, notices } = fixture();
    expect(uiStore.getState().canvasCropActive).toBe(false);
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    controller.setCanvasMode('advanced');
    expect(controller.setTool({ tool: 'canvas-brush' })).toBe(false);
    expect(notices.at(-1)).toBe(CANVAS_CROP_OFF_HINT);
    expect(controller.setTool({ tool: 'eraser' })).toBe(false);
    expect(controller.setTool({ tool: 'pan' })).toBe(true);
    // Panning still works while crop is off.
    expect(controller.handlePointerDown(atViewport(uiStore, 1, 2, 2))).toBe(true);
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    controller.dispose();
  });

  it('enables the canvas tools only while crop is active and turns them off with the mode', () => {
    const { boundary, controller, uiStore, notices } = fixture();
    expect(controller.setCanvasCropActive(true)).toBe(true);
    expect(uiStore.getState().canvasCropActive).toBe(true);
    expect(uiStore.getState().overlay.canvasEditing).toMatchObject({ workspace: canvasWorkspace(boundary.document) });
    // Basic crop: Pan only.
    expect(controller.setTool({ tool: 'canvas-brush' })).toBe(false);
    expect(notices.at(-1)).toBe(CANVAS_BASIC_TOOL_HINT);
    expect(controller.setCanvasMode('advanced')).toBe(true);
    expect(controller.setTool({ tool: 'canvas-brush' })).toBe(true);
    expect(controller.setTool({ tool: 'fill' })).toBe(false);
    // Back to Basic: the canvas brush gives way to Pan.
    expect(controller.setCanvasMode('basic')).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });

    // Turning crop off cancels a stroke, clears the canvas selection and returns to Pan.
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, 1, 1));
    controller.handlePointerUp(atViewport(uiStore, 1, 3, 3));
    expect(controller.getCanvasSelection()).toBeDefined();
    controller.setTool({ tool: 'canvas-brush' });
    controller.handlePointerDown(atViewport(uiStore, 2, -1, 1));
    expect(uiStore.getState().overlay.canvasEditing?.preview).not.toBeNull();
    expect(controller.setCanvasCropActive(false)).toBe(true);
    controller.handlePointerUp(atViewport(uiStore, 2, -1, 1));
    expect(boundary.log).toHaveLength(0);
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    // The chosen mode is remembered for the session.
    expect(uiStore.getState().canvasMode).toBe('advanced');
    controller.dispose();
  });

  it('selects a filled oval on the canvas layer and restores the previous selection on cancel', () => {
    const { controller, uiStore } = fixture();
    controller.setCanvasCropActive(true);
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'select', shape: 'oval' });
    controller.handlePointerDown(atViewport(uiStore, 1, -1, 1));
    controller.handlePointerMove(atViewport(uiStore, 1, 3, 3));
    controller.handlePointerUp(atViewport(uiStore, 1, 3, 3));
    const oval = controller.getCanvasSelection();
    expect(oval?.rect).toEqual({ x: -1, y: 1, width: 5, height: 3 });
    expect(bits(oval?.cells)).toEqual([0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0]);
    // Switching to rectangle select keeps the selection.
    controller.setTool({ tool: 'select' });
    expect(controller.getCanvasSelection()).toBe(oval);
    controller.setTool({ tool: 'select', shape: 'oval' });
    controller.handlePointerDown(atViewport(uiStore, 2, 5, 5));
    controller.handlePointerMove(atViewport(uiStore, 2, 8, 8));
    expect(controller.getCanvasSelection()?.rect).toEqual({ x: 5, y: 5, width: 4, height: 4 });
    controller.handlePointerCancel(atViewport(uiStore, 2, 8, 8));
    expect(controller.getCanvasSelection()).toBe(oval);
    controller.dispose();
  });

  it('clears the canvas selection through clearSelection, as the Select and Lasso buttons do', () => {
    const { controller, uiStore } = fixture();
    controller.setCanvasCropActive(true);
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, 1, 1));
    controller.handlePointerUp(atViewport(uiStore, 1, 3, 3));
    expect(uiStore.getState().overlay.canvasEditing?.selection).toBeTruthy();
    controller.clearSelection();
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.canvasEditing?.selection).toBeFalsy();
    controller.dispose();
  });

  it('keeps the canvas selection on a click, and a bare click selects nothing', () => {
    const { controller, uiStore } = fixture();
    controller.setCanvasCropActive(true);
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, 6, 6));
    controller.handlePointerUp(atViewport(uiStore, 1, 6, 6));
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.canvasEditing?.selection).toBeFalsy();

    controller.handlePointerDown(atViewport(uiStore, 2, 1, 1));
    controller.handlePointerMove(atViewport(uiStore, 2, 3, 3));
    controller.handlePointerUp(atViewport(uiStore, 2, 3, 3));
    const selection = controller.getCanvasSelection();
    expect(selection).toEqual({ rect: { x: 1, y: 1, width: 3, height: 3 } });
    controller.handlePointerDown(atViewport(uiStore, 3, 6, 6));
    controller.handlePointerUp(atViewport(uiStore, 3, 6, 6));
    expect(controller.getCanvasSelection()).toBe(selection);
    expect(uiStore.getState().overlay.canvasEditing?.selection).toBe(selection);

    controller.setTool({ tool: 'select', shape: 'oval' });
    controller.handlePointerDown(atViewport(uiStore, 4, -1, -1));
    controller.handlePointerUp(atViewport(uiStore, 4, -1, -1));
    expect(controller.getCanvasSelection()).toBe(selection);
    controller.dispose();
  });

  it('leaves crop mode on Escape only when nothing is in progress', () => {
    const { controller, uiStore } = fixture();
    const escape = () => controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    controller.setCanvasCropActive(true);
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, 1, 1));
    controller.handlePointerUp(atViewport(uiStore, 1, 2, 2));
    escape();
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(uiStore.getState().canvasCropActive).toBe(true);
    controller.setCanvasMode('basic');
    controller.beginCanvasEdgeDrag('right', { x: 160, y: 80 });
    escape();
    expect(uiStore.getState().overlay.canvasEditing?.preview).toBeNull();
    expect(uiStore.getState().canvasCropActive).toBe(true);
    escape();
    expect(uiStore.getState().canvasCropActive).toBe(false);
    controller.dispose();
  });

  it('turns crop off when leaving the Canvas layer, and re-entering starts off', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasCropActive(true);
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'canvas-brush' });
    boundary.setActiveLayer(1);
    expect(uiStore.getState().canvasCropActive).toBe(false);
    expect(uiStore.getState().tool.tool).not.toBe('canvas-brush');
    boundary.setActiveLayer('canvas');
    expect(uiStore.getState().canvasCropActive).toBe(false);
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    expect(uiStore.getState().canvasMode).toBe('advanced');
    // Crop cannot be turned on away from the Canvas layer.
    boundary.setActiveLayer(1);
    expect(controller.setCanvasCropActive(true)).toBe(false);
    controller.dispose();
  });

  it('forces Advanced on a masked canvas and locks Basic', () => {
    const { boundary, controller, uiStore, notices } = fixture();
    controller.setCanvasCropActive(true);
    controller.setCanvasMode('advanced');
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(atViewport(uiStore, 1, 4, 0));
    controller.handlePointerMove(atViewport(uiStore, 1, 4, 9));
    controller.handlePointerUp(atViewport(uiStore, 1, 4, 9));
    expect(boundary.document.canvasMask).toBeDefined();
    expect(uiStore.getState().canvasBasicAvailable).toBe(false);
    expect(controller.setCanvasMode('basic')).toBe(false);
    expect(notices.at(-1)).toBe(CANVAS_BASIC_LOCKED_HINT);
    expect(uiStore.getState().canvasMode).toBe('advanced');
    // Undo restores the rectangle and unlocks Basic.
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(boundary.document.canvasMask).toBeUndefined();
    expect(uiStore.getState().canvasBasicAvailable).toBe(true);
    expect(controller.setCanvasMode('basic')).toBe(true);
    controller.dispose();
  });

  it('forces Advanced for a document that loads with a mask', () => {
    const { controller, uiStore } = fixture(maskedDocument(), 1);
    expect(uiStore.getState().canvasMode).toBe('advanced');
    expect(uiStore.getState().canvasBasicAvailable).toBe(false);
    controller.dispose();
  });

  it('publishes canvasEditing exactly while crop is active on the Canvas layer', () => {
    const { boundary, controller, uiStore } = fixture(layeredDocument(10, 10), 1);
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    boundary.setActiveLayer('canvas');
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    controller.setCanvasCropActive(true);
    expect(uiStore.getState().overlay.canvasEditing).toMatchObject({ workspace: canvasWorkspace(boundary.document), selection: null, preview: null });
    controller.setCanvasMode('advanced');
    expect(uiStore.getState().overlay.canvasEditing?.workspace).toEqual(canvasWorkspace(boundary.document));
    boundary.setActiveLayer(2);
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    controller.dispose();
  });

  it('adds cells with one canvas-cells command per brush stroke, previewing the stroke and keeping the design still', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'canvas-brush' });
    const before = uiStore.getState().viewport;
    controller.handlePointerDown(atViewport(uiStore, 1, -2, 3));
    expect(uiStore.getState().overlay.canvasEditing?.preview).toEqual({ kind: 'add', rect: { x: -2, y: 3, width: 1, height: 1 }, cells: new Uint8Array([1]) });
    controller.handlePointerMove(atViewport(uiStore, 1, -2, 5));
    expect(uiStore.getState().overlay.canvasEditing?.preview).toEqual({ kind: 'add', rect: { x: -2, y: 3, width: 1, height: 3 }, cells: new Uint8Array([1, 1, 1]) });
    expect(canvasCommands(boundary)).toHaveLength(0);
    controller.handlePointerUp(atViewport(uiStore, 1, -2, 5));

    expect(canvasCommands(boundary)).toHaveLength(1);
    expect(canvasCommands(boundary)[0]).toMatchObject({ type: 'canvas-cells', operation: 'add', rect: { x: -2, y: 3, width: 1, height: 3 } });
    const [added] = canvasCommands(boundary);
    if (added.type !== 'canvas-cells') throw new Error('Expected a canvas-cells command.');
    expect(bits(added.cells as Uint8Array)).toEqual([1, 1, 1]);
    expect(boundary.undoStack).toHaveLength(1);
    expect(boundary.document).toMatchObject({ width: 12, height: 10, originX: -2 });
    expect(uiStore.getState().overlay.canvasEditing?.preview).toBeNull();
    // The box grew two columns to the left, so the view moved with it.
    expect(uiStore.getState().viewport).toEqual({ ...before, x: before.x + 2 });
    controller.dispose();
  });

  it('removes only active cells with the eraser on the Canvas layer, in one canvas-cells command', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(atViewport(uiStore, 1, -3, 4));
    controller.handlePointerMove(atViewport(uiStore, 1, 1, 4));
    expect(uiStore.getState().overlay.canvasEditing?.preview).toMatchObject({ kind: 'remove', rect: { x: 0, y: 4, width: 2, height: 1 } });
    controller.handlePointerUp(atViewport(uiStore, 1, 1, 4));
    expect(canvasCommands(boundary)).toEqual([expect.objectContaining({ type: 'canvas-cells', operation: 'remove', rect: { x: 0, y: 4, width: 2, height: 1 } })]);
    expect(boundary.document.canvasMask?.[4 * 10]).toBe(0);
    expect(boundary.document.canvasMask?.[4 * 10 + 2]).toBe(1);
    expect(boundary.undoStack).toHaveLength(1);
    controller.dispose();
  });

  it('leaves the stitch-layer eraser erasing stitches', () => {
    const document = layeredDocument(10, 10);
    const surface = applyCommand(layerSurface(document, 1), cell(10, { type: 'set-full', x: 1, y: 1, color: 1 }));
    commitLayerSurface(document, 1, surface.document);
    const { boundary, controller, uiStore } = fixture(document, 1);
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(atViewport(uiStore, 1, 1, 1));
    controller.handlePointerUp(atViewport(uiStore, 1, 1, 1));
    expect(boundary.log).toEqual([expect.objectContaining({ type: 'mixed-erase', layerId: 1 })]);
    expect(boundary.document.kind[11]).toBe(CellKind.Empty);
    expect(uiStore.getState().overlay.canvasEditing).toBeUndefined();
    controller.dispose();
  });

  it('freezes the workspace for a gesture and clips the stroke to it', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'canvas-brush' });
    controller.setToolBrushSize('canvas-brush', 3);
    const frozen = canvasWorkspace(boundary.document);
    controller.handlePointerDown(atViewport(uiStore, 1, frozen.x, 4));
    controller.handlePointerMove(atViewport(uiStore, 1, frozen.x - 5, 4));
    const preview = uiStore.getState().overlay.canvasEditing?.preview;
    expect(uiStore.getState().overlay.canvasEditing?.workspace).toEqual(frozen);
    // Nothing left of the workspace edge is collected.
    expect(preview).toMatchObject({ kind: 'add', rect: { x: frozen.x, y: 3, width: 2, height: 3 } });
    controller.handlePointerUp(atViewport(uiStore, 1, frozen.x - 5, 4));
    expect(canvasCommands(boundary)[0]).toMatchObject({ rect: { x: frozen.x, y: 3, width: 2, height: 3 } });
    // The workspace is recomputed for the new box after the commit.
    expect(uiStore.getState().overlay.canvasEditing?.workspace).toEqual(canvasWorkspace(boundary.document));
    expect(canvasWorkspace(boundary.document)).not.toEqual(frozen);
    controller.dispose();
  });

  it('selects beyond the canvas with the lasso and adds the selection as one canvas-cells command', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'lasso' });
    // A triangle whose cells reach three columns left of the canvas.
    const corners = [{ x: -3, y: 2 }, { x: 1, y: 2 }, { x: -3, y: 6 }];
    const sample = (point: { x: number; y: number }) => ({
      pointerId: 1, pointerType: 'mouse', screenX: (point.x - uiStore.getState().viewport.x) * ZOOM, screenY: (point.y - uiStore.getState().viewport.y) * ZOOM, button: 0, buttons: 1, isPrimary: true
    });
    controller.handlePointerDown(sample(corners[0]));
    controller.handlePointerMove(sample(corners[1]));
    controller.handlePointerMove(sample(corners[2]));
    controller.handlePointerUp(sample(corners[0]));
    const selection = controller.getCanvasSelection();
    expect(selection?.rect).toEqual({ x: -3, y: 2, width: 4, height: 4 });
    expect(bits(selection?.cells)).toEqual([
      1, 1, 1, 1,
      1, 1, 1, 0,
      1, 1, 0, 0,
      1, 0, 0, 0
    ]);
    expect(uiStore.getState().overlay.canvasEditing?.selection).toBe(selection);

    expect(controller.applyCanvasSelection('add')).toBe(true);
    expect(canvasCommands(boundary)).toEqual([expect.objectContaining({ type: 'canvas-cells', operation: 'add', rect: { x: -3, y: 2, width: 4, height: 4 } })]);
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.canvasEditing?.selection).toBeNull();
    expect(boundary.document).toMatchObject({ width: 13, originX: -3 });
    controller.dispose();
  });

  it('removes a rect selection that reaches past the canvas and clears it', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, 8, -2));
    controller.handlePointerMove(atViewport(uiStore, 1, 12, 1));
    controller.handlePointerUp(atViewport(uiStore, 1, 12, 1));
    expect(controller.getCanvasSelection()).toEqual({ rect: { x: 8, y: -2, width: 5, height: 4 } });
    expect(controller.applyCanvasSelection('remove')).toBe(true);
    expect(canvasCommands(boundary)).toEqual([expect.objectContaining({ type: 'canvas-cells', operation: 'remove', rect: { x: 8, y: -2, width: 5, height: 4 } })]);
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(boundary.document.canvasMask?.[8]).toBe(0);
    controller.dispose();
  });

  it('treats a press inside the canvas selection as a normal Select press', () => {
    const { controller, uiStore } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, -2, 0));
    controller.handlePointerMove(atViewport(uiStore, 1, 0, 1));
    controller.handlePointerUp(atViewport(uiStore, 1, 0, 1));
    const selection = controller.getCanvasSelection();
    expect(selection).toEqual({ rect: { x: -2, y: 0, width: 3, height: 2 } });
    // A click inside keeps the selection.
    controller.handlePointerDown(atViewport(uiStore, 2, -1, 1));
    controller.handlePointerUp(atViewport(uiStore, 2, -1, 1));
    expect(controller.getCanvasSelection()).toBe(selection);
    // A drag from inside replaces it.
    controller.handlePointerDown(atViewport(uiStore, 3, -1, 1));
    controller.handlePointerMove(atViewport(uiStore, 3, 2, 3));
    controller.handlePointerUp(atViewport(uiStore, 3, 2, 3));
    expect(controller.getCanvasSelection()).toEqual({ rect: { x: -1, y: 1, width: 4, height: 3 } });
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(controller.getCanvasSelection()).toBeUndefined();
    controller.dispose();
  });

  it('keeps the selection and shows the domain refusal when a removal would empty the canvas', () => {
    const { boundary, controller, uiStore, notices } = fixture();
    controller.setCanvasMode('advanced');
    controller.setCanvasCropActive(true);
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(atViewport(uiStore, 1, -1, -1));
    controller.handlePointerMove(atViewport(uiStore, 1, 10, 10));
    controller.handlePointerUp(atViewport(uiStore, 1, 10, 10));
    expect(controller.applyCanvasSelection('remove')).toBe(false);
    expect(notices.at(-1)).toBe('The canvas needs at least one cell.');
    expect(uiStore.getState().status).toBe('The canvas needs at least one cell.');
    expect(controller.getCanvasSelection()).toBeDefined();
    expect(boundary.undoStack).toHaveLength(0);
    controller.dispose();
  });

  it('commits one canvas-resize for an edge drag and none when the edge did not move', () => {
    const { boundary, controller, uiStore } = fixture();
    controller.setCanvasCropActive(true);
    const screen = (x: number, y: number) => ({ x: (x - uiStore.getState().viewport.x) * ZOOM, y: (y - uiStore.getState().viewport.y) * ZOOM });
    expect(controller.beginCanvasEdgeDrag('right', screen(10, 5))).toBe(true);
    expect(uiStore.getState().overlay.canvasEditing?.preview).toEqual({ kind: 'resize', box: { x: 0, y: 0, width: 10, height: 10 } });
    controller.updateCanvasEdgeDrag(screen(11.2, 5));
    controller.updateCanvasEdgeDrag(screen(13.4, 7));
    expect(uiStore.getState().overlay.canvasEditing?.preview).toEqual({ kind: 'resize', box: { x: 0, y: 0, width: 13, height: 10 } });
    controller.updateCanvasEdgeDrag(screen(-40, 5));
    expect(uiStore.getState().overlay.canvasEditing?.preview).toEqual({ kind: 'resize', box: { x: 0, y: 0, width: 1, height: 10 } });
    controller.updateCanvasEdgeDrag(screen(12.6, 5));
    expect(canvasCommands(boundary)).toHaveLength(0);
    expect(controller.endCanvasEdgeDrag()).toBe(true);
    expect(canvasCommands(boundary)).toEqual([expect.objectContaining({ type: 'canvas-resize', edges: { top: 0, right: 3, bottom: 0, left: 0 } })]);
    expect(boundary.document.width).toBe(13);
    expect(uiStore.getState().overlay.canvasEditing?.preview).toBeNull();

    controller.beginCanvasEdgeDrag('bottom', screen(5, 10));
    controller.updateCanvasEdgeDrag(screen(5, 10.3));
    expect(controller.endCanvasEdgeDrag()).toBe(false);
    controller.beginCanvasEdgeDrag('bottom', screen(5, 10));
    controller.updateCanvasEdgeDrag(screen(5, 14));
    controller.cancelCanvasEdgeDrag();
    expect(canvasCommands(boundary)).toHaveLength(1);
    expect(uiStore.getState().overlay.canvasEditing?.preview).toBeNull();
    controller.dispose();
  });

  it('reports a resize the domain refuses', () => {
    const { controller, notices } = fixture();
    const workspace = canvasWorkspace({ width: 10, height: 10 });
    expect(controller.resizeCanvasEdge('left', -workspace.x + 1)).toBe(false);
    expect(notices).toHaveLength(1);
    controller.dispose();
  });

  it('grows and shrinks one edge with resizeCanvasEdge', () => {
    const { boundary, controller } = fixture();
    expect(controller.resizeCanvasEdge('left', 1)).toBe(true);
    expect(controller.resizeCanvasEdge('top', -1)).toBe(true);
    expect(controller.resizeCanvasEdge('bottom', 0)).toBe(false);
    expect(canvasCommands(boundary).map((command) => command.type === 'canvas-resize' ? command.edges : undefined)).toEqual([
      { top: 0, right: 0, bottom: 0, left: 1 },
      { top: -1, right: 0, bottom: 0, left: 0 }
    ]);
    expect(boundary.document).toMatchObject({ width: 11, height: 9, originX: -1, originY: 1 });
    expect(boundary.undoStack).toHaveLength(2);
    controller.dispose();
  });

  it('keeps the design screen-stable when growing left and top, and again on undo and redo', () => {
    const { boundary, controller, uiStore } = fixture();
    uiStore.setKeyboardCursor({ x: 4, y: 4 });
    const screenOfDesignCell = { x: (4.5 - uiStore.getState().viewport.x) * ZOOM, y: (4.5 - uiStore.getState().viewport.y) * ZOOM };
    const cellUnder = () => {
      const model = screenToModel(screenOfDesignCell, uiStore.getState().viewport);
      // Convert local to workspace-frame cells, where the design never moves.
      return { x: Math.floor(model.x) + (boundary.document.originX ?? 0), y: Math.floor(model.y) + (boundary.document.originY ?? 0) };
    };
    const start = uiStore.getState().viewport;
    controller.resizeCanvasEdge('left', 3);
    controller.resizeCanvasEdge('top', 2);
    expect(cellUnder()).toEqual({ x: 4, y: 4 });
    expect(uiStore.getState().viewport).toEqual({ ...start, x: start.x + 3, y: start.y + 2 });
    expect(uiStore.getState().keyboardCursor).toEqual({ x: 7, y: 6 });

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(cellUnder()).toEqual({ x: 4, y: 4 });
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(uiStore.getState().viewport).toEqual(start);
    expect(uiStore.getState().keyboardCursor).toEqual({ x: 4, y: 4 });
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(cellUnder()).toEqual({ x: 4, y: 4 });
    controller.dispose();
  });

  it('reframes for an origin change from outside the editor, but not for a different project', () => {
    const { boundary, controller, uiStore } = fixture();
    const start = uiStore.getState().viewport;
    // A change applied by the session (for example its own undo button).
    boundary.execute({ type: 'canvas-resize', edges: { top: 0, right: 0, bottom: 0, left: 4 } });
    expect(uiStore.getState().viewport.x).toBe(start.x + 4);
    const shifted = uiStore.getState().viewport;

    const other = applyCanvasCommand(layeredDocument(10, 10), { type: 'canvas-resize', edges: { top: 7, right: 0, bottom: 0, left: 7 } }).document;
    boundary.switchProject('project-b', other);
    // A project switch fits the new document instead of carrying the old frame over.
    expect(uiStore.getState().viewport.x).not.toBe(shifted.x + 11);
    const fitted = uiStore.getState().viewport;
    boundary.execute({ type: 'canvas-resize', edges: { top: 0, right: 0, bottom: 0, left: 1 } });
    expect(uiStore.getState().viewport.x).toBe(fitted.x + 1);
    controller.dispose();
  });

  it('never previews stitches in a canvas hole, for strokes or shapes', () => {
    const { controller, uiStore } = fixture(maskedDocument(), 1);
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    controller.handlePointerDown(atViewport(uiStore, 1, 1, 5));
    controller.handlePointerMove(atViewport(uiStore, 1, 6, 5));
    const states = uiStore.getState().overlay.pendingCellStates ?? [];
    const cells = states.map((state) => state.cell);
    expect(cells.some((cell) => cell.x === 2) && cells.some((cell) => cell.x === 4)).toBe(true);
    expect(cells.every((cell) => cell.x !== 3)).toBe(true);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state.index % 10 !== 3)).toBe(true);
    controller.handlePointerUp(atViewport(uiStore, 1, 6, 5));

    controller.setTool({ tool: 'shape', shape: 'line' });
    controller.handlePointerDown(atViewport(uiStore, 2, 0, 8));
    controller.handlePointerMove(atViewport(uiStore, 2, 9, 8));
    const shape = uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell) ?? [];
    expect(shape.length).toBeGreaterThan(0);
    expect(shape.every((cell) => cell.x !== 3)).toBe(true);
    controller.handlePointerUp(atViewport(uiStore, 2, 9, 8));
    controller.dispose();
  });

  it('stops Fill at canvas holes', async () => {
    const { boundary, controller, uiStore } = fixture(maskedDocument(), 1);
    controller.selectPalette(2);
    controller.setTool({ tool: 'fill' });
    expect(controller.handlePointerDown(atViewport(uiStore, 1, 0, 0))).toBe(true);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    const fill = boundary.log.find((command) => command.type === 'bulk-cell');
    expect(fill).toBeDefined();
    const indices = Array.from(fill?.indices as Uint32Array);
    expect(indices).toHaveLength(30);
    expect(indices.every((index) => index % 10 < 3)).toBe(true);
    const stitches = boundary.layeredDocument.layers[0];
    expect(stitches.type === LayerType.Stitch && stitches.kind[9]).toBe(CellKind.Empty);
    // A press on the hole itself fills nothing.
    expect(controller.handlePointerDown(atViewport(uiStore, 2, 3, 0))).toBe(true);
    expect(uiStore.getState().status).toBe('No change');
    controller.dispose();
  });
});
