import { describe, expect, it } from 'vitest';
import {
  CellKind,
  LayerType,
  applyCommand,
  applyLayerStructureCommand,
  canAddLayer,
  commandLayerType,
  commitLayerSurface,
  createLayeredDocument,
  findLayer,
  flattenDocument,
  layerAddCommand,
  layerSurface,
  pasteFragmentCommand,
  requireEditableLayer,
  topmostVisibleLayer,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type PatternDocument,
  type PatternFragment
} from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { EditorSurfaceController, backstitchPassesThroughCell, buildBackstitchCellIndex } from './controller';
import {
  HIDDEN_LAYER_TOOL_HINT,
  SPECIALTY_LAYER_BACKSTITCH_HINT,
  STITCH_LAYER_TOOL_HINT,
  EDITABLE_LAYER_TOOL_HINT,
  CANVAS_ADVANCED_TOOL_HINT,
  CANVAS_BASIC_TOOL_HINT,
  CANVAS_BRUSH_LAYER_HINT,
  CANVAS_CROP_OFF_HINT,
  toolAvailability,
  toolStateAvailability,
  type ActiveLayerKind,
  type CanvasRenderer,
  type EditorToolKind,
  type Invalidation,
  type RenderStats,
  type RendererStyle,
  type Viewport
} from './contracts';
import { getCanvasMetrics } from './coordinates';
import { createFillWorkerClient } from './fill';
import {
  compositeInvalidationFor,
  compositeUnchanged,
  createWorkspaceEditorGateway,
  type ActiveLayerId,
  type PasteDestination,
  type WorkspaceEditorBoundary
} from './gateway';
import type { PointerSample } from './input';
import { createUiStore } from './ui-store';

/** A small layered workspace: layer-scoped commands run on one layer surface, as the session does. */
class LayeredBoundary implements WorkspaceEditorBoundary {
  readonly activeProjectId = 'project-a';
  readonly log: DomainCommand[] = [];
  readonly batches: DomainCommand[][] = [];
  activeLayerId: ActiveLayerId = 1;
  document: PatternDocument;
  report: { revision: number; full: boolean; indices?: Uint32Array } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly layeredDocument: LayeredDocument) {
    this.document = flattenDocument(layeredDocument);
  }

  getEditorLayerSnapshot() {
    return { compositeInvalidation: this.report };
  }

  activeLayerSurface(): PatternDocument | null {
    return typeof this.activeLayerId === 'number' ? layerSurface(this.layeredDocument, this.activeLayerId) : null;
  }

  setActiveLayer(id: ActiveLayerId): void {
    this.activeLayerId = id;
    this.emit();
  }

  setVisible(layerId: number, visible: boolean): void {
    findLayer(this.layeredDocument, layerId)!.visible = visible;
    this.layeredDocument.revision += 1;
    this.document = flattenDocument(this.layeredDocument);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  execute(command: DomainCommand): CommandResult {
    this.log.push(command);
    return this.run(command);
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    this.batches.push([...commands]);
    return this.run({ type: 'batch', commands: [...commands] });
  }

  undo(): CommandResult {
    throw new Error('not used');
  }

  redo(): CommandResult {
    throw new Error('not used');
  }

  resolvePaste(type: LayerType): PasteDestination {
    const active = typeof this.activeLayerId === 'number' ? findLayer(this.layeredDocument, this.activeLayerId) : undefined;
    if (active?.type === type && active.visible) return { layerId: active.id, create: false };
    if (canAddLayer(this.layeredDocument, type)) return { layerId: null, create: true, message: `Added a new ${type} layer for your paste.` };
    const top = topmostVisibleLayer(this.layeredDocument, type);
    return top ? { layerId: top.id, create: false, message: 'Pasted on the top layer.' } : { layerId: null, create: false, message: 'Show a layer to paste.' };
  }

  commitPaste(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination) {
    let layerId = destination.layerId;
    if (destination.create) {
      const type = fragment.kind.some((kind) => kind !== CellKind.Empty) ? LayerType.Stitch : LayerType.Specialty;
      layerId = applyLayerStructureCommand(this.layeredDocument, layerAddCommand(type)).layerId!;
    }
    this.activeLayerId = layerId!;
    const result = this.run({ ...pasteFragmentCommand(fragment, position), layerId });
    this.emit();
    return { result, layerId: layerId!, message: destination.message };
  }

  private run(command: DomainCommand): CommandResult {
    const children = command.type === 'batch' ? command.commands as DomainCommand[] : [command];
    const layerId = (children[0]?.layerId as number | undefined) ?? (this.activeLayerId as number);
    requireEditableLayer(this.layeredDocument, layerId, commandLayerType(command));
    const result = applyCommand(layerSurface(this.layeredDocument, layerId), command);
    if (result.changed) commitLayerSurface(this.layeredDocument, layerId, result.document);
    this.document = flattenDocument(this.layeredDocument);
    this.emit();
    return { ...result, document: this.document };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const rendererDocumentCalls: PatternDocument[] = [];
const rendererInvalidations: Array<Invalidation | undefined> = [];

function rendererFixture(): CanvasRenderer {
  let viewport: Viewport = { x: 0, y: 0, zoom: 16 };
  let rendered: PatternDocument | undefined;
  const renderer = {
    lastStats: { lod: 'detail', visitedCells: 0, drawnCells: 0, drawnBackstitches: 0, baseRendered: false, overlayRendered: false } as RenderStats,
    getDocument: () => rendered,
    getViewport: () => viewport,
    getStyle: () => ({}) as RendererStyle,
    getTraceImage: () => undefined,
    setDocument: (document: PatternDocument, invalidation?: Invalidation) => {
      rendered = document;
      rendererDocumentCalls.push(document);
      rendererInvalidations.push(invalidation);
    },
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
function at(pointerId: number, x: number, y: number): PointerSample {
  return { pointerId, pointerType: 'mouse', screenX: x * 16 + 8, screenY: y * 16 + 8, button: 0, buttons: 1, isPrimary: true };
}

function layeredDocument(): LayeredDocument {
  return createLayeredDocument({
    width: 8,
    height: 8,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette: [{ id: 1, name: 'Red', color: '#d33', active: true }, { id: 2, name: 'Blue', color: '#36c', active: true }]
  });
}

/** Apply a command straight to one layer, bypassing the editor, to arrange a test. */
function seed(document: LayeredDocument, layerId: number, command: DomainCommand): void {
  const result = applyCommand(layerSurface(document, layerId), command);
  commitLayerSurface(document, layerId, result.document);
}

function addLayer(document: LayeredDocument, type: LayerType): number {
  return applyLayerStructureCommand(document, layerAddCommand(type)).layerId!;
}

function fixture(document = layeredDocument(), activeLayerId: ActiveLayerId = 1) {
  const boundary = new LayeredBoundary(document);
  boundary.activeLayerId = activeLayerId;
  const gateway = createWorkspaceEditorGateway(boundary);
  const uiStore = createUiStore({ tool: { tool: 'paint', brush: { kind: 'full', paletteId: 1 } } });
  const notices: string[] = [];
  const fillClient = createFillWorkerClient({ workerFactory: () => null, requestIdFactory: () => 'layer-fill' });
  const controller = new EditorSurfaceController({
    gateway,
    uiStore,
    renderer: rendererFixture(),
    metrics: getCanvasMetrics(128, 128),
    fillClient,
    onNotice: (message) => notices.push(message)
  });
  controller.start();
  controller.handleFocus();
  return { boundary, gateway, uiStore, controller, notices, fillClient };
}

function backstitch(x1: number, y1: number, x2: number, y2: number, color = 1): DomainCommand {
  return { type: 'add-backstitch', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color };
}

describe('tool availability', () => {
  const tools: readonly EditorToolKind[] = ['pan', 'eyedropper', 'select', 'lasso', 'eraser', 'paint', 'shape', 'fill', 'backstitch', 'canvas-brush'];
  const expected: Record<ActiveLayerKind, readonly EditorToolKind[]> = {
    stitch: ['pan', 'eyedropper', 'select', 'lasso', 'eraser', 'paint', 'shape', 'fill'],
    specialty: ['pan', 'eyedropper', 'select', 'lasso', 'eraser', 'backstitch'],
    canvas: ['pan'],
    reference: ['pan', 'eyedropper']
  };

  it('follows the layer-type matrix for visible layers', () => {
    for (const kind of Object.keys(expected) as ActiveLayerKind[]) {
      const enabled = tools.filter((tool) => toolAvailability(tool, tool === 'paint' ? 'full' : undefined, { kind, visible: true }).enabled);
      expect({ kind, enabled }).toEqual({ kind, enabled: expected[kind] });
    }
  });

  it('allows only Pan on the Canvas unless crop is active, then Pan only in Basic and the canvas tools in Advanced', () => {
    const canvas = { kind: 'canvas', visible: true } as const;
    const enabledIn = (mode: 'basic' | 'advanced', crop: boolean) => tools.filter((tool) => toolAvailability(tool, undefined, canvas, mode, crop).enabled);
    expect(enabledIn('advanced', false)).toEqual(['pan']);
    expect(toolAvailability('canvas-brush', undefined, canvas, 'advanced')).toEqual({ enabled: false, hint: CANVAS_CROP_OFF_HINT });
    expect(enabledIn('basic', true)).toEqual(['pan']);
    expect(enabledIn('advanced', true)).toEqual(['pan', 'select', 'lasso', 'eraser', 'canvas-brush']);
    expect(toolAvailability('fill', undefined, canvas, 'basic', true)).toEqual({ enabled: false, hint: CANVAS_BASIC_TOOL_HINT });
    expect(toolAvailability('paint', 'full', canvas, 'advanced', true)).toEqual({ enabled: false, hint: CANVAS_ADVANCED_TOOL_HINT });
    expect(toolStateAvailability({ tool: 'canvas-brush' }, canvas, 'advanced', true).enabled).toBe(true);
    // The mode never changes other layers, and the canvas brush is Canvas-only.
    for (const kind of ['stitch', 'specialty', 'reference'] as const) {
      for (const mode of ['basic', 'advanced'] as const) {
        const enabled = tools.filter((tool) => toolAvailability(tool, tool === 'paint' ? 'full' : undefined, { kind, visible: true }, mode, true).enabled);
        expect(enabled).toEqual(expected[kind]);
      }
      expect(toolAvailability('canvas-brush', undefined, { kind, visible: true }, 'advanced', true)).toEqual({ enabled: false, hint: CANVAS_BRUSH_LAYER_HINT });
    }
  });

  it('gates every stitch brush to stitch layers', () => {
    for (const brush of ['full', 'half', 'three-quarter'] as const) {
      expect(toolAvailability('paint', brush, { kind: 'stitch', visible: true }).enabled).toBe(true);
      expect(toolAvailability('paint', brush, { kind: 'specialty', visible: true })).toEqual({ enabled: false, hint: STITCH_LAYER_TOOL_HINT });
    }
  });

  it('gives short hints and disables every editing tool on a hidden layer', () => {
    expect(toolAvailability('backstitch', undefined, { kind: 'stitch', visible: true })).toEqual({ enabled: false, hint: SPECIALTY_LAYER_BACKSTITCH_HINT });
    expect(toolAvailability('fill', undefined, { kind: 'canvas', visible: true })).toEqual({ enabled: false, hint: CANVAS_CROP_OFF_HINT });
    expect(toolAvailability('select', undefined, { kind: 'reference', visible: true })).toEqual({ enabled: false, hint: EDITABLE_LAYER_TOOL_HINT });
    for (const kind of ['stitch', 'specialty'] as const) {
      for (const tool of tools) {
        const availability = toolAvailability(tool, undefined, { kind, visible: false });
        if (tool === 'pan' || tool === 'eyedropper') expect(availability.enabled).toBe(true);
        else if (tool === 'canvas-brush') expect(availability).toEqual({ enabled: false, hint: CANVAS_BRUSH_LAYER_HINT });
        else expect(availability).toEqual({ enabled: false, hint: HIDDEN_LAYER_TOOL_HINT });
      }
    }
    expect(toolAvailability('fill', undefined, null).enabled).toBe(true);
  });
});

describe('layered editor controller', () => {
  it('returns to the last tool used on a layer type when a switch disables the current tool', () => {
    const { boundary, uiStore, controller } = fixture();
    expect(uiStore.getState().activeLayer).toEqual({ id: 1, kind: 'stitch', visible: true });

    boundary.setActiveLayer(2);
    expect(uiStore.getState().activeLayer).toEqual({ id: 2, kind: 'specialty', visible: true });
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    expect(controller.setTool({ tool: 'backstitch' })).toBe(true);

    boundary.setActiveLayer(1);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    boundary.setActiveLayer(2);
    expect(uiStore.getState().tool).toEqual({ tool: 'backstitch' });

    controller.setTool({ tool: 'select' });
    boundary.setActiveLayer(1);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    boundary.setActiveLayer('canvas');
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    controller.dispose();
  });

  it('restores the tool remembered for a layer type even when the current tool works there', () => {
    const document = layeredDocument();
    const otherSpecialty = addLayer(document, LayerType.Specialty);
    const { boundary, uiStore, controller } = fixture(document);
    controller.setTool({ tool: 'eraser' });
    boundary.setActiveLayer(2);
    // Nothing is remembered for specialty yet, and the eraser works there.
    expect(uiStore.getState().tool.tool).toBe('eraser');
    controller.setTool({ tool: 'backstitch' });
    boundary.setActiveLayer(1);
    expect(uiStore.getState().tool.tool).toBe('eraser');
    controller.setTool({ tool: 'pan' });
    boundary.setActiveLayer(2);
    expect(uiStore.getState().tool).toEqual({ tool: 'backstitch' });
    // Between layers of one type the current tool stays.
    controller.setTool({ tool: 'eraser' });
    boundary.setActiveLayer(otherSpecialty);
    expect(uiStore.getState().tool.tool).toBe('eraser');
    boundary.setActiveLayer(1);
    expect(uiStore.getState().tool).toEqual({ tool: 'pan' });
    controller.dispose();
  });

  it.each(['move-image', 'resize-image'] as const)('leaves %s on a layer switch and never remembers it', (imageTool) => {
    const document = layeredDocument();
    const { boundary, uiStore, controller } = fixture(document);
    controller.setTraceImage({ source: {}, width: 2, height: 2, chartBounds: { x: 0, y: 0, width: 2, height: 2 } });
    controller.setTool({ tool: 'eraser' });
    controller.setTool({ tool: imageTool });
    expect(uiStore.getState().tool).toEqual({ tool: imageTool });

    boundary.setActiveLayer(2);
    expect(uiStore.getState().tool.tool).toBe('eraser');
    expect(uiStore.getState().overlay.imageResizeHandles).not.toBe(true);
    expect(uiStore.lastToolForLayer('stitch')?.tool).toBe('eraser');

    controller.setTool({ tool: imageTool });
    boundary.setActiveLayer(1);
    expect(uiStore.getState().tool.tool).toBe('eraser');
    expect(uiStore.lastToolForLayer('specialty')?.tool).toBe('eraser');
    controller.dispose();
  });

  it('refuses edits on a hidden layer and shows the hint', () => {
    const { boundary, controller, notices, uiStore } = fixture();
    boundary.setVisible(1, false);
    expect(uiStore.getState().activeLayer).toEqual({ id: 1, kind: 'stitch', visible: false });

    expect(controller.handlePointerDown(at(1, 0, 0))).toBe(false);
    controller.handlePointerUp(at(1, 0, 0));
    expect(boundary.log).toHaveLength(0);
    expect(boundary.layeredDocument.layers[0].type === LayerType.Stitch && boundary.layeredDocument.layers[0].kind[0]).toBe(CellKind.Empty);
    expect(notices.at(-1)).toBe(HIDDEN_LAYER_TOOL_HINT);

    expect(controller.setTool({ tool: 'fill' })).toBe(false);
    expect(uiStore.getState().tool.tool).toBe('paint');
    controller.dispose();
  });

  it('paints only the selected layer and reads hover info from the composite', () => {
    const document = layeredDocument();
    const top = addLayer(document, LayerType.Stitch);
    seed(document, 1, { type: 'set-full', x: 3, y: 3, color: 2 });
    const { boundary, controller, uiStore } = fixture(document, top);
    controller.handlePointerDown(at(1, 0, 0));
    controller.handlePointerUp(at(1, 0, 0));
    const [bottom, upper] = boundary.layeredDocument.layers;
    expect(bottom.type === LayerType.Stitch && bottom.kind[0]).toBe(CellKind.Empty);
    expect(upper.type === LayerType.Stitch && upper.kind[0]).toBe(CellKind.Full);
    expect(boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', layerId: top });

    uiStore.setKeyboardCursor({ x: 3, y: 3 });
    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    controller.handleKeyDown({ key: 'ArrowLeft', preventDefault: () => undefined });
    expect(uiStore.getState().selectedCell).toMatchObject({ geometry: 'full', paletteId: 2 });
    controller.dispose();
  });

  it('bounds Fill by the selected layer only', async () => {
    const document = layeredDocument();
    for (let y = 0; y < 8; y += 1) seed(document, 1, { type: 'set-full', x: 2, y, color: 1 });
    const top = addLayer(document, LayerType.Stitch);
    const { boundary, controller, fillClient } = fixture(document, top);
    controller.selectPalette(2);
    controller.setTool({ tool: 'fill' });
    expect(controller.handlePointerDown(at(1, 0, 0))).toBe(true);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();

    const [bottom, upper] = boundary.layeredDocument.layers;
    expect(upper.type === LayerType.Stitch && Array.from(upper.kind).every((kind) => kind === CellKind.Full)).toBe(true);
    expect(upper.type === LayerType.Stitch && upper.colors[(7 * 8 + 7) * 4]).toBe(2);
    expect(bottom.type === LayerType.Stitch && bottom.colors[2 * 4]).toBe(1);
    expect(bottom.type === LayerType.Stitch && bottom.kind[0]).toBe(CellKind.Empty);
    fillClient.dispose();
    controller.dispose();
  });

  it('samples the topmost visible stitch with the eyedropper', () => {
    const document = layeredDocument();
    const top = addLayer(document, LayerType.Stitch);
    seed(document, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    seed(document, top, { type: 'set-full', x: 0, y: 0, color: 2 });
    const { boundary, controller, uiStore } = fixture(document, 1);
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(at(1, 0, 0));
    expect(uiStore.getState().paletteId).toBe(2);

    boundary.setVisible(top, false);
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(at(2, 0, 0));
    expect(uiStore.getState().paletteId).toBe(1);
    controller.dispose();
  });

  it('copies only backstitches from a specialty layer', () => {
    const document = layeredDocument();
    seed(document, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    seed(document, 2, backstitch(0, 0, 4, 4));
    const { controller } = fixture(document, 2);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    const copied = controller.copySelection()!;
    expect(Array.from(copied.kind).every((kind) => kind === CellKind.Empty)).toBe(true);
    expect(copied.backstitches.x1).toHaveLength(1);
    controller.dispose();
  });

  it('routes a stitch paste onto a new stitch layer when a specialty layer is selected', () => {
    const document = layeredDocument();
    seed(document, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    const { boundary, controller, notices, uiStore } = fixture(document, 1);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    controller.copySelection();

    boundary.setActiveLayer(2);
    expect(controller.pasteSelection()).toBe(true);
    controller.confirmFloatingPaste();

    const created = boundary.layeredDocument.layers.find((layer) => layer.id === 3);
    expect(created?.type).toBe(LayerType.Stitch);
    expect(created?.type === LayerType.Stitch && created.kind[0]).toBe(CellKind.Full);
    expect(boundary.activeLayerId).toBe(3);
    expect(uiStore.getState().activeLayer).toEqual({ id: 3, kind: 'stitch', visible: true });
    expect(notices).toEqual(['Added a new stitch layer for your paste.']);
    controller.dispose();
  });

  it('does not paste when no layer of the clipboard type can take it', () => {
    const document = layeredDocument();
    seed(document, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    addLayer(document, LayerType.Stitch);
    addLayer(document, LayerType.Stitch);
    const { boundary, controller, notices } = fixture(document, 1);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 0, y: 0 });
    controller.copySelection();
    for (const layer of boundary.layeredDocument.layers) if (layer.type === LayerType.Stitch) layer.visible = false;
    boundary.setActiveLayer(2);

    controller.pasteSelection();
    controller.confirmFloatingPaste();
    expect(boundary.log).toHaveLength(0);
    expect(notices).toEqual(['Show a layer to paste.']);
    controller.dispose();
  });

  it('erases only the touched backstitches of the selected specialty layer in one batch', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(4, 4, 8, 8));
    seed(document, 2, backstitch(4, 4, 4, 8));
    seed(document, 2, backstitch(0, 0, 4, 4));
    seed(document, 2, backstitch(20, 20, 24, 20));
    const other = addLayer(document, LayerType.Specialty);
    seed(document, other, backstitch(4, 4, 8, 8));
    const { boundary, controller, uiStore } = fixture(document, 2);
    const ids = (layerId: number) => {
      const layer = findLayer(boundary.layeredDocument, layerId)!;
      return layer.type === LayerType.Specialty ? Array.from(layer.backstitches.ids) : [];
    };
    const [touchedDiagonal, touchedEdge, cornerOnly, far] = ids(2);
    const otherIds = ids(other);

    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(at(1, 1, 1));
    controller.handlePointerMove(at(1, 1, 1));
    expect(uiStore.getState().overlay.pendingBackstitchRemovals?.map((removal) => removal.id).sort()).toEqual([touchedDiagonal, touchedEdge].sort());
    controller.handlePointerUp(at(1, 1, 1));

    expect(uiStore.getState().overlay.pendingBackstitchRemovals).toBeUndefined();
    expect(ids(2)).toEqual([cornerOnly, far]);
    expect(ids(other)).toEqual(otherIds);
    expect(boundary.batches).toHaveLength(1);
    expect(boundary.batches[0].map((command) => command.type)).toEqual(['remove-backstitch', 'remove-backstitch']);
    expect(boundary.batches[0].every((command) => command.layerId === 2)).toBe(true);
    controller.dispose();
  });

  it('honors brush size when erasing backstitches', () => {
    const document = layeredDocument();
    // The pointer is at (1.25, 1.5); the stitch on x = 2 is 0.75 cells away, past
    // brush 1's half-cell pick radius at zoom 16 but inside brush 3's 3x3 footprint.
    seed(document, 2, backstitch(8, 4, 8, 8));
    seed(document, 2, backstitch(24, 24, 28, 24));
    const { boundary, controller } = fixture(document, 2);
    const count = () => {
      const layer = findLayer(boundary.layeredDocument, 2)!;
      return layer.type === LayerType.Specialty ? layer.backstitches.ids.length : 0;
    };
    const press = { ...at(1, 1, 1), screenX: 20 };
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(press);
    controller.handlePointerUp(press);
    expect(count()).toBe(2);
    controller.setBrushSize(3);
    controller.handlePointerDown({ ...press, pointerId: 2 });
    controller.handlePointerUp({ ...press, pointerId: 2 });
    expect(count()).toBe(1);
    controller.dispose();
  });

  it.each([
    { pointerType: 'mouse' as const, touchMovementOnly: false },
    { pointerType: 'pen' as const, touchMovementOnly: false },
    { pointerType: 'pen' as const, touchMovementOnly: true },
    { pointerType: 'touch' as const, touchMovementOnly: false }
  ])('erases a clicked backstitch and keeps the eraser ($pointerType, pencil mode $touchMovementOnly)', ({ pointerType, touchMovementOnly }) => {
    const document = layeredDocument();
    seed(document, 2, backstitch(4, 8, 12, 8));
    const { boundary, controller, uiStore } = fixture(document, 2);
    controller.setTouchMovementOnly(touchMovementOnly);
    expect(controller.setTool({ tool: 'eraser' })).toBe(true);
    const sample = { ...at(1, 1, 1), pointerType, screenY: 32 };
    controller.handlePointerMove({ ...sample, buttons: 0 });
    controller.handlePointerDown(sample);
    controller.handlePointerUp({ ...sample, buttons: 0 });
    expect(controller.getSelectedBackstitchId()).toBeUndefined();
    expect(uiStore.getState().tool.tool).toBe('eraser');
    const layer = findLayer(boundary.layeredDocument, 2)!;
    expect(layer.type === LayerType.Specialty && layer.backstitches.ids.length).toBe(0);
    controller.dispose();
  });

  it('reaches exactly the drawn footprint with a brush wider than one cell', () => {
    const document = layeredDocument();
    // Brush 3 at cell (1, 1) stamps cells (0..2, 0..2).
    seed(document, 2, backstitch(0, 0, 4, 0)); // top edge of corner cell (0, 0), about 1.6 cells from the pointer
    seed(document, 2, backstitch(12, 0, 16, 4)); // cell (3, 0) only: touches the outline at a corner
    const { boundary, controller, uiStore } = fixture(document, 2);
    const ids = () => {
      const layer = findLayer(boundary.layeredDocument, 2)!;
      return layer.type === LayerType.Specialty ? Array.from(layer.backstitches.ids) : [];
    };
    const [corner, outside] = ids();
    controller.setTool({ tool: 'eraser' });
    controller.setBrushSize(3);
    controller.handlePointerMove({ ...at(1, 1, 1), buttons: 0 });
    expect(uiStore.getState().overlay.pendingBackstitchRemovals?.map((removal) => removal.id)).toEqual([corner]);
    controller.handlePointerDown(at(1, 1, 1));
    controller.handlePointerUp(at(1, 1, 1));
    expect(ids()).toEqual([outside]);
    controller.dispose();
  });

  it('erases only the touched stitch of two sharing a cell with a one-cell brush', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(4, 4, 4, 8)); // x = 1, a quarter cell from the pointer
    seed(document, 2, backstitch(8, 4, 8, 8)); // x = 2, same cell, 0.75 cells away
    const { boundary, controller, uiStore } = fixture(document, 2);
    const ids = () => {
      const layer = findLayer(boundary.layeredDocument, 2)!;
      return layer.type === LayerType.Specialty ? Array.from(layer.backstitches.ids) : [];
    };
    const [touched, sharing] = ids();
    const press = { ...at(1, 1, 1), screenX: 20 };
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerMove({ ...press, buttons: 0 });
    expect(uiStore.getState().overlay.pendingBackstitchRemovals?.map((removal) => removal.id)).toEqual([touched]);
    controller.handlePointerDown(press);
    controller.handlePointerUp(press);
    expect(ids()).toEqual([sharing]);
    controller.dispose();
  });

  it('keeps a wide-brush drag continuous between far-apart samples', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(16, 0, 16, 4)); // x = 4, crossed only between the samples
    const { boundary, controller } = fixture(document, 2);
    controller.setTool({ tool: 'eraser' });
    controller.setBrushSize(3);
    controller.handlePointerDown(at(1, 1, 1));
    controller.handlePointerMove(at(1, 7, 1));
    controller.handlePointerUp(at(1, 7, 1));
    const layer = findLayer(boundary.layeredDocument, 2)!;
    expect(layer.type === LayerType.Specialty && layer.backstitches.ids.length).toBe(0);
    controller.dispose();
  });

  it('erases only backstitches within the hit radius of the eraser path', () => {
    const document = layeredDocument();
    // At zoom 16 the radius is half a cell. The pointer runs along y = 1.5 from x = 0.5 to 6.5.
    seed(document, 2, backstitch(12, 0, 12, 4));
    seed(document, 2, backstitch(16, 8, 20, 8));
    seed(document, 2, backstitch(4, 16, 8, 16));
    const { boundary, controller, uiStore } = fixture(document, 2);
    const ids = () => {
      const layer = findLayer(boundary.layeredDocument, 2)!;
      return layer.type === LayerType.Specialty ? Array.from(layer.backstitches.ids) : [];
    };
    const [crossedOnTheWay, endpointOnPath, oneCellAway] = ids();
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(at(1, 0, 1));
    // One sample jumps the whole stroke, so the segment between samples is measured.
    controller.handlePointerMove(at(1, 6, 1));
    expect(uiStore.getState().overlay.pendingBackstitchRemovals?.map((removal) => removal.id).sort()).toEqual([crossedOnTheWay, endpointOnPath].sort());
    controller.handlePointerUp(at(1, 6, 1));
    expect(ids()).toEqual([oneCellAway]);
    controller.dispose();
  });

  it('marks the backstitches an eraser hover would remove and clears them on leave', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(4, 4, 4, 12));
    seed(document, 2, backstitch(20, 20, 28, 20));
    const { boundary, controller, uiStore } = fixture(document, 2);
    const layer = findLayer(boundary.layeredDocument, 2)!;
    const [near] = layer.type === LayerType.Specialty ? Array.from(layer.backstitches.ids) : [];
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerMove({ ...at(1, 1, 1), buttons: 0 });
    expect(uiStore.getState().overlay.pendingBackstitchRemovals?.map((removal) => removal.id)).toEqual([near]);
    controller.handlePointerLeave();
    expect(uiStore.getState().overlay.pendingBackstitchRemovals).toBeUndefined();
    controller.dispose();
  });

  it('draws a new backstitch next to an existing one in draw mode', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(4, 8, 12, 8));
    const { boundary, controller } = fixture(document, 2);
    controller.setTool({ tool: 'backstitch' });
    controller.handlePointerDown({ ...at(1, 1, 1), screenX: 32, screenY: 32 });
    expect(controller.getSelectedBackstitchId()).toBeUndefined();
    controller.handlePointerUp({ ...at(1, 1, 3), screenX: 32, screenY: 64 });
    const layer = findLayer(boundary.layeredDocument, 2)!;
    // Both lines span two cells, so each is stored as two one-cell records.
    expect(layer.type === LayerType.Specialty && layer.backstitches.ids.length).toBe(4);
    // The press lands on the existing stitch at (2, 2) and still starts a new one there.
    expect(boundary.log.at(-1)).toMatchObject({ type: 'add-backstitch', start: { x: 8, y: 8 }, end: { x: 8, y: 16 } });
    controller.dispose();
  });

  it('draws from a cell-edge midpoint to a corner', () => {
    const { boundary, controller } = fixture(layeredDocument(), 2);
    controller.setTool({ tool: 'backstitch' });
    // (1.5, 2) is the midpoint of a horizontal edge; (3, 3) is a corner.
    controller.handlePointerDown({ ...at(1, 0, 0), screenX: 24, screenY: 32 });
    controller.handlePointerUp({ ...at(1, 0, 0), screenX: 48, screenY: 48 });
    expect(boundary.log.at(-1)).toMatchObject({ type: 'add-backstitch', start: { x: 6, y: 8 }, end: { x: 12, y: 12 } });
    controller.dispose();
  });

  it.each([
    { pointerType: 'mouse' as const, jitter: 0 },
    { pointerType: 'mouse' as const, jitter: 3 },
    { pointerType: 'pen' as const, jitter: 3 },
    { pointerType: 'touch' as const, jitter: 7 }
  ])('selects without moving on a Move-mode tap ($pointerType, $jitter px jitter)', ({ pointerType, jitter }) => {
    const document = layeredDocument();
    seed(document, 2, backstitch(8, 8, 12, 8));
    const { boundary, controller, uiStore } = fixture(document, 2);
    controller.setBackstitchMode('move');
    // Pressed beside the end corner (3, 2), well inside its snap range.
    const press = { ...at(1, 0, 0), pointerType, screenX: 46, screenY: 32 };
    controller.handlePointerDown(press);
    controller.handlePointerMove({ ...press, screenY: press.screenY + jitter });
    expect(uiStore.getState().overlay.backstitchPreview).toMatchObject({ start: { x: 8, y: 8 }, end: { x: 12, y: 8 } });
    controller.handlePointerUp({ ...press, screenY: press.screenY + jitter });
    expect(controller.getSelectedBackstitchId()).toBeDefined();
    expect(boundary.log).toEqual([]);
    const layer = findLayer(boundary.layeredDocument, 2)!;
    expect(layer.type === LayerType.Specialty && [layer.backstitches.x2[0], layer.backstitches.y2[0]]).toEqual([12, 8]);
    controller.dispose();
  });

  it('moves the endpoint once a touch drag passes the slop', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(8, 8, 12, 8));
    const { boundary, controller } = fixture(document, 2);
    controller.setBackstitchMode('move');
    const press = { ...at(1, 0, 0), pointerType: 'touch' as const, screenX: 48, screenY: 32 };
    controller.handlePointerDown(press);
    controller.handlePointerMove({ ...press, screenY: 41 });
    controller.handlePointerUp({ ...press, screenY: 41 });
    expect(boundary.log.at(-1)).toMatchObject({ type: 'move-backstitch', start: { x: 8, y: 8 }, end: { x: 12, y: 10 } });
    controller.dispose();
  });

  it('moves a backstitch endpoint onto a cell-edge midpoint', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(8, 8, 12, 8));
    const { boundary, controller } = fixture(document, 2);
    controller.setBackstitchMode('move');
    controller.handlePointerDown({ ...at(1, 0, 0), screenX: 48, screenY: 32 });
    // (3, 2.5) is the midpoint of a vertical edge.
    controller.handlePointerMove({ ...at(1, 0, 0), screenX: 48, screenY: 40 });
    controller.handlePointerUp({ ...at(1, 0, 0), screenX: 48, screenY: 40 });
    expect(boundary.log.at(-1)).toMatchObject({ type: 'move-backstitch', start: { x: 8, y: 8 }, end: { x: 12, y: 10 } });
    const layer = findLayer(boundary.layeredDocument, 2)!;
    expect(layer.type === LayerType.Specialty && [layer.backstitches.x2[0], layer.backstitches.y2[0]]).toEqual([12, 10]);
    controller.dispose();
  });

  it('only picks up backstitches in move mode, and a miss draws nothing and clears the selection', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(4, 8, 8, 8));
    const { boundary, controller, uiStore } = fixture(document, 2);
    expect(controller.setBackstitchMode('move')).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'backstitch', mode: 'move' });
    expect(controller.handlePointerDown({ ...at(1, 1, 1), screenY: 32 })).toBe(true);
    expect(controller.getSelectedBackstitchId()).toBeDefined();
    controller.handlePointerUp({ ...at(1, 1, 1), screenY: 32 });

    expect(controller.handlePointerDown(at(2, 5, 5))).toBe(false);
    controller.handlePointerUp(at(2, 6, 6));
    expect(controller.getSelectedBackstitchId()).toBeUndefined();
    const layer = findLayer(boundary.layeredDocument, 2)!;
    expect(layer.type === LayerType.Specialty && layer.backstitches.ids.length).toBe(1);
    expect(boundary.log.some((command) => command.type === 'add-backstitch')).toBe(false);

    expect(controller.setBackstitchMode('draw')).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'backstitch', mode: 'draw' });
    controller.dispose();
  });

  it('refuses a backstitch mode off a specialty layer', () => {
    const { controller, notices, uiStore } = fixture();
    expect(controller.setBackstitchMode('move')).toBe(false);
    expect(uiStore.getState().tool.tool).toBe('paint');
    expect(notices.at(-1)).toBe(SPECIALTY_LAYER_BACKSTITCH_HINT);
    controller.dispose();
  });

  it('picks up backstitches only from the selected specialty layer', () => {
    const document = layeredDocument();
    const other = addLayer(document, LayerType.Specialty);
    seed(document, other, backstitch(0, 8, 32, 8));
    const { controller } = fixture(document, 2);
    controller.setTool({ tool: 'backstitch' });
    controller.handlePointerDown({ ...at(1, 1, 1), screenY: 32 });
    expect(controller.getSelectedBackstitchId()).toBeUndefined();
    controller.handlePointerCancel({ ...at(1, 1, 1), screenY: 32 });
    controller.dispose();
  });
});

describe('layered editor previews and paste edge cases', () => {
  it('hides paint preview cells that a visible upper stitch layer covers', () => {
    const document = layeredDocument();
    const top = addLayer(document, LayerType.Stitch);
    seed(document, top, { type: 'set-full', x: 0, y: 0, color: 2 });
    const { controller, uiStore } = fixture(document, 1);
    controller.handlePointerDown(at(1, 0, 0));
    controller.handlePointerMove(at(1, 1, 0));
    expect(uiStore.getState().overlay.pendingCellStates?.map((state) => state.index)).toEqual([1]);
    controller.handlePointerUp(at(1, 1, 0));
    const bottom = stitchLayer(document, 1);
    expect(bottom.kind[0]).toBe(CellKind.Full);
    controller.dispose();
  });

  it('previews an erase on an upper layer as the stitch the lower layer shows', () => {
    const document = layeredDocument();
    const top = addLayer(document, LayerType.Stitch);
    seed(document, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    seed(document, top, { type: 'set-full', x: 0, y: 0, color: 2 });
    seed(document, top, { type: 'set-full', x: 1, y: 0, color: 2 });
    const { controller, uiStore } = fixture(document, top);
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerDown(at(1, 0, 0));
    controller.handlePointerMove(at(1, 1, 0));
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { index: 0, kind: CellKind.Full, colors: [1, 0, 0, 0] },
      { index: 1, kind: CellKind.Empty, colors: [0, 0, 0, 0] }
    ]);
    controller.handlePointerCancel(at(1, 1, 0));
    controller.dispose();
  });

  it('does not create a layer or history entry for an empty paste', () => {
    const { boundary: workspace, controller, notices } = fixture(layeredDocument(), 1);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    controller.copySelection();
    workspace.setActiveLayer(2);
    controller.pasteSelection();
    controller.handlePointerDown(at(1, 6, 6));
    expect(workspace.layeredDocument.layers).toHaveLength(2);
    expect(workspace.log).toHaveLength(0);
    expect(notices).toEqual([]);
    controller.dispose();
  });

  it('skips the redraw for a result tagged compositeUnchanged', () => {
    const { boundary: workspace, controller, uiStore } = fixture(layeredDocument(), 1);
    workspace.undo = () => {
      workspace.layeredDocument.revision += 1;
      workspace.document = { ...workspace.document, revision: workspace.layeredDocument.revision };
      return { document: workspace.document, changed: true, revision: workspace.layeredDocument.revision, compositeChangedIndices: new Uint32Array(), compositeUnchanged: true };
    };
    const before = rendererDocumentCalls.length;
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(rendererDocumentCalls.length).toBe(before);
    expect(uiStore.getState().status).toBe('Undid action');
    controller.dispose();
  });

  it('redraws only the cells the session reports for an outside change', () => {
    const document = layeredDocument();
    const top = addLayer(document, LayerType.Stitch);
    seed(document, top, { type: 'set-full', x: 2, y: 3, color: 2 });
    const { boundary: workspace, controller } = fixture(document, 1);
    findLayer(workspace.layeredDocument, top)!.visible = false;
    workspace.layeredDocument.revision += 1;
    workspace.document = flattenDocument(workspace.layeredDocument);
    workspace.report = { revision: workspace.layeredDocument.revision, full: false, indices: new Uint32Array([3 * 8 + 2]) };
    workspace.setActiveLayer(1);
    expect(rendererInvalidations.at(-1)).toMatchObject({ cellRect: { x: 2, y: 3, width: 1, height: 1 }, cellIndices: new Uint32Array([26]), reason: 'layer-stack' });
    expect(rendererInvalidations.at(-1)?.full).toBeUndefined();

    // A report for another revision is not trusted.
    findLayer(workspace.layeredDocument, top)!.visible = true;
    workspace.layeredDocument.revision += 1;
    workspace.document = flattenDocument(workspace.layeredDocument);
    workspace.setActiveLayer(1);
    expect(rendererInvalidations.at(-1)).toMatchObject({ full: true, reason: 'layer-stack' });
    expect(rendererInvalidations.at(-1)?.cellIndices).toBeUndefined();
    controller.dispose();
  });

  it('keeps the viewport object when an outside change leaves it unchanged', () => {
    const { boundary: workspace, controller, uiStore } = fixture(layeredDocument(), 1);
    const viewport = uiStore.getState().viewport;
    workspace.setVisible(1, false);
    expect(uiStore.getState().viewport).toBe(viewport);
    controller.dispose();
  });

  it('redraws once when layer visibility changes', () => {
    const { boundary: workspace, controller } = fixture(layeredDocument(), 1);
    const before = rendererDocumentCalls.length;
    workspace.setVisible(2, false);
    expect(rendererDocumentCalls.length - before).toBe(1);
    controller.dispose();
  });
});

function stitchLayer(document: LayeredDocument, layerId: number) {
  const layer = findLayer(document, layerId)!;
  if (layer.type !== LayerType.Stitch) throw new Error('expected a stitch layer');
  return layer;
}

describe('layer helpers', () => {
  it('counts edge overlap but not a corner touch as passing through a cell', () => {
    expect(backstitchPassesThroughCell(4, 4, 8, 8, 1, 1)).toBe(true);
    expect(backstitchPassesThroughCell(4, 4, 4, 12, 1, 1)).toBe(true);
    expect(backstitchPassesThroughCell(4, 4, 4, 12, 0, 1)).toBe(true);
    expect(backstitchPassesThroughCell(0, 0, 4, 4, 1, 1)).toBe(false);
    expect(backstitchPassesThroughCell(20, 20, 28, 20, 1, 1)).toBe(false);
  });

  it('indexes only the cells a long diagonal crosses', () => {
    const document = flattenDocument(createLayeredDocument({ width: 1000, height: 1000, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    document.backstitches = {
      ids: new Uint32Array([1]),
      x1: new Uint32Array([0]),
      y1: new Uint32Array([0]),
      x2: new Uint32Array([4000]),
      y2: new Uint32Array([4000]),
      colors: new Uint16Array([1]),
      completed: new Uint8Array(1)
    };
    const index = buildBackstitchCellIndex(document);
    expect(index.size).toBe(1000);
    for (let cell = 0; cell < 1000; cell += 1) expect(index.get(cell * 1000 + cell)).toEqual([0]);
  });

  it('indexes the same cells as testing every cell', () => {
    const size = 6;
    const document = flattenDocument(createLayeredDocument({ width: size, height: size, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const segments: Array<[number, number, number, number]> = [];
    for (let x1 = 0; x1 <= size * 4; x1 += 3) {
      for (let y1 = 0; y1 <= size * 4; y1 += 5) {
        for (const [x2, y2] of [[x1 + 4, y1], [x1, y1 + 8], [x1 + 7, y1 + 3], [x1 - 5, y1 + 9], [x1 + 8, y1 + 8], [x1 + 1, y1 - 6]]) {
          if (x2 < 0 || y2 < 0 || x2 > size * 4 || y2 > size * 4) continue;
          segments.push([x1, y1, x2, y2]);
        }
      }
    }
    document.backstitches = {
      ids: new Uint32Array(segments.map((_, position) => position + 1)),
      x1: new Uint32Array(segments.map((segment) => segment[0])),
      y1: new Uint32Array(segments.map((segment) => segment[1])),
      x2: new Uint32Array(segments.map((segment) => segment[2])),
      y2: new Uint32Array(segments.map((segment) => segment[3])),
      colors: new Uint16Array(segments.length).fill(1),
      completed: new Uint8Array(segments.length)
    };
    const index = buildBackstitchCellIndex(document);
    for (let cell = 0; cell < size * size; cell += 1) {
      const expected = segments.flatMap(([x1, y1, x2, y2], position) => backstitchPassesThroughCell(x1, y1, x2, y2, cell % size, Math.floor(cell / size)) ? [position] : []);
      expect({ cell, positions: index.get(cell) ?? [] }).toEqual({ cell, positions: expected });
    }
  });

  it('prefers composite invalidation fields', () => {
    const document = flattenDocument(layeredDocument());
    const base = { document, changed: true, revision: 1 };
    expect(compositeInvalidationFor({ ...base, compositeFull: true })).toMatchObject({ full: true });
    expect(compositeInvalidationFor({ ...base, changedIndices: new Uint32Array([0]), compositeChangedIndices: new Uint32Array([9]) }))
      .toMatchObject({ cellRect: { x: 1, y: 1, width: 1, height: 1 } });
    expect(compositeInvalidationFor({ ...base, changedIndices: new Uint32Array([0]) })).toMatchObject({ cellRect: { x: 0, y: 0, width: 1, height: 1 } });
    expect(compositeInvalidationFor({ ...base, compositeChangedIndices: new Uint32Array() })).toMatchObject({ full: true });
    expect(compositeUnchanged({ ...base, compositeUnchanged: true })).toBe(true);
    expect(compositeUnchanged(base)).toBe(false);
  });
});
