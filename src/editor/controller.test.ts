import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClipboard } from './clipboard-store';
import { CellKind, collectValidationErrors, createDocument, DomainError, QuarterCorner, type BulkCellCommand, type PatternDocument, type ProgressCommand } from '../domain';
import { markCellComplete, STITCH_LAYER_ID, applyCommand, cell } from '../domain/test-fixtures';
import { fixture, LayeredTestBoundary } from './test-support';
import { getCanvasMetrics } from './coordinates';
import { EditorSurfaceController, selectedCellSemantics, type EditorSurfaceControllerOptions } from './controller';
import { createUiStore } from './ui-store';
import { DEFAULT_CATALOG_DEFINITION, type CatalogDefinition, type CatalogRecord } from '../catalog';
import type { TraceImage } from './contracts';
import { CHART_EDGE_MARGIN, HIDDEN_LAYER_PICK_HINT } from './contracts';
import type { KeyboardSample, PointerSample } from './input';

function pointer(pointerId: number, screenX: number, screenY: number, pointerType = 'mouse', button = 0, modifiers: Partial<PointerSample> = {}): PointerSample {
  return { pointerId, pointerType, screenX, screenY, button, buttons: button === 0 ? 1 : 4, isPrimary: true, ...modifiers };
}

/** The 8x8 one-color document the controller tests open on the default layers. */
function threadDocument(): PatternDocument {
  return createDocument({ width: 8, height: 8, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
}

function rubySkyDocument(): PatternDocument {
  return createDocument({
    width: 8,
    height: 8,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true }, { id: 2, name: 'Sky', color: '#48c', active: true }]
  });
}

function controllerFixture(options: Partial<EditorSurfaceControllerOptions> = {}, document = threadDocument()) {
  return fixture(new LayeredTestBoundary(document), { controller: options });
}

// The clipboard outlives controllers, so each case starts without one.
beforeEach(clearClipboard);

describe('EditorSurfaceController', () => {
  it('defaults new UI stores to pan while preserving explicit initial tools', () => {
    expect(createUiStore().getState().tool).toEqual({ tool: 'pan' });
    expect(createUiStore({ tool: { tool: 'paint', brush: { kind: 'full', paletteId: 1 } } }).getState().tool).toEqual({
      tool: 'paint',
      brush: { kind: 'full', paletteId: 1 }
    });
  });

  it('adds the nearest DMC color to the palette and activates the paint brush when sampling the reference image', () => {
    const trace: TraceImage = { source: {}, width: 4, height: 4 };
    const rgb = { r: 12, g: 34, b: 56 };
    const traceSampler = vi.fn(() => ({ ...rgb }));
    const { boundary, gateway, uiStore, controller } = controllerFixture({
      traceImage: trace,
      traceSampler,
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    });
    controller.setTool({ tool: 'eyedropper' });
    const matched = DEFAULT_CATALOG_DEFINITION.nearest(rgb);
    expect(matched).toBeDefined();
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(traceSampler).toHaveBeenCalledTimes(1);
    const create = boundary.log.find((command) => command.type === 'palette-create');
    expect(create).toMatchObject({ type: 'palette-create', name: matched!.name, color: matched!.hex });
    expect(create).toMatchObject({ catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: matched!.sourceId } });
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === matched!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: added!.id } });
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    controller.dispose();
  });

  it('samples the reference image without changing state when the document catalog is unavailable', () => {
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: { catalogId: 'missing-catalog', brandLabel: 'Missing', colorCount: 1 },
      palette: [{ id: 1, name: 'Custom', color: '#123456', active: true }]
    });
    const traceSampler = vi.fn(() => ({ r: 12, g: 34, b: 56 }));
    const { boundary, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler
    }, document);
    controller.setTool({ tool: 'eyedropper' });
    const beforePalette = document.palette.map((entry) => ({ ...entry }));
    const beforeState = uiStore.getState();
    const commandCount = boundary.log.length;

    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(false);
    expect(traceSampler).toHaveBeenCalledTimes(1);
    expect(boundary.log).toHaveLength(commandCount);
    expect(document.palette).toEqual(beforePalette);
    expect(uiStore.getState().paletteId).toBe(beforeState.paletteId);
    expect(uiStore.getState().tool).toEqual(beforeState.tool);
    controller.dispose();
  });

  it('uses the supplied primary catalog definition for Brand B trace samples', () => {
    const rgb = { r: 12, g: 34, b: 56 };
    const association = { catalogId: 'brand-b-primary-v1', brandLabel: 'Brand B', colorCount: 1 };
    const matched: CatalogRecord = {
      sourceId: 'brand-b:primary:scarlet',
      code: 'BB-01',
      name: 'Brand B Scarlet',
      hex: '#D42335',
      rgb: [212, 35, 53]
    };
    const nearest = vi.fn(() => matched);
    const suppliedDefinition: CatalogDefinition = {
      ...DEFAULT_CATALOG_DEFINITION,
      association,
      records: [matched],
      snapshot: { association, records: [matched] },
      nearest
    };
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: association,
      palette: []
    });
    const fixture = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ ...rgb }),
      catalogDefinition: suppliedDefinition
    }, document);
    fixture.controller.setTool({ tool: 'eyedropper' });

    expect(fixture.controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(nearest).toHaveBeenCalledWith(rgb);
    const create = fixture.boundary.log.find((command) => command.type === 'palette-create');
    expect(create).toMatchObject({
      type: 'palette-create',
      name: matched.name,
      color: matched.hex,
      catalog: { catalogId: association.catalogId, sourceId: matched.sourceId }
    });
    const created = fixture.gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.sourceId === matched.sourceId);
    expect(created?.catalog).toMatchObject({ catalogId: association.catalogId, sourceId: matched.sourceId });
    expect(fixture.uiStore.getState().paletteId).toBe(created?.id);
    fixture.controller.dispose();
  });

  it('samples without mutation when the supplied definition is not the document primary', () => {
    const rgb = { r: 12, g: 34, b: 56 };
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: { catalogId: 'brand-b-primary-v1', brandLabel: 'Brand B', colorCount: 1 },
      palette: []
    });
    const traceSampler = vi.fn(() => ({ ...rgb }));
    const fixture = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler,
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    }, document);
    fixture.controller.setTool({ tool: 'eyedropper' });
    const beforeState = fixture.uiStore.getState();
    const commandCount = fixture.boundary.log.length;

    expect(fixture.controller.handlePointerDown(pointer(1, 8, 8))).toBe(false);
    expect(traceSampler).toHaveBeenCalledTimes(1);
    expect(fixture.boundary.log).toHaveLength(commandCount);
    expect(fixture.gateway.getSnapshot().document?.palette).toEqual([]);
    expect(fixture.uiStore.getState().paletteId).toBe(beforeState.paletteId);
    expect(fixture.uiStore.getState().tool).toEqual(beforeState.tool);
    fixture.controller.dispose();
  });

  it('creates a catalog reference instead of selecting custom or cross-catalog same-code entries', () => {
    const rgb = { r: 12, g: 34, b: 56 };
    const matched = DEFAULT_CATALOG_DEFINITION.nearest(rgb)!;
    const cases = [
      {
        name: 'catalog-less custom entry',
        catalog: undefined
      },
      {
        name: 'same-code entry with another source ID',
        catalog: {
          catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId,
          sourceId: 'other-source',
          code: matched.code,
          name: matched.name,
          hex: matched.hex,
          rgb: [...matched.rgb] as [number, number, number]
        }
      }
    ] as const;

    for (const testCase of cases) {
      const document = createDocument({
        width: 8,
        height: 8,
        catalog: DEFAULT_CATALOG_DEFINITION.association,
        palette: [{ id: 1, name: matched.name, color: matched.hex, active: true }]
      });
      if (testCase.catalog !== undefined) document.palette[0] = { ...document.palette[0], catalog: testCase.catalog };
      const fixture = controllerFixture({
        traceImage: { source: {}, width: 4, height: 4 },
        traceSampler: () => ({ ...rgb }),
        catalogDefinition: DEFAULT_CATALOG_DEFINITION
      }, document);
      fixture.controller.setTool({ tool: 'eyedropper' });

      expect(fixture.controller.handlePointerDown(pointer(1, 8, 8)), testCase.name).toBe(true);
      const created = fixture.gateway.getSnapshot().document?.palette.find((entry) => entry.id !== 1);
      expect(created, testCase.name).toMatchObject({ catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: matched.sourceId } });
      expect(fixture.uiStore.getState().paletteId, testCase.name).toBe(created?.id);
      fixture.controller.dispose();
    }
  });

  it('matches trace samples against DMC without mistaking a Brand B entry for the same DMC source', () => {
    const rgb = { r: 12, g: 34, b: 56 };
    const matched = DEFAULT_CATALOG_DEFINITION.nearest(rgb)!;
    const fixture = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ ...rgb }),
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    });
    const document = fixture.gateway.getSnapshot().document!;
    document.palette[0] = {
      ...document.palette[0],
      name: matched.name,
      color: matched.hex,
      catalog: {
        catalogId: 'brand-b-v1',
        sourceId: matched.sourceId,
        code: matched.code,
        name: matched.name,
        hex: matched.hex,
        rgb: [...matched.rgb] as [number, number, number]
      }
    };
    fixture.controller.setTool({ tool: 'eyedropper' });

    expect(fixture.controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(fixture.boundary.log).toHaveLength(1);
    expect(fixture.boundary.log[0]).toMatchObject({
      type: 'palette-create',
      catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: matched.sourceId }
    });
    const mixedPalette = fixture.gateway.getSnapshot().document?.palette;
    expect(mixedPalette?.[0].catalog).toMatchObject({ catalogId: 'brand-b-v1', sourceId: matched.sourceId, code: matched.code });
    expect(mixedPalette?.[1].catalog).toMatchObject({ catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: matched.sourceId, code: matched.code });
    expect(fixture.uiStore.getState().paletteId).toBe(2);
    fixture.controller.dispose();
  });

  it('activates the eyedropper at the keyboard cursor and adds the matched color to the palette', () => {
    const points: Array<{ x: number; y: number }> = [];
    const rgb = { r: 201, g: 102, b: 3 };
    const { boundary, gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: (_trace, _document, _viewport, _metrics, point) => {
        points.push(point);
        return { ...rgb };
      },
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    });
    uiStore.setKeyboardCursor({ x: 2, y: 3 });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handleKeyDown({ key: 'Enter' })).toBe(true);
    expect(points).toEqual([{ x: 40, y: 56 }]);
    expect(boundary.log.some((command) => command.type === 'palette-create')).toBe(true);
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === DEFAULT_CATALOG_DEFINITION.nearest(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    controller.dispose();
  });

  it('uses the keyboard cursor for trace sampling and adds the matched color to the palette', () => {
    const rgb = { r: 7, g: 8, b: 9 };
    const traceSampler = vi.fn(() => ({ ...rgb }));
    const { boundary, gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler,
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    });
    uiStore.setKeyboardCursor({ x: 3, y: 4 });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(true);
    expect(traceSampler).toHaveBeenCalledTimes(1);
    expect(boundary.log.some((command) => command.type === 'palette-create')).toBe(true);
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === DEFAULT_CATALOG_DEFINITION.nearest(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: added!.id } });
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    controller.dispose();
  });

  it('eyedroppers a chart cell palette color and activates the paint brush', () => {
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    controller.setTool({ tool: 'eyedropper' });
    const before = boundary.log.length;
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(uiStore.getState().paletteId).toBe(1);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(boundary.log.length).toBe(before);
    controller.dispose();
  });

  it('picks with the last stitch brush: full by default, then half direction and three-quarter', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });

    controller.setTool({ tool: 'paint', brush: { kind: 'half', direction: '\\', paletteId: 1 } });
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(2, 8, 8));
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'half', direction: '\\', paletteId: 1 } });

    controller.setTool({ tool: 'paint', brush: { kind: 'three-quarter', paletteId: 1 } });
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(3, 8, 8));
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'three-quarter', paletteId: 1 } });

    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(4, 8, 8));
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    controller.dispose();
  });

  it('tells the user to select a visible layer instead of picking on a hidden layer', () => {
    const notices: string[] = [];
    const { boundary, uiStore, controller } = controllerFixture({ onNotice: (message) => notices.push(message) });
    boundary.seed(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    boundary.setLayerVisibility(1, false);
    controller.setTool({ tool: 'eyedropper' });
    const before = uiStore.getState();
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(notices).toEqual([HIDDEN_LAYER_PICK_HINT]);
    expect(uiStore.getState().tool).toEqual({ tool: 'eyedropper' });
    expect(uiStore.getState().paletteId).toBe(before.paletteId);

    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.handleKeyDown({ key: 'Enter' });
    expect(notices).toEqual([HIDDEN_LAYER_PICK_HINT, HIDDEN_LAYER_PICK_HINT]);
    expect(uiStore.getState().tool).toEqual({ tool: 'eyedropper' });
    controller.dispose();
  });

  it('does not show the hidden-layer notice when the active layer is visible', () => {
    const notices: string[] = [];
    const { boundary, uiStore, controller } = controllerFixture({ onNotice: (message) => notices.push(message) });
    boundary.seed(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(notices).toEqual([]);
    expect(uiStore.getState().tool.tool).toBe('paint');
    controller.dispose();
  });

  it('pulses the picked chip on every pick, including re-picking the selected color', () => {
    const { gateway, uiStore, controller } = controllerFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    controller.setTool({ tool: 'eyedropper' });
    expect(uiStore.getState().pickPulse).toBeNull();
    controller.handlePointerDown(pointer(1, 8, 8));
    const first = uiStore.getState().pickPulse;
    expect(first).toEqual({ paletteId: 1, seq: 1 });
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(2, 8, 8));
    const second = uiStore.getState().pickPulse;
    expect(second).toEqual({ paletteId: 1, seq: 2 });
    expect(second).not.toBe(first);
    controller.dispose();
  });

  it('pulses the new palette id when a reference pick adds a catalog color', () => {
    const rgb = { r: 18, g: 52, b: 86 };
    const { gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ ...rgb }),
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    });
    controller.setTool({ tool: 'eyedropper' });
    controller.handlePointerDown(pointer(1, 8, 8));
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === DEFAULT_CATALOG_DEFINITION.nearest(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().pickPulse).toEqual({ paletteId: added!.id, seq: 1 });
    controller.dispose();
  });

  it('gives a chart-cell custom color precedence over trace sampling', () => {
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [{ id: 1, name: 'Custom', color: '#123456', active: true }]
    });
    const traceSampler = vi.fn(() => ({ r: 1, g: 2, b: 3 }));
    const { boundary, gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler
    }, document);
    gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    controller.setTool({ tool: 'eyedropper' });

    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(traceSampler).not.toHaveBeenCalled();
    expect(boundary.log.filter((command) => command.type === 'palette-create')).toHaveLength(0);
    expect(uiStore.getState().paletteId).toBe(1);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    controller.dispose();
  });

  it('eyedroppers an empty cell of the reference image and adds the closest DMC color to the palette', () => {
    const rgb = { r: 18, g: 52, b: 86 };
    const traceSampler = vi.fn(() => ({ ...rgb }));
    const { boundary, gateway, uiStore, controller } = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler,
      catalogDefinition: DEFAULT_CATALOG_DEFINITION
    });
    controller.setTool({ tool: 'eyedropper' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(traceSampler).toHaveBeenCalledTimes(1);
    expect(boundary.log.some((command) => command.type === 'palette-create')).toBe(true);
    const added = gateway.getSnapshot().document?.palette.find((entry) => entry.catalog?.code === DEFAULT_CATALOG_DEFINITION.nearest(rgb)!.code);
    expect(added).toBeDefined();
    expect(uiStore.getState().paletteId).toBe(added!.id);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: added!.id } });
    controller.dispose();
  });

  it('processes the final pointer-up sample before its single commit', () => {
    const { boundary, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 72, 8));
    expect(boundary.log).toHaveLength(1);
    expect(boundary.log[0].type).toBe('bulk-cell');
    expect(boundary.log[0]).toMatchObject({ indices: new Uint32Array([0, 1, 2, 3, 4]) });
    controller.dispose();

    const finalSegment = controllerFixture();
    finalSegment.controller.handlePointerDown(pointer(1, 8, 8));
    finalSegment.controller.handlePointerMove(pointer(1, 24, 8));
    finalSegment.controller.handlePointerUp(pointer(1, 72, 8));
    expect(finalSegment.boundary.log).toHaveLength(1);
    expect(finalSegment.boundary.log[0]).toMatchObject({ indices: new Uint32Array([0, 1, 2, 3, 4]) });
    finalSegment.controller.dispose();
  });

  it('uses unclamped paint hit testing and drops paint on cancellation or lost capture', () => {
    const outside = controllerFixture();
    expect(outside.controller.handlePointerDown(pointer(1, -1, -1))).toBe(false);
    outside.controller.handlePointerUp(pointer(1, -1, -1));
    expect(outside.boundary.log).toHaveLength(0);
    outside.controller.handlePointerDown(pointer(2, 56, 8));
    outside.controller.handlePointerMove(pointer(2, 300, 8));
    outside.controller.handlePointerUp(pointer(2, 300, 8));
    expect(outside.boundary.log[0]).toMatchObject({ indices: new Uint32Array([3]) });
    outside.controller.dispose();

    const cancelled = controllerFixture();
    cancelled.controller.handlePointerDown(pointer(1, 8, 8));
    cancelled.controller.handlePointerMove(pointer(1, 40, 8));
    expect(cancelled.uiStore.getState().overlay.pendingCellStates).toHaveLength(3);
    cancelled.controller.handlePointerCancel(pointer(1, 40, 8));
    expect(cancelled.boundary.log).toHaveLength(0);
    expect(cancelled.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    cancelled.controller.handlePointerUp(pointer(1, 40, 8));
    expect(cancelled.boundary.log).toHaveLength(0);

    cancelled.controller.handlePointerDown(pointer(2, 8, 8));
    cancelled.controller.handlePointerMove(pointer(2, 40, 8));
    cancelled.controller.handlePointerLostCapture(pointer(2, 40, 8));
    expect(cancelled.boundary.log).toHaveLength(0);
    expect(cancelled.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    cancelled.controller.dispose();
  });

  it('suspends interpolation across off-chart travel and starts a new origin on re-entry', () => {
    const horizontal = controllerFixture();
    horizontal.controller.handlePointerDown(pointer(1, 24, 40));
    horizontal.controller.handlePointerMove(pointer(1, 40, 40));
    horizontal.controller.handlePointerMove(pointer(1, 220, 40));
    horizontal.controller.handlePointerMove(pointer(1, 88, 40));
    horizontal.controller.handlePointerUp(pointer(1, 88, 40));
    expect(horizontal.boundary.log[0]).toMatchObject({ indices: new Uint32Array([17, 18, 21]) });
    horizontal.controller.dispose();

    const vertical = controllerFixture();
    vertical.controller.handlePointerDown(pointer(1, 8, 8));
    vertical.controller.handlePointerMove(pointer(1, 8, 40));
    vertical.controller.handlePointerMove(pointer(1, 8, -80));
    vertical.controller.handlePointerMove(pointer(1, 8, 88));
    vertical.controller.handlePointerUp(pointer(1, 8, 88));
    expect(vertical.boundary.log[0]).toMatchObject({ indices: new Uint32Array([0, 8, 16, 40]) });
    vertical.controller.dispose();

    const reverse = controllerFixture();
    reverse.controller.handlePointerDown(pointer(1, 104, 104));
    reverse.controller.handlePointerMove(pointer(1, 88, 104));
    reverse.controller.handlePointerMove(pointer(1, -80, 104));
    reverse.controller.handlePointerMove(pointer(1, 40, 104));
    reverse.controller.handlePointerUp(pointer(1, 40, 104));
    expect(reverse.boundary.log[0]).toMatchObject({ indices: new Uint32Array([50, 53, 54]) });
    reverse.controller.dispose();
  });

  it('only extends a full-stitch drag into a cell once the pointer is a quarter of a cell inside it', () => {
    const { boundary, uiStore, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 19, 8));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(1);
    controller.handlePointerMove(pointer(1, 20, 8));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(2);
    controller.handlePointerMove(pointer(1, 24, 19));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(2);
    controller.handlePointerMove(pointer(1, 24, 20));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(3);
    controller.handlePointerMove(pointer(1, 13, 24));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(3);
    controller.handlePointerUp(pointer(1, 13, 24));
    expect(boundary.log).toHaveLength(1);
    expect(boundary.log[0]).toMatchObject({ indices: new Uint32Array([0, 1, 9]) });
    controller.dispose();
  });

  it('draws a diagonal full-stitch drag without filling the cells beside each corner step', () => {
    const straight = controllerFixture();
    straight.controller.handlePointerDown(pointer(1, 8, 8));
    straight.controller.handlePointerMove(pointer(1, 24, 24));
    straight.controller.handlePointerMove(pointer(1, 40, 40));
    straight.controller.handlePointerUp(pointer(1, 40, 40));
    expect(straight.boundary.log[0]).toMatchObject({ indices: new Uint32Array([0, 9, 18]) });
    straight.controller.dispose();

    // A hand-drawn diagonal wobbles across the corner: a shallow graze of the
    // side cell is ignored and the stroke still steps straight to the diagonal.
    const wobbly = controllerFixture();
    wobbly.controller.handlePointerDown(pointer(1, 8, 8));
    wobbly.controller.handlePointerMove(pointer(1, 17, 15));
    wobbly.controller.handlePointerMove(pointer(1, 18, 17));
    wobbly.controller.handlePointerMove(pointer(1, 22, 21));
    wobbly.controller.handlePointerUp(pointer(1, 22, 21));
    expect(wobbly.boundary.log[0]).toMatchObject({ indices: new Uint32Array([0, 9]) });
    wobbly.controller.dispose();
  });

  it('keeps a paint stroke transient and commits one deduplicated bulk command', () => {
    const { boundary, gateway, uiStore, controller, calls } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 72, 8));
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === 0)).toBe(true);
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(5);
    expect(uiStore.getState().overlay.pendingCellStates?.slice(0, 2)).toMatchObject([
      { index: 0, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 1, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerMove(pointer(1, 40, 8));
    controller.handlePointerUp(pointer(1, 40, 8));
    expect(gateway.getSnapshot().document?.kind.slice(0, 5)).toEqual(new Uint8Array([1, 1, 1, 1, 1]));
    expect(calls.setDocument).toHaveLength(2);
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({ layer: 'base', cellRect: { x: 0, y: 0, width: 5, height: 1 } });
    expect(uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(uiStore.getState().status).toBe('Stitched 5 cells');
    expect(boundary.undoDepth).toBe(1);
    gateway.undo({ projectId: 'project-a', revision: 1 });
    expect(gateway.getSnapshot().document?.kind.slice(0, 5)).toEqual(new Uint8Array(5));
    expect(boundary.undoDepth).toBe(0);
    controller.dispose();
  });

  it('reports a layer refusal of a stroke commit instead of throwing', () => {
    const notices: string[] = [];
    const { gateway, uiStore, controller } = controllerFixture({ onNotice: (message) => notices.push(message) });
    vi.spyOn(gateway, 'execute').mockImplementation(() => {
      throw new DomainError('layer-hidden', 'Show the layer to edit it');
    });
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(() => controller.handlePointerUp(pointer(1, 8, 8))).not.toThrow();
    expect(notices).toEqual(['Show the layer to edit it']);
    expect(uiStore.getState().status).toBe('Show the layer to edit it');
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('keeps shape previews transient, replaces preview cells, commits once, and supports one-step undo and redo', () => {
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [
        { id: 1, name: 'Thread', color: '#123456', active: true },
        { id: 2, name: 'Shape thread', color: '#abcdef', active: true }
      ]
    });
    const { boundary, gateway, uiStore, controller, calls } = controllerFixture({}, document);
    uiStore.setPaletteId(2);
    controller.setTool({ tool: 'shape', shape: 'line' });

    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell)).toEqual([{ x: 0, y: 0 }]);
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { index: 0, kind: CellKind.Full, colors: [2, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerMove(pointer(1, 72, 8));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(5);
    expect(gateway.getSnapshot().document?.kind.every((kind) => kind === CellKind.Empty)).toBe(true);
    controller.handlePointerMove(pointer(1, 24, 8));
    expect(uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);

    controller.handlePointerUp(pointer(1, 24, 8));
    expect(boundary.log).toHaveLength(1);
    expect(boundary.log[0]).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([0, 1]),
      edit: { kind: 'full', color: 2 }
    });
    expect(gateway.getSnapshot().document?.kind.slice(0, 2)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full]));
    expect(gateway.getSnapshot().document?.colors[0]).toBe(2);
    expect(boundary.undoDepth).toBe(1);
    expect(uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({
      layer: 'base',
      cellRect: { x: 0, y: 0, width: 2, height: 1 },
      reason: 'editor-command'
    });

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind.slice(0, 2)).toEqual(new Uint8Array([CellKind.Empty, CellKind.Empty]));
    expect(boundary.undoDepth).toBe(0);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind.slice(0, 2)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full]));
    expect(boundary.undoDepth).toBe(1);
    controller.dispose();
  });

  it('uses the active palette as full stitches and applies the current brush size as outline thickness', () => {
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [
        { id: 1, name: 'Thread', color: '#123456', active: true },
        { id: 2, name: 'Shape thread', color: '#abcdef', active: true }
      ]
    });
    const fixture = controllerFixture({}, document);
    fixture.uiStore.setPaletteId(2);
    fixture.uiStore.setState({ brushSize: 2 });
    fixture.controller.setTool({ tool: 'shape', shape: 'line' });
    fixture.controller.handlePointerDown(pointer(1, 40, 40));
    fixture.controller.handlePointerMove(pointer(1, 72, 40));

    const states = fixture.uiStore.getState().overlay.pendingCellStates ?? [];
    expect(states.map((state) => state.index)).toEqual([18, 19, 20, 21, 26, 27, 28, 29]);
    expect(states.every((state) => state.kind === CellKind.Full && state.colors[0] === 2)).toBe(true);
    fixture.controller.handlePointerUp(pointer(1, 72, 40));
    expect(fixture.boundary.log[0]).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([18, 19, 20, 21, 26, 27, 28, 29]),
      edit: { kind: 'full', color: 2 }
    });
    fixture.controller.dispose();
  });

  it('constrains square and circle tools while leaving rectangles freeform', () => {
    const square = controllerFixture();
    square.controller.setTool({ tool: 'shape', shape: 'square' });
    square.controller.handlePointerDown(pointer(1, 24, 24));
    square.controller.handlePointerUp(pointer(1, 56, 40));
    expect(square.boundary.log[0]).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([9, 10, 11, 17, 19, 25, 26, 27])
    });
    square.controller.dispose();

    const circle = controllerFixture();
    circle.controller.setTool({ tool: 'shape', shape: 'circle' });
    circle.controller.handlePointerDown(pointer(1, 24, 24));
    circle.controller.handlePointerUp(pointer(1, 56, 40));
    expect(circle.boundary.log[0]).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([10, 17, 19, 26])
    });
    circle.controller.dispose();

    const rectangle = controllerFixture();
    rectangle.controller.setTool({ tool: 'shape', shape: 'rectangle' });
    rectangle.controller.handlePointerDown(pointer(1, 24, 24));
    rectangle.controller.handlePointerUp(pointer(1, 56, 40));
    expect(rectangle.boundary.log[0]).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([9, 10, 11, 17, 18, 19])
    });
    rectangle.controller.dispose();

    const oval = controllerFixture();
    oval.controller.setTool({ tool: 'shape', shape: 'oval' });
    oval.controller.handlePointerDown(pointer(1, 8, 8));
    oval.controller.handlePointerMove(pointer(1, 104, 72));
    const ovalCells = oval.uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell) ?? [];
    expect({
      minX: Math.min(...ovalCells.map(({ x }) => x)),
      maxX: Math.max(...ovalCells.map(({ x }) => x)),
      minY: Math.min(...ovalCells.map(({ y }) => y)),
      maxY: Math.max(...ovalCells.map(({ y }) => y))
    }).toEqual({ minX: 0, maxX: 6, minY: 0, maxY: 4 });
    expect(ovalCells).not.toContainEqual({ x: 3, y: 2 });
    oval.controller.handlePointerUp(pointer(1, 104, 72));
    oval.controller.dispose();

    const clamped = controllerFixture();
    clamped.controller.setTool({ tool: 'shape', shape: 'line' });
    clamped.controller.handlePointerDown(pointer(2, 104, 104));
    clamped.controller.handlePointerMove(pointer(2, 300, 300));
    expect(clamped.uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell).every(({ x, y }) => x >= 0 && x < 8 && y >= 0 && y < 8)).toBe(true);
    clamped.controller.handlePointerUp(pointer(2, 300, 300));
    expect(clamped.boundary.log[0]).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([54, 63])
    });
    clamped.controller.dispose();
  });

  it('keeps square and circle bounds square and chart-bounded at the bottom edge', () => {
    for (const shape of ['square', 'circle'] as const) {
      const fixture = controllerFixture();
      fixture.controller.setTool({ tool: 'shape', shape });
      fixture.controller.handlePointerDown(pointer(1, 72, 120)); // cell (4, 7)
      fixture.controller.handlePointerMove(pointer(1, 104, 120)); // cell (6, 7); locking would extend below the chart

      const cells = fixture.uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell) ?? [];
      expect(cells.length, `${shape} preview should not be empty`).toBeGreaterThan(0);
      const minX = Math.min(...cells.map(({ x }) => x));
      const maxX = Math.max(...cells.map(({ x }) => x));
      const minY = Math.min(...cells.map(({ y }) => y));
      const maxY = Math.max(...cells.map(({ y }) => y));
      expect({ minX, maxX, minY, maxY }, shape).toEqual({ minX: 4, maxX: 6, minY: 5, maxY: 7 });
      expect(maxX - minX + 1, shape).toBe(maxY - minY + 1);
      expect(cells.every(({ x, y }) => x >= 0 && x < 8 && y >= 0 && y < 8), shape).toBe(true);

      fixture.controller.handlePointerUp(pointer(1, 104, 120));
      const committed = fixture.boundary.log.at(-1);
      expect(committed, shape).toMatchObject({ type: 'bulk-cell' });
      const committedIndices = committed?.type === 'bulk-cell'
        ? Array.from((committed as BulkCellCommand).indices)
        : [];
      expect(committedIndices.every((index) => index >= 0 && index < 64), `${shape} commit should stay on chart`).toBe(true);
      fixture.controller.dispose();
    }
  });

  it('supports touch shapes and clears shape previews on cancel, lost capture, or tool switch', () => {
    const touch = controllerFixture();
    touch.controller.setTool({ tool: 'shape', shape: 'rectangle' });
    touch.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    touch.controller.handlePointerMove(pointer(1, 40, 24, 'touch'));
    expect(touch.uiStore.getState().overlay.pendingCellStates?.length).toBeGreaterThan(1);
    touch.controller.handlePointerUp(pointer(1, 40, 24, 'touch'));
    expect(touch.boundary.log).toHaveLength(1);
    expect(touch.boundary.log[0].type).toBe('bulk-cell');
    touch.controller.dispose();

    const cancelled = controllerFixture();
    cancelled.controller.setTool({ tool: 'shape', shape: 'line' });
    cancelled.controller.handlePointerDown(pointer(2, 8, 8, 'pen'));
    cancelled.controller.handlePointerMove(pointer(2, 40, 8, 'pen'));
    expect(cancelled.controller.handlePointerCancel(pointer(2, 40, 8, 'pen'))).toBe(true);
    expect(cancelled.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(cancelled.boundary.log).toHaveLength(0);

    cancelled.controller.handlePointerDown(pointer(3, 8, 8));
    cancelled.controller.handlePointerMove(pointer(3, 40, 8));
    expect(cancelled.controller.handlePointerLostCapture(pointer(3, 40, 8))).toBe(true);
    expect(cancelled.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(cancelled.boundary.log).toHaveLength(0);

    cancelled.controller.handlePointerDown(pointer(4, 8, 8));
    cancelled.controller.setTool({ tool: 'pan' });
    expect(cancelled.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    cancelled.controller.handlePointerUp(pointer(4, 8, 8));
    expect(cancelled.boundary.log).toHaveLength(0);
    cancelled.controller.dispose();
  });

  it('rejects stale and no-op shape commits and requires an active palette entry', () => {
    const stale = controllerFixture();
    stale.controller.setTool({ tool: 'shape', shape: 'rectangle' });
    stale.controller.handlePointerDown(pointer(1, 8, 8));
    stale.controller.handlePointerMove(pointer(1, 40, 40));
    stale.gateway.execute({ type: 'bulk-cell', indices: new Uint32Array([63]), edit: { kind: 'full', color: 1 } });
    expect(stale.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(stale.uiStore.getState().status).toBe('Stroke cancelled: project changed');
    stale.controller.handlePointerUp(pointer(1, 40, 40));
    expect(stale.boundary.log.filter((command) => command.type === 'bulk-cell')).toHaveLength(1);
    stale.controller.dispose();

    const noop = controllerFixture();
    noop.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    noop.controller.setTool({ tool: 'shape', shape: 'line' });
    const commandCount = noop.boundary.log.length;
    const undoDepth = noop.boundary.undoDepth;
    noop.controller.handlePointerDown(pointer(1, 8, 8));
    noop.controller.handlePointerUp(pointer(1, 8, 8));
    expect(noop.boundary.log).toHaveLength(commandCount);
    expect(noop.boundary.undoDepth).toBe(undoDepth);
    expect(noop.uiStore.getState().status).toBe('No change');
    noop.controller.dispose();

    const noPaletteDocument = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [{ id: 1, name: 'Inactive thread', color: '#123456', active: false }]
    });
    const noPalette = controllerFixture({}, noPaletteDocument);
    noPalette.uiStore.setPaletteId(null);
    noPalette.controller.setTool({ tool: 'shape', shape: 'line' });
    expect(noPalette.controller.handlePointerDown(pointer(1, 8, 8))).toBe(false);
    expect(noPalette.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(noPalette.boundary.log).toHaveLength(0);
    noPalette.controller.dispose();
  });

  it('uses bounded invalidation when undoing and redoing paint', () => {
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [
        { id: 1, name: 'Thread', color: '#123456' },
        { id: 2, name: 'Unused active thread', color: '#abcdef', active: true }
      ]
    });
    const { gateway, controller, calls } = controllerFixture({}, document);
    controller.setBrush({ kind: 'full', paletteId: 2 });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 8, 8));

    expect(gateway.getSnapshot().document?.colors[0]).toBe(2);
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({
      layer: 'base',
      cellRect: { x: 0, y: 0, width: 1, height: 1 },
      reason: 'editor-command'
    });

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    controller.handleKeyDown({ key: 'z', ctrlKey: true, shiftKey: true, preventDefault: () => undefined });

    expect(gateway.getSnapshot().document?.colors[0]).toBe(2);
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({
      layer: 'base',
      cellRect: { x: 0, y: 0, width: 1, height: 1 },
      reason: 'editor-command'
    });
    expect(calls.setDocument.at(-1)?.invalidation?.full).toBeUndefined();
    controller.dispose();
  });

  it('stamps the brush half-stitch diagonal whichever corner is hit', () => {
    const corners = [[4, 4], [12, 4], [12, 12], [4, 12]] as const;
    const cases = [
      { direction: '/', kind: CellKind.HalfSlash },
      { direction: '\\', kind: CellKind.HalfBackslash },
      { direction: undefined, kind: CellKind.HalfSlash }
    ] as const;
    let pointerId = 0;
    for (const testCase of cases) {
      for (const [x, y] of corners) {
        pointerId += 1;
        const fixture = controllerFixture();
        fixture.controller.setBrush({
          kind: 'half',
          ...(testCase.direction === undefined ? {} : { direction: testCase.direction }),
          paletteId: 1
        });
        fixture.controller.handlePointerDown(pointer(pointerId, x, y));
        expect(fixture.uiStore.getState().overlay.pendingCellStates).toMatchObject([{ kind: testCase.kind, colors: [1, 0, 0, 0] }]);
        fixture.controller.handlePointerUp(pointer(pointerId, x, y));
        expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(testCase.kind);
        fixture.controller.dispose();
      }
    }
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

  it('edits with a single touch by default and can restore movement-only touch input', () => {
    const editing = controllerFixture();
    editing.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    editing.controller.handlePointerMove(pointer(1, 40, 8, 'touch'));
    editing.controller.handlePointerUp(pointer(1, 40, 8, 'touch'));
    expect(editing.boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 2]) });
    expect(editing.gateway.getSnapshot().document?.kind.slice(0, 3)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full, CellKind.Full]));
    editing.controller.dispose();

    const movementOnly = controllerFixture();
    const before = movementOnly.uiStore.getState().viewport;
    movementOnly.controller.setTouchMovementOnly(true);
    movementOnly.controller.handlePointerDown(pointer(1, 24, 24, 'touch'));
    movementOnly.controller.handlePointerMove(pointer(1, 4, 24, 'touch'));
    movementOnly.controller.handlePointerUp(pointer(1, 4, 24, 'touch'));
    expect(movementOnly.boundary.log).toHaveLength(0);
    expect(movementOnly.uiStore.getState().viewport).not.toEqual(before);
    movementOnly.controller.dispose();
  });

  it('defers touch Fill and Eyedropper actions until a multi-touch sequence is ruled out', () => {
    const fill = controllerFixture();
    fill.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    fill.controller.setTool({ tool: 'fill' });
    fill.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    expect(fill.uiStore.getState().overlay.fillPending).toBeUndefined();
    fill.controller.handlePointerDown(pointer(2, 60, 8, 'touch'));
    fill.controller.handlePointerUp(pointer(2, 60, 8, 'touch'));
    fill.controller.handlePointerUp(pointer(1, 8, 8, 'touch'));
    expect(fill.uiStore.getState().overlay.fillPending).toBeUndefined();
    expect(fill.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(fill.boundary.undoDepth).toBe(0);
    fill.controller.dispose();

    const eyedropper = controllerFixture({
      traceImage: { source: {}, width: 4, height: 4 },
      traceSampler: () => ({ r: 201, g: 102, b: 3 })
    });
    eyedropper.gateway.execute(cell(8, { type: 'set-full', x: 2, y: 2, color: 1 }));
    eyedropper.controller.setTool({ tool: 'eyedropper' });
    eyedropper.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    expect(eyedropper.uiStore.getState().tool).toEqual({ tool: 'eyedropper' });
    eyedropper.controller.handlePointerDown(pointer(2, 60, 8, 'touch'));
    eyedropper.controller.handlePointerDown(pointer(3, 60, 60, 'touch'));
    eyedropper.controller.handlePointerUp(pointer(3, 60, 60, 'touch'));
    eyedropper.controller.handlePointerUp(pointer(2, 60, 8, 'touch'));
    eyedropper.controller.handlePointerUp(pointer(1, 8, 8, 'touch'));
    expect(eyedropper.uiStore.getState().tool).toEqual({ tool: 'eyedropper' });
    expect(eyedropper.gateway.getSnapshot().document?.kind[2 * 8 + 2]).toBe(CellKind.Full);
    expect(eyedropper.boundary.undoDepth).toBe(1);
    expect(eyedropper.boundary.log.filter((command) => command.type === 'palette-create')).toHaveLength(0);
    eyedropper.controller.dispose();
  });

  it('restores or clears a touch selection when the gesture is superseded or cancelled', () => {
    const superseded = controllerFixture();
    superseded.controller.setSelection({ x: 4, y: 4 });
    superseded.controller.setTool({ tool: 'select' });
    superseded.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    expect(superseded.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    superseded.controller.handlePointerDown(pointer(2, 60, 8, 'touch'));
    expect(superseded.controller.getSelection()).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    superseded.controller.handlePointerUp(pointer(2, 60, 8, 'touch'));
    superseded.controller.handlePointerUp(pointer(1, 8, 8, 'touch'));
    superseded.controller.dispose();

    const cancelled = controllerFixture();
    cancelled.controller.setSelection({ x: 3, y: 3 });
    cancelled.controller.setTool({ tool: 'select' });
    cancelled.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    cancelled.controller.handlePointerCancel(pointer(1, 8, 8, 'touch'));
    expect(cancelled.controller.getSelection()).toEqual({ x: 3, y: 3, width: 1, height: 1 });
    cancelled.controller.dispose();

    const cleared = controllerFixture();
    cleared.controller.setTool({ tool: 'select' });
    cleared.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
    cleared.controller.handlePointerLostCapture(pointer(1, 8, 8, 'touch'));
    expect(cleared.controller.getSelection()).toBeUndefined();
    cleared.controller.dispose();
  });

  it('recognizes stationary two-finger undo and three-finger redo taps after all fingers lift', () => {
    const undo = controllerFixture();
    undo.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    expect(undo.boundary.undoDepth).toBe(1);
    undo.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    undo.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    undo.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
    expect(undo.boundary.undoDepth).toBe(1);
    undo.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    expect(undo.boundary.undoDepth).toBe(0);
    expect(undo.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    undo.controller.dispose();

    const redo = controllerFixture();
    redo.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    redo.gateway.undo({ projectId: 'project-a', revision: 1 });
    redo.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    redo.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    redo.controller.handlePointerDown(pointer(3, 40, 60, 'touch'));
    redo.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
    redo.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    expect(redo.boundary.undoDepth).toBe(0);
    redo.controller.handlePointerUp(pointer(3, 40, 60, 'touch'));
    expect(redo.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(redo.boundary.undoDepth).toBe(1);
    redo.controller.dispose();
  });

  it('ignores post-pointerup lost capture while preserving a two-finger undo candidate', () => {
    const fixture = controllerFixture();
    fixture.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    fixture.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    fixture.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    fixture.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    fixture.controller.handlePointerLostCapture(pointer(1, 20, 20, 'touch'));
    fixture.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
    expect(fixture.boundary.undoDepth).toBe(0);
    expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    fixture.controller.dispose();
  });

  it('does not roll a history candidate onto newly contacted pointer IDs', () => {
    const twoThenThree = controllerFixture();
    twoThenThree.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    twoThenThree.gateway.undo({ projectId: 'project-a', revision: 1 });
    expect(twoThenThree.boundary.undoDepth).toBe(0);
    twoThenThree.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    twoThenThree.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    twoThenThree.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    twoThenThree.controller.handlePointerDown(pointer(3, 40, 60, 'touch'));
    twoThenThree.controller.handlePointerUp(pointer(3, 40, 60, 'touch'));
    twoThenThree.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
    expect(twoThenThree.boundary.undoDepth).toBe(0);
    expect(twoThenThree.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    twoThenThree.gateway.redo({ projectId: 'project-a', revision: 2 });
    expect(twoThenThree.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    twoThenThree.controller.dispose();

    const threeThenFour = controllerFixture();
    threeThenFour.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    threeThenFour.gateway.undo({ projectId: 'project-a', revision: 1 });
    threeThenFour.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    threeThenFour.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    threeThenFour.controller.handlePointerDown(pointer(3, 40, 60, 'touch'));
    threeThenFour.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    threeThenFour.controller.handlePointerDown(pointer(4, 80, 60, 'touch'));
    threeThenFour.controller.handlePointerUp(pointer(4, 80, 60, 'touch'));
    threeThenFour.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
    threeThenFour.controller.handlePointerUp(pointer(3, 40, 60, 'touch'));
    expect(threeThenFour.boundary.undoDepth).toBe(0);
    expect(threeThenFour.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    threeThenFour.controller.dispose();
  });

  it('rejects non-tap touch sequences and suppresses only stationary jitter', () => {
    const single = controllerFixture();
    single.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    single.controller.setTouchMovementOnly(true);
    single.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    single.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    expect(single.boundary.undoDepth).toBe(1);
    single.controller.dispose();

    const four = controllerFixture();
    four.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    for (const [id, x, y] of [[1, 20, 20], [2, 60, 20], [3, 40, 60], [4, 80, 60]] as const) four.controller.handlePointerDown(pointer(id, x, y, 'touch'));
    for (const id of [4, 2, 1, 3]) four.controller.handlePointerUp(pointer(id, 20, 20, 'touch'));
    expect(four.boundary.undoDepth).toBe(1);
    four.controller.dispose();

    const jitter = controllerFixture();
    jitter.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    const before = jitter.uiStore.getState().viewport;
    jitter.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    jitter.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    jitter.controller.handlePointerMove(pointer(1, 25, 25, 'touch'));
    jitter.controller.handlePointerMove(pointer(2, 55, 25, 'touch'));
    jitter.controller.handlePointerUp(pointer(1, 25, 25, 'touch'));
    jitter.controller.handlePointerUp(pointer(2, 55, 25, 'touch'));
    expect(jitter.uiStore.getState().viewport).toEqual(before);
    expect(jitter.boundary.undoDepth).toBe(0);
    jitter.controller.dispose();

    const moved = controllerFixture();
    moved.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    const beforePinch = moved.uiStore.getState().viewport;
    moved.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    moved.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    moved.controller.handlePointerMove(pointer(2, 100, 20, 'touch'));
    moved.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    moved.controller.handlePointerUp(pointer(2, 100, 20, 'touch'));
    expect(moved.uiStore.getState().viewport).not.toEqual(beforePinch);
    expect(moved.boundary.undoDepth).toBe(1);
    moved.controller.dispose();

    const duration = controllerFixture();
    duration.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    duration.controller.handlePointerDown(pointer(1, 20, 20, 'touch', 0, { timeStamp: 0 }));
    duration.controller.handlePointerDown(pointer(2, 60, 20, 'touch', 0, { timeStamp: 0 }));
    duration.controller.handlePointerUp(pointer(2, 60, 20, 'touch', 0, { timeStamp: 351 }));
    duration.controller.handlePointerUp(pointer(1, 20, 20, 'touch', 0, { timeStamp: 351 }));
    expect(duration.boundary.undoDepth).toBe(1);
    duration.controller.dispose();
  });

  it('clears multi-touch history candidates on cancellation, capture loss, blur, resets, and stale documents', () => {
    const exercise = (teardown: (fixture: ReturnType<typeof controllerFixture>) => void): void => {
      const fixture = controllerFixture();
      fixture.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
      fixture.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
      fixture.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
      teardown(fixture);
      fixture.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
      fixture.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
      expect(fixture.boundary.undoDepth).toBe(1);
      fixture.controller.dispose();
    };
    exercise((fixture) => fixture.controller.handlePointerCancel(pointer(1, 20, 20, 'touch')));
    exercise((fixture) => fixture.controller.handlePointerLostCapture(pointer(1, 20, 20, 'touch')));
    exercise((fixture) => fixture.controller.handleBlur());
    exercise((fixture) => fixture.controller.setMetrics(getCanvasMetrics(96, 96)));

    const stale = controllerFixture();
    stale.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    stale.controller.handlePointerDown(pointer(1, 20, 20, 'touch'));
    stale.controller.handlePointerDown(pointer(2, 60, 20, 'touch'));
    stale.gateway.execute(cell(8, { type: 'set-full', x: 1, y: 0, color: 1 }));
    stale.controller.handlePointerUp(pointer(1, 20, 20, 'touch'));
    stale.controller.handlePointerUp(pointer(2, 60, 20, 'touch'));
    expect(stale.boundary.undoDepth).toBe(2);
    stale.controller.dispose();
  });

  it('does not recognize history taps in move-image or resize-image tools', () => {
    const trace = { source: {}, width: 4, height: 4, chartBounds: { x: 0, y: 0, width: 8, height: 8 } };
    for (const tool of ['move-image', 'resize-image'] as const) {
      const fixture = controllerFixture({ traceImage: trace });
      fixture.gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
      fixture.controller.setTool({ tool });
      fixture.controller.handlePointerDown(pointer(1, 8, 8, 'touch'));
      fixture.controller.handlePointerDown(pointer(2, 8, 8, 'touch'));
      fixture.controller.handlePointerUp(pointer(1, 8, 8, 'touch'));
      fixture.controller.handlePointerUp(pointer(2, 8, 8, 'touch'));
      expect(fixture.boundary.undoDepth).toBe(1);
      fixture.controller.dispose();
    }
  });

  it('reserves Space for temporary pan and clears the modifier on stop and text targets', () => {
    const first = controllerFixture();
    first.controller.handleKeyDown({ key: 'Space', preventDefault: () => undefined });
    expect(first.boundary.log).toHaveLength(0);
    first.controller.handleKeyUp({ key: 'Space' });
    first.controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(first.boundary.log).toHaveLength(1);
    first.controller.stop();
    first.controller.handlePointerDown(pointer(2, 8, 8));
    first.controller.handlePointerMove(pointer(2, 24, 8));
    first.controller.handlePointerUp(pointer(2, 24, 8));
    expect(first.boundary.log).toHaveLength(2);
    expect(first.controller.handleKeyDown({ key: 'Space', target: { tagName: 'INPUT' } })).toBe(false);
    expect(first.controller.handleKeyUp({ key: 'Space', target: { tagName: 'INPUT' } })).toBe(false);
    first.controller.dispose();
  });

  it('rebases an explicit pinch pair when one active pointer lifts and ignores extras', () => {
    const { boundary, controller, uiStore } = controllerFixture();
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
    expect(boundary.log).toHaveLength(0);
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
    expect(uiStore.getState().status).toBe('Stitched cell (1, 0)');
    gateway.execute(cell(8, { type: 'set-full', x: 1, y: 0, color: 1 }));
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
    expect(viewport.zoom).toBe((128 - 2 * CHART_EDGE_MARGIN) / Math.max(document.width, document.height));
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
    controller.setBrush(brush);
    uiStore.setState({ brushSize: 4 });
    uiStore.setKeyboardCursor({ x: 2, y: 3 });
    const next = createDocument({ width: 12, height: 6, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
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

  it('skips React document sync when the renderer already owns that document generation', () => {
    const { gateway, controller, calls, uiStore } = controllerFixture();
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 8, 8));

    const callsAfterCompletion = calls.setDocument.length;
    const completedDocument = gateway.getSnapshot().document!;
    expect(uiStore.getState().selectedCell?.geometry).toBe('full');
    expect(calls.setDocument.at(-1)?.invalidation).toMatchObject({
      layer: 'base',
      cellRect: { x: 0, y: 0, width: 1, height: 1 },
      reason: 'editor-command'
    });

    controller.setDocument(completedDocument, {
      layer: 'all',
      full: true,
      reason: 'external-document'
    });

    expect(calls.setDocument).toHaveLength(callsAfterCompletion);
    expect(uiStore.getState().selectedCell?.geometry).toBe('full');

    const externalDocument = createDocument({
      width: 4,
      height: 4,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [{ id: 1, name: 'Thread', color: '#123456' }]
    });
    externalDocument.revision = completedDocument.revision + 1;
    controller.setDocument(externalDocument, {
      layer: 'all',
      full: true,
      reason: 'external-document'
    });
    expect(calls.setDocument).toHaveLength(callsAfterCompletion + 1);
    expect(calls.setDocument.at(-1)?.document).toBe(externalDocument);
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
    const { boundary, uiStore, controller, calls } = controllerFixture();
    expect(uiStore.getState().gridVisible).toBe(true);
    expect(calls.setStyle[0]).toMatchObject({ showGrid: true });
    uiStore.setGridVisible(false);
    expect(uiStore.getState().gridVisible).toBe(false);
    expect(calls.setStyle.at(-1)).toEqual({ showGrid: false });
    uiStore.setGridVisible(true);
    expect(uiStore.getState().gridVisible).toBe(true);
    expect(calls.setStyle.at(-1)).toEqual({ showGrid: true });
    expect(boundary.undoDepth).toBe(0);
    controller.dispose();
  });

  it('suppresses the grid in thread view and leaves it when a chart mode is chosen', () => {
    const { boundary, uiStore, controller, calls } = controllerFixture();
    expect(uiStore.getState().threadView).toBe(false);
    expect(calls.setStyle[0]).toMatchObject({ threadView: false, showGrid: true });
    controller.setThreadView(true);
    expect(calls.setStyle.at(-1)).toEqual({ threadView: true, showGrid: false });
    uiStore.setGridVisible(false);
    uiStore.setGridVisible(true);
    expect(calls.setStyle.at(-1)).toEqual({ showGrid: false });
    controller.setChartMode('symbol');
    expect(uiStore.getState().threadView).toBe(false);
    expect(calls.setStyle.at(-1)).toEqual({ threadView: false, showGrid: true });
    expect(boundary.undoDepth).toBe(0);
    controller.dispose();
  });

  it('deletes a selection on the selected layer as one undo step, clearing its completion', () => {
    let document = threadDocument();
    document = applyCommand(document, cell(8, { type: 'set-full', x: 1, y: 1, color: 1 })).document;
    document = markCellComplete(document, 1, 1);
    for (const command of [
      cell(8, { type: 'set-full', x: 2, y: 2, color: 1 }),
      { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 8 }, color: 1 }
    ] as const) document = applyCommand(document, command).document;
    const { boundary, gateway, uiStore, controller } = controllerFixture({}, document);
    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });

    expect(controller.handleKeyDown({ key: 'Delete', preventDefault: () => undefined })).toBe(true);
    expect(boundary.log.at(-1)).toMatchObject({ type: 'delete-region', x: 1, y: 1, width: 2, height: 2, layerId: STITCH_LAYER_ID });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[18]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.completed[9]).toBe(0);
    // The specialty layer is not selected, so its backstitch stays.
    expect(gateway.getSnapshot().document?.backstitches.ids).toHaveLength(1);
    expect(controller.getSelection()).toBeUndefined();
    expect(boundary.undoDepth).toBe(1);

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.completed[9]).toBe(1);
    expect(uiStore.getState().status).toBe('Undid action');
    controller.handleKeyDown({ key: 'z', ctrlKey: true, shiftKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    expect(uiStore.getState().status).toBe('Redid action');
    controller.dispose();
  });

  it('rejects non-finite pointer, wheel, selection, and keyboard coordinates without touching cell zero', () => {
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    const invalid = (screenX: number, screenY: number): PointerSample => pointer(1, screenX, screenY);
    expect(controller.handlePointerDown(invalid(Number.NaN, 8))).toBe(false);
    expect(controller.handlePointerDown(invalid(Number.POSITIVE_INFINITY, 8))).toBe(false);
    expect(controller.setSelection({ x: Number.NaN, y: 0 })).toBeUndefined();
    expect(controller.handleWheel({ screenX: 8, screenY: Number.NaN, deltaY: -100 })).toBe(false);
    expect(controller.handlePointerDown(pointer(2, 8, 8))).toBe(true);
    expect(controller.handlePointerUp(invalid(Number.NaN, 8))).toBe(false);
    expect(boundary.log).toHaveLength(0);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    uiStore.setKeyboardCursor({ x: Number.POSITIVE_INFINITY, y: 0 });
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(true);
    expect(boundary.log).toHaveLength(0);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('clips centered circular paint brush stamps at chart edges and previews exact after-states', () => {
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    expect(uiStore.getState().brushSize).toBe(1);
    uiStore.setState({ brushSize: 3 });
    expect(uiStore.getState().brushSize).toBe(3);
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.pendingCellStates?.map((state) => state.cell)).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }
    ]);
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { index: 0, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 1, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 8, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 },
      { index: 9, kind: CellKind.Full, colors: [1, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerUp(pointer(1, 8, 8));
    expect(boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 8, 9]) });
    expect(gateway.getSnapshot().document?.kind.slice(0, 2)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full]));
    expect(gateway.getSnapshot().document?.kind.slice(8, 10)).toEqual(new Uint8Array([CellKind.Full, CellKind.Full]));
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.dispose();
  });

  it('retains independent sizes only for paint brushes and erasing', () => {
    const { uiStore, controller } = controllerFixture();
    expect(uiStore.getState().toolBrushSizes).toEqual({
      full: 1,
      half: 1,
      'three-quarter': 1,
      eraser: 1,
      'canvas-brush': 1
    });

    controller.setToolBrushSize('half', 3);
    controller.setToolBrushSize('three-quarter', 4);
    controller.setToolBrushSize('eraser', 6);
    expect(controller.getBrushSize()).toBe(1);

    controller.setToolBrushSize('full', 2);
    expect(controller.getBrushSize()).toBe(2);
    controller.setTool({ tool: 'paint', brush: { kind: 'half', paletteId: 1 } });
    expect(controller.getBrushSize()).toBe(3);
    uiStore.setState({ brushSize: 7 });
    expect(controller.getBrushSize()).toBe(7);
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(controller.getBrushSize()).toBe(2);
    controller.setTool({ tool: 'paint', brush: { kind: 'half', paletteId: 1 } });
    expect(controller.getBrushSize()).toBe(7);
    controller.setTool({ tool: 'paint', brush: { kind: 'three-quarter', paletteId: 1 } });
    expect(controller.getBrushSize()).toBe(4);
    controller.setTool({ tool: 'select' });
    expect(controller.getBrushSize()).toBe(4);
    controller.setTool({ tool: 'eraser' });
    expect(controller.getBrushSize()).toBe(6);
    expect(uiStore.getState().toolBrushSizes).toEqual({
      full: 2,
      half: 7,
      'three-quarter': 4,
      eraser: 6,
      'canvas-brush': 1
    });
    controller.dispose();
  });

  it('keeps each paint brush kind\'s size across tool switches', () => {
    const { uiStore, controller } = controllerFixture();
    controller.setToolBrushSize('full', 2);
    controller.setToolBrushSize('half', 5);
    controller.setTool({ tool: 'paint', brush: { kind: 'half', paletteId: 1 } });
    expect(controller.getBrushSize()).toBe(5);
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(controller.getBrushSize()).toBe(2);
    expect(uiStore.getState().toolBrushSizes).toMatchObject({ full: 2, half: 5 });
    controller.dispose();
  });

  it('uses each retained brush size for tool behavior', () => {
    const paint = controllerFixture();
    paint.controller.setToolBrushSize('full', 2);
    paint.controller.setToolBrushSize('half', 3);
    paint.controller.setToolBrushSize('three-quarter', 4);

    paint.controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    paint.controller.handlePointerDown(pointer(2, 56, 56));
    expect(paint.uiStore.getState().overlay.pendingCellStates).toHaveLength(4);
    paint.controller.handlePointerCancel(pointer(2, 56, 56));

    paint.controller.setTool({ tool: 'paint', brush: { kind: 'half', paletteId: 1 } });
    paint.controller.handlePointerDown(pointer(3, 56, 56));
    expect(paint.uiStore.getState().overlay.pendingCellStates).toHaveLength(9);
    paint.controller.handlePointerCancel(pointer(3, 56, 56));

    paint.controller.setTool({ tool: 'paint', brush: { kind: 'three-quarter', paletteId: 1 } });
    paint.controller.handlePointerDown(pointer(4, 56, 56));
    expect(paint.uiStore.getState().overlay.pendingCellStates).toHaveLength(12);
    paint.controller.handlePointerCancel(pointer(4, 56, 56));
    paint.controller.dispose();

    const occupied = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [{ id: 1, name: 'Thread', color: '#123456', active: true }]
    });
    occupied.kind.fill(CellKind.Full);
    for (let index = 0; index < occupied.kind.length; index += 1) occupied.colors[index * 4] = 1;
    const otherTools = controllerFixture({}, occupied);
    otherTools.controller.setToolBrushSize('eraser', 6);
    otherTools.controller.setTool({ tool: 'eraser' });
    otherTools.controller.handlePointerDown(pointer(5, 56, 56));
    expect(otherTools.uiStore.getState().overlay.pendingCellStates).toHaveLength(32);
    otherTools.controller.dispose();
  });

  it('uses the disk diameter for exact size-one, size-two, size-three, and large stamps', () => {
    const paintIndices = (size: number, x: number, y: number): number[] => {
      const fixture = controllerFixture();
      fixture.uiStore.setState({ brushSize: size });
      fixture.controller.handlePointerDown(pointer(1, x * 16 + 8, y * 16 + 8));
      fixture.controller.handlePointerUp(pointer(1, x * 16 + 8, y * 16 + 8));
      const command = fixture.boundary.log.at(-1);
      fixture.controller.dispose();
      if (command?.type !== 'bulk-cell') return [];
      return Array.from((command as BulkCellCommand).indices);
    };

    expect(paintIndices(1, 3, 3)).toEqual([27]);
    // Even sizes anchor the hit cell at the top-left of the stamp.
    expect(paintIndices(2, 3, 3)).toEqual([27, 28, 35, 36]);
    expect(paintIndices(4, 3, 3)).toEqual([19, 20, 26, 27, 28, 29, 34, 35, 36, 37, 43, 44]);
    expect(paintIndices(3, 3, 3)).toEqual([18, 19, 20, 26, 27, 28, 34, 35, 36]);
    expect(paintIndices(5, 3, 3)).toEqual([
      10, 11, 12,
      17, 18, 19, 20, 21,
      25, 26, 27, 28, 29,
      33, 34, 35, 36, 37,
      42, 43, 44
    ]);
    expect(paintIndices(5, 0, 0)).toEqual([0, 1, 2, 8, 9, 10, 16, 17]);
  });

  it('stamps a size-two brush as a 2x2 square with the hit cell at the top-left', () => {
    const fixture = controllerFixture();
    fixture.uiStore.setState({ brushSize: 2 });
    fixture.controller.handlePointerDown(pointer(1, 3 * 16 + 8, 3 * 16 + 8));
    fixture.controller.handlePointerUp(pointer(1, 3 * 16 + 8, 3 * 16 + 8));
    expect(fixture.boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([27, 28, 35, 36]) });
    fixture.controller.dispose();
  });

  it('publishes no overlay while hovering with paint or eraser', () => {
    const { boundary, uiStore, controller } = controllerFixture();
    uiStore.setState({ brushSize: 2 });
    const before = uiStore.getState().overlay;
    controller.handlePointerMove({ ...pointer(1, 24, 24), buttons: 0 });
    controller.setTool({ tool: 'eraser' });
    controller.handlePointerMove({ ...pointer(1, 40, 24), buttons: 0 });
    expect(uiStore.getState().overlay).toBe(before);
    expect(boundary.log).toHaveLength(0);
    controller.dispose();
  });

  it('deduplicates overlapping multi-cell brush drag stamps and paints half geometry', () => {
    const { boundary, uiStore, controller } = controllerFixture();
    uiStore.setState({ brushSize: 2 });
    controller.handlePointerDown(pointer(1, 24, 24));
    controller.handlePointerMove(pointer(1, 40, 24));
    controller.handlePointerUp(pointer(1, 40, 24));
    expect(boundary.log.at(-1)).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([9, 10, 11, 17, 18, 19])
    });
    expect(boundary.undoDepth).toBe(1);

    controller.setBrush({ kind: 'half', paletteId: 1 });
    uiStore.setState({ brushSize: 2 });
    controller.handlePointerDown(pointer(2, 24, 24));
    expect(uiStore.getState().overlay.pendingCellStates?.map((state) => state.kind)).toEqual([
      CellKind.HalfSlash, CellKind.HalfSlash, CellKind.HalfSlash, CellKind.HalfSlash
    ]);
    controller.handlePointerUp(pointer(2, 24, 24));
    expect(boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', edit: { kind: 'half', direction: '/' } });
    controller.dispose();
  });

  it('previews and commits a three-quarter brush using the pointer-down corner uniformly', () => {
    const cases = [
      { x: 4, y: 4, kind: CellKind.ThreeQuarterNW },
      { x: 12, y: 4, kind: CellKind.ThreeQuarterNE },
      { x: 12, y: 12, kind: CellKind.ThreeQuarterSE },
      { x: 4, y: 12, kind: CellKind.ThreeQuarterSW }
    ] as const;
    for (const [pointerId, testCase] of cases.entries()) {
      const fixture = controllerFixture();
      fixture.controller.setBrush({ kind: 'three-quarter', paletteId: 1 });
      fixture.controller.handlePointerDown(pointer(pointerId + 1, testCase.x, testCase.y));
      expect(fixture.uiStore.getState().overlay.pendingCellStates).toMatchObject([
        { index: 0, kind: testCase.kind, colors: [1, 0, 0, 0], completed: 0 }
      ]);
      fixture.controller.handlePointerUp(pointer(pointerId + 1, testCase.x, testCase.y));
      expect(fixture.boundary.log.at(-1)).toMatchObject({
        type: 'bulk-cell',
        edit: { kind: 'three-quarter' }
      });
      expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(testCase.kind);
      fixture.controller.dispose();
    }

    const dragged = controllerFixture();
    dragged.controller.setBrush({ kind: 'three-quarter', paletteId: 1 });
    dragged.uiStore.setState({ brushSize: 2 });
    dragged.controller.handlePointerDown(pointer(9, 20, 20));
    dragged.controller.handlePointerMove(pointer(9, 36, 20));
    dragged.controller.handlePointerUp(pointer(9, 36, 20));
    expect(dragged.boundary.log.at(-1)).toMatchObject({ edit: { kind: 'three-quarter', corner: 0 } });
    for (const index of [9, 10, 11, 17, 18, 19]) {
      expect(Array.from(dragged.gateway.getSnapshot().document!.colors.slice(index * 4, index * 4 + 4))).toEqual([1, 0, 0, 0]);
      expect(dragged.gateway.getSnapshot().document!.kind[index]).toBe(CellKind.ThreeQuarterNW);
    }
    dragged.controller.dispose();
  });

  it('reports each directional three-quarter as one selected completion slot', () => {
    const document = createDocument({ width: 4, height: 1, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
    const kinds = [
      ['three-quarter-nw', CellKind.ThreeQuarterNW],
      ['three-quarter-ne', CellKind.ThreeQuarterNE],
      ['three-quarter-se', CellKind.ThreeQuarterSE],
      ['three-quarter-sw', CellKind.ThreeQuarterSW]
    ] as const;
    for (const [index, [geometry, kind]] of kinds.entries()) {
      document.kind[index] = kind;
      document.colors[index * 4] = 1;
      document.completed[index] = 1;
      expect(selectedCellSemantics(document, { x: index, y: 0 })).toMatchObject({
        geometry,
        paletteIds: [1],
        completion: { completed: 1, total: 1, summary: '1 of 1 complete' }
      });
      document.kind[index] = CellKind.Empty;
      document.colors[index * 4] = 0;
      document.completed[index] = 0;
    }
  });

  it('previews paired three-quarter replace, opposite add, adjacent no-op, and component erase', () => {
    /** The two-color document with cell 0 holding `kind` in `colors`. */
    const withFirstCell = (kind: number, colors: readonly number[], completed = 0): PatternDocument => {
      const document = createDocument({
        width: 8,
        height: 8,
        catalog: DEFAULT_CATALOG_DEFINITION.association,
        palette: [{ id: 1, name: 'Thread', color: '#123456' }, { id: 2, name: 'Blue', color: '#00f' }]
      });
      document.kind[0] = kind;
      document.colors.set(colors, 0);
      document.completed[0] = completed;
      return document;
    };
    const replace = controllerFixture({}, withFirstCell(CellKind.ThreeQuarterNW, [1, 0, 0, 0]));
    replace.controller.setBrush({ kind: 'three-quarter', paletteId: 2 });
    replace.controller.handlePointerDown(pointer(1, 4, 4));
    expect(replace.uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { kind: CellKind.ThreeQuarterNW, colors: [2, 0, 0, 0], completed: 0 }
    ]);
    replace.controller.handlePointerCancel(pointer(1, 4, 4));
    replace.controller.dispose();

    const add = controllerFixture({}, withFirstCell(CellKind.ThreeQuarterNW, [1, 0, 0, 0]));
    add.controller.setBrush({ kind: 'three-quarter', paletteId: 1 });
    add.controller.handlePointerDown(pointer(2, 12, 12));
    expect(add.uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { kind: CellKind.ThreeQuarterPair, colors: [1, 0, 1, 0], completed: 0 }
    ]);
    add.controller.handlePointerCancel(pointer(2, 12, 12));
    add.controller.dispose();

    const addSlash = controllerFixture({}, withFirstCell(CellKind.ThreeQuarterNE, [1, 0, 0, 0]));
    addSlash.controller.setBrush({ kind: 'three-quarter', paletteId: 1 });
    addSlash.controller.handlePointerDown(pointer(5, 4, 12));
    expect(addSlash.uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { kind: CellKind.ThreeQuarterPair, colors: [0, 1, 0, 1], completed: 0 }
    ]);
    addSlash.controller.handlePointerCancel(pointer(5, 4, 12));
    addSlash.controller.dispose();

    const adjacent = controllerFixture({}, withFirstCell(CellKind.ThreeQuarterNW, [1, 0, 0, 0]));
    adjacent.controller.setBrush({ kind: 'three-quarter', paletteId: 1 });
    adjacent.controller.handlePointerDown(pointer(3, 12, 4));
    expect(adjacent.uiStore.getState().overlay.pendingCellStates).toEqual([]);
    adjacent.controller.handlePointerCancel(pointer(3, 12, 4));
    adjacent.controller.dispose();

    const erased = controllerFixture({}, withFirstCell(CellKind.ThreeQuarterPair, [1, 0, 2, 0], 5));
    erased.controller.setTool({ tool: 'eraser' });
    erased.controller.handlePointerDown(pointer(4, 4, 4));
    expect(erased.uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { kind: CellKind.ThreeQuarterSE, colors: [2, 0, 0, 0], completed: 1 }
    ]);
    erased.controller.handlePointerCancel(pointer(4, 4, 4));
    erased.controller.dispose();

    const selectedDocument = createDocument({
      width: 1,
      height: 1,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [
        { id: 1, name: 'Red', color: '#f00' },
        { id: 2, name: 'Blue', color: '#00f' }
      ]
    });
    selectedDocument.kind[0] = CellKind.ThreeQuarterPair;
    selectedDocument.colors.set([1, 0, 2, 0]);
    selectedDocument.completed[0] = 5;
    expect(selectedCellSemantics(selectedDocument, { x: 0, y: 0 })).toMatchObject({
      geometry: 'three-quarter-pair',
      paletteIds: [1, 2],
      completion: { completed: 2, total: 2, summary: '2 of 2 complete' }
    });
  });

  it('eyedrops the clicked triangle color from both paired axes', () => {
    const document = createDocument({ width: 8, height: 8, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }, { id: 2, name: 'Blue', color: '#00f' }] });
    document.kind[0] = CellKind.ThreeQuarterPair;
    document.colors.set([1, 0, 2, 0], 0);
    document.kind[1] = CellKind.ThreeQuarterPair;
    document.colors.set([0, 2, 0, 1], 4);
    const fixture = controllerFixture({}, document);
    fixture.controller.setTool({ tool: 'eyedropper' });
    fixture.controller.handlePointerDown(pointer(1, 4, 4));
    expect(fixture.uiStore.getState().paletteId).toBe(1);
    fixture.controller.setTool({ tool: 'eyedropper' });
    fixture.controller.handlePointerDown(pointer(2, 12, 12));
    expect(fixture.uiStore.getState().paletteId).toBe(2);
    fixture.controller.setTool({ tool: 'eyedropper' });
    fixture.controller.handlePointerDown(pointer(3, 28, 4));
    expect(fixture.uiStore.getState().paletteId).toBe(2);
    fixture.controller.setTool({ tool: 'eyedropper' });
    fixture.controller.handlePointerDown(pointer(4, 20, 12));
    expect(fixture.uiStore.getState().paletteId).toBe(1);
    fixture.controller.dispose();
  });

  it.skipIf(!(() => {
    const probe = createDocument({ width: 1, height: 1, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
    probe.kind[0] = CellKind.ThreeQuarterPair;
    probe.colors.set([1, 0, 1, 0]);
    return collectValidationErrors(probe).length === 0;
  })())('commits paired component erase canonically and restores it through undo/redo', () => {
    const document = createDocument({ width: 8, height: 8, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }, { id: 2, name: 'Blue', color: '#0000ff' }] });
    document.kind[0] = CellKind.ThreeQuarterPair;
    document.colors.set([1, 0, 2, 0], 0);
    document.completed[0] = 5;
    const fixture = controllerFixture({}, document);
    fixture.controller.setTool({ tool: 'eraser' });
    fixture.controller.handlePointerDown(pointer(1, 4, 4));
    fixture.controller.handlePointerUp(pointer(1, 4, 4));
    expect(fixture.boundary.log.at(-1)).toMatchObject({ type: 'mixed-erase' });
    expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.ThreeQuarterSE);
    expect(Array.from(fixture.gateway.getSnapshot().document!.colors.slice(0, 4))).toEqual([2, 0, 0, 0]);
    expect(fixture.gateway.getSnapshot().document?.completed[0]).toBe(1);
    fixture.controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(Array.from(fixture.gateway.getSnapshot().document!.colors.slice(0, 4))).toEqual([1, 0, 2, 0]);
    expect(fixture.gateway.getSnapshot().document?.completed[0]).toBe(5);
    fixture.controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.ThreeQuarterSE);
    fixture.controller.dispose();
  });

  describe('eraser on three-quarter stitches', () => {
    function eraserFixture(setup: (document: PatternDocument) => void) {
      const document = createDocument({ width: 8, height: 8, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }, { id: 2, name: 'Blue', color: '#0000ff' }] });
      setup(document);
      const fixture = controllerFixture({}, document);
      fixture.controller.setTool({ tool: 'eraser' });
      return fixture;
    }
    function tap(fixture: ReturnType<typeof eraserFixture>, x: number, y: number): void {
      fixture.controller.handlePointerDown(pointer(1, x, y));
      fixture.controller.handlePointerUp(pointer(1, x, y));
    }

    it('erases the pair component whose triangle holds the touch, whatever quadrant it is in', () => {
      const cases: Array<{ colors: number[]; x: number; y: number; kind: CellKind; colorsAfter: number[] }> = [
        // NW/SE pair split by u+v=1: NE quadrant inside the NW triangle erases NW.
        { colors: [1, 0, 2, 0], x: 12, y: 4, kind: CellKind.ThreeQuarterSE, colorsAfter: [2, 0, 0, 0] },
        // SW quadrant inside the SE triangle erases SE.
        { colors: [1, 0, 2, 0], x: 6, y: 12, kind: CellKind.ThreeQuarterNW, colorsAfter: [1, 0, 0, 0] },
        // NE/SW pair split by v=u: NW quadrant inside the NE triangle erases NE.
        { colors: [0, 1, 0, 2], x: 7, y: 2, kind: CellKind.ThreeQuarterSW, colorsAfter: [2, 0, 0, 0] },
        // NW quadrant inside the SW triangle erases SW.
        { colors: [0, 1, 0, 2], x: 2, y: 7, kind: CellKind.ThreeQuarterNE, colorsAfter: [1, 0, 0, 0] }
      ];
      for (const entry of cases) {
        const fixture = eraserFixture((document) => {
          document.kind[0] = CellKind.ThreeQuarterPair;
          document.colors.set(entry.colors, 0);
        });
        tap(fixture, entry.x, entry.y);
        const after = fixture.gateway.getSnapshot().document!;
        expect(after.kind[0]).toBe(entry.kind);
        expect(Array.from(after.colors.slice(0, 4))).toEqual(entry.colorsAfter);
        fixture.controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
        const undone = fixture.gateway.getSnapshot().document!;
        expect(undone.kind[0]).toBe(CellKind.ThreeQuarterPair);
        expect(Array.from(undone.colors.slice(0, 4))).toEqual(entry.colors);
        fixture.controller.dispose();
      }
    });

    it('erases a single three-quarter, half or full cell whole wherever it is touched', () => {
      for (const kind of [CellKind.ThreeQuarterNW, CellKind.Full, CellKind.HalfSlash]) {
        const fixture = eraserFixture((document) => {
          document.kind[0] = kind;
          document.colors[0] = 1;
        });
        // The NE quadrant's bare corner: outside a three-quarter NW triangle, still the whole cell.
        tap(fixture, 14, 10);
        expect(fixture.gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
        fixture.controller.dispose();
      }
    });

    it('erases only the side the drag started on and previews the same state', () => {
      const build = (lastKind: CellKind = CellKind.ThreeQuarterNW) => eraserFixture((document) => {
        document.kind[0] = CellKind.ThreeQuarterPair;
        document.colors.set([1, 0, 1, 0], 0);
        document.kind[1] = CellKind.ThreeQuarterPair;
        document.colors.set([1, 0, 1, 0], 4);
        document.kind[2] = CellKind.ThreeQuarterPair;
        document.colors.set([0, 1, 0, 1], 8);
        document.kind[3] = lastKind;
        document.colors[12] = 1;
      });
      {
        const fixture = build();
        // Start in the NW triangle of cell 0 (NE quadrant); later samples sit in SE-ish spots.
        fixture.controller.handlePointerDown(pointer(1, 12, 4));
        fixture.controller.handlePointerMove(pointer(1, 20, 14));
        fixture.controller.handlePointerMove(pointer(1, 36, 14));
        fixture.controller.handlePointerMove(pointer(1, 52, 14));
        expect(fixture.uiStore.getState().overlay.pendingCellStates).toMatchObject([
          { index: 0, kind: CellKind.ThreeQuarterSE },
          { index: 1, kind: CellKind.ThreeQuarterSE },
          { index: 3, kind: CellKind.Empty }
        ]);
        fixture.controller.handlePointerUp(pointer(1, 52, 14));
        const after = fixture.gateway.getSnapshot().document!;
        expect(after.kind[0]).toBe(CellKind.ThreeQuarterSE);
        expect(after.kind[1]).toBe(CellKind.ThreeQuarterSE);
        expect(after.kind[2]).toBe(CellKind.ThreeQuarterPair);
        expect(after.kind[3]).toBe(CellKind.Empty);
        fixture.controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
        const undone = fixture.gateway.getSnapshot().document!;
        expect(undone.kind[0]).toBe(CellKind.ThreeQuarterPair);
        expect(undone.kind[1]).toBe(CellKind.ThreeQuarterPair);
        expect(undone.kind[3]).toBe(CellKind.ThreeQuarterNW);
        fixture.controller.dispose();
      }

      // A drag that holds a full cell erases it whole while the pair keeps its other side.
      const mixed = build(CellKind.Full);
      mixed.controller.handlePointerDown(pointer(1, 12, 4));
      mixed.controller.handlePointerMove(pointer(1, 52, 14));
      mixed.controller.handlePointerUp(pointer(1, 52, 14));
      const mixedAfter = mixed.gateway.getSnapshot().document!;
      expect([0, 1, 2, 3].map((index) => mixedAfter.kind[index])).toEqual([CellKind.ThreeQuarterSE, CellKind.ThreeQuarterSE, CellKind.ThreeQuarterPair, CellKind.Empty]);
      mixed.controller.dispose();
    });
  });

  it('erases a clipped multi-cell brush as one command and suppresses no-op stamps', () => {
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    gateway.execute(cell(8, { type: 'set-full', x: 1, y: 1, color: 1 }));
    boundary.log.length = 0;
    controller.setTool({ tool: 'eraser' });
    uiStore.setState({ brushSize: 2 });
    controller.handlePointerDown(pointer(1, 24, 24));
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([
      { index: 9, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }
    ]);
    controller.handlePointerUp(pointer(1, 24, 24));
    expect(boundary.log.at(-1)).toMatchObject({ type: 'mixed-erase', wholeCellIndices: new Uint32Array([9, 10, 17, 18]) });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);

    boundary.log.length = 0;
    gateway.execute(cell(8, { type: 'set-full', x: 3, y: 3, color: 1 }));
    boundary.log.length = 0;
    uiStore.setState({ brushSize: 1 });
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    const revisionBeforeNoop = gateway.getSnapshot().revision;
    controller.handlePointerDown(pointer(2, 56, 56));
    controller.handlePointerUp(pointer(2, 56, 56));
    expect(boundary.log).toHaveLength(0);
    expect(gateway.getSnapshot().document?.revision).toBe(revisionBeforeNoop);
    controller.dispose();
  });

  it('exposes and validates the bounded brush-size setting', () => {
    const { uiStore, controller } = controllerFixture();
    uiStore.setState({ brushSize: 10 });
    expect(controller.getBrushSize()).toBe(10);
    expect(() => uiStore.setState({ brushSize: 0 })).toThrow(RangeError);
    expect(() => uiStore.setState({ brushSize: 11 })).toThrow(RangeError);
    expect(() => uiStore.setState({ brushSize: 1.5 })).toThrow(RangeError);
    expect(() => uiStore.setState({ brushSize: Number.NaN })).toThrow(RangeError);
    expect(() => uiStore.setState({ brushSize: -1 })).toThrow(RangeError);
    expect(() => controller.setToolBrushSize('full', 0)).toThrow(RangeError);
    controller.dispose();
  });

  it('keeps Fill independent from the active paint brush', () => {
    const { uiStore, controller } = controllerFixture();
    controller.setTool({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.setTool({ tool: 'fill' });
    expect(uiStore.getState().tool).toEqual({ tool: 'fill' });
    controller.dispose();
  });

  it('selecting a color while painting with a half brush keeps the half kind and new color', () => {
    const { uiStore, controller } = controllerFixture({}, rubySkyDocument());
    controller.setTool({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 1 } });
    controller.selectPalette(2);
    expect(uiStore.getState().paletteId).toBe(2);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'half', direction: '/', paletteId: 2 } });
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

  it('resizes from the southeast corner anchored at the opposite corner, preserving the aspect ratio', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 96));
    // Pointer (7,5) would give a 3x1 freeform rect; the 1:1 start ratio makes
    // the horizontal motion dominant and drives the height to match (3x3).
    controller.handlePointerMove(pointer(1, 112, 64));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 3, height: 3 });
    controller.handlePointerUp(pointer(1, 112, 64));
    expect(callback).toHaveBeenCalledWith({ x: 4, y: 4, width: 3, height: 3 });
    controller.dispose();
  });

  it('resizes from the southeast corner freeform while Ctrl is held', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 96));
    controller.handlePointerMove(pointer(1, 112, 64, 'mouse', 0, { ctrlKey: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 3, height: 1 });
    controller.handlePointerUp(pointer(1, 112, 64, 'mouse', 0, { ctrlKey: true }));
    expect(callback).toHaveBeenCalledWith({ x: 4, y: 4, width: 3, height: 1 });
    controller.dispose();
  });

  it('resizes from the northwest corner shrinking toward the anchor, preserving the aspect ratio', () => {
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

  it('resizes from the northeast corner, preserving the aspect ratio', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 64));
    controller.handlePointerMove(pointer(1, 112, 32));
    // Vertical motion dominates the 1:1 ratio, pulling width to match height.
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 2, width: 4, height: 4 });
    controller.handlePointerUp(pointer(1, 112, 32));
    controller.dispose();
  });

  it('resizes from the northeast corner freeform while Ctrl is held', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 64));
    controller.handlePointerMove(pointer(1, 112, 32, 'mouse', 0, { ctrlKey: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 2, width: 3, height: 4 });
    controller.handlePointerUp(pointer(1, 112, 32, 'mouse', 0, { ctrlKey: true }));
    controller.dispose();
  });

  it('resizes from the southwest corner, preserving the aspect ratio', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 64, 96));
    controller.handlePointerMove(pointer(1, 32, 112));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 2, y: 4, width: 4, height: 4 });
    controller.handlePointerUp(pointer(1, 32, 112));
    controller.dispose();
  });

  it('resizes from the southwest corner freeform while Ctrl is held', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 64, 96));
    controller.handlePointerMove(pointer(1, 32, 112, 'mouse', 0, { ctrlKey: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 2, y: 4, width: 4, height: 3 });
    controller.handlePointerUp(pointer(1, 32, 112, 'mouse', 0, { ctrlKey: true }));
    controller.dispose();
  });

  it('snaps the resized corner to the canvas edge within the screen-pixel tolerance', () => {
    const callback = vi.fn();
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace, onTraceBoundsChange: callback });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 96, 96));
    // 8px / zoom 16 = 0.5 cells; model (7.5, 5) is within 0.5 of the right
    // canvas edge (8) but far from the bottom edge, so only x snaps.
    // Ctrl keeps the resize freeform so the snap is observable.
    controller.handlePointerMove(pointer(1, 120, 80, 'mouse', 0, { ctrlKey: true }));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 4, y: 4, width: 4, height: 1 });
    controller.handlePointerUp(pointer(1, 120, 80, 'mouse', 0, { ctrlKey: true }));
    expect(callback).toHaveBeenCalledWith({ x: 4, y: 4, width: 4, height: 1 });
    controller.dispose();
  });

  it('snaps the dragged corner into the canvas origin when within tolerance', () => {
    const trace = { source: {}, width: 2, height: 2, chartBounds: { x: 4, y: 4, width: 2, height: 2 } };
    const { renderer, controller } = controllerFixture({ traceImage: trace });
    controller.setTool({ tool: 'resize-image' });
    controller.handlePointerDown(pointer(1, 64, 64));
    // Model (0.3, 0.4) snaps to (0, 0), expanding the image to the origin.
    controller.handlePointerMove(pointer(1, 4.8, 6.4));
    expect(renderer.getTraceImage()?.chartBounds).toEqual({ x: 0, y: 0, width: 6, height: 6 });
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
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    uiStore.setState({ brushSize: 3 });
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(true);
    expect(boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 8, 9]) });
    expect(boundary.undoDepth).toBe(1);
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
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    controller.setBrush({ kind: 'half', direction: '/', paletteId: 1 });
    uiStore.setState({ brushSize: 2 });
    uiStore.setKeyboardCursor({ x: 2, y: 2 });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(boundary.log.at(-1)).toMatchObject({
      type: 'bulk-cell',
      indices: new Uint32Array([18, 19, 26, 27]),
      edit: { kind: 'half', direction: '/' }
    });
    for (const index of [18, 19, 26, 27]) expect(gateway.getSnapshot().document?.kind[index]).toBe(CellKind.HalfSlash);
    expect(boundary.undoDepth).toBe(1);
    controller.dispose();
  });

  it('applies keyboard erase stamps, supports undo/redo, suppresses no-ops, and rejects off-chart cursors', () => {
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 0, y: 0, color: 1 }));
    gateway.execute(cell(8, { type: 'set-full', x: 1, y: 1, color: 1 }));
    boundary.log.length = 0;
    controller.setTool({ tool: 'eraser' });
    uiStore.setState({ brushSize: 2 });
    uiStore.setKeyboardCursor({ x: 1, y: 1 });
    const historyBeforeErase = boundary.undoDepth;
    controller.handleKeyDown({ key: 'Backspace', preventDefault: () => undefined });
    expect(boundary.log.at(-1)).toMatchObject({ type: 'bulk-cell', indices: new Uint32Array([9, 10, 17, 18]), edit: { kind: 'erase-cell' } });
    expect(boundary.undoDepth).toBe(historyBeforeErase + 1);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.kind[9]).toBe(CellKind.Full);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });

    boundary.log.length = 0;
    uiStore.setState({ brushSize: 1 });
    controller.setTool({ tool: 'eraser' });
    uiStore.setKeyboardCursor({ x: 0, y: 1 });
    controller.handleKeyDown({ key: 'Backspace', preventDefault: () => undefined });
    expect(boundary.log).toHaveLength(0);
    uiStore.setKeyboardCursor({ x: -1, y: 0 });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    uiStore.setKeyboardCursor({ x: Number.POSITIVE_INFINITY, y: 0 });
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(boundary.log).toHaveLength(0);
    controller.dispose();
  });

  it('keeps off-chart origins in the UI viewport and uses Fit chart as recovery', () => {
    const { boundary, controller, uiStore, calls } = controllerFixture();
    uiStore.setViewport({ x: 100, y: -100, zoom: 16 });
    expect(uiStore.getState().viewport).toEqual({ x: 100, y: -100, zoom: 16 });
    expect(calls.setViewport.at(-1)).toEqual({ x: 100, y: -100, zoom: 16 });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(false);
    expect(boundary.log).toHaveLength(0);
    controller.handleKeyDown({ key: '0', preventDefault: () => undefined });
    expect(uiStore.getState().viewport).toEqual({ x: -CHART_EDGE_MARGIN / 10, y: -CHART_EDGE_MARGIN / 10, zoom: 10 });
    controller.dispose();
  });

  it('resets transient state when the active project changes', () => {
    const { boundary, gateway, uiStore, controller } = controllerFixture();
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.pendingCellStates).toHaveLength(1);
    boundary.open(createDocument({ width: 4, height: 4, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }), 'project-b');
    expect(uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(uiStore.getState().keyboardCursor).toBeNull();
    controller.handlePointerUp(pointer(1, 8, 8));
    expect(gateway.getSnapshot().document?.width).toBe(4);
    controller.dispose();
  });

  it('cancels paint and pinch baselines before applying new canvas metrics', () => {
    const paint = controllerFixture();
    paint.controller.handlePointerDown(pointer(1, 8, 8));
    paint.controller.handlePointerMove(pointer(1, 40, 8));
    expect(paint.uiStore.getState().overlay.pendingCellStates).toHaveLength(3);
    paint.controller.setMetrics(getCanvasMetrics(96, 96, { dpr: 2 }));
    expect(paint.uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(paint.boundary.log).toHaveLength(0);
    paint.controller.handlePointerUp(pointer(1, 40, 8));
    expect(paint.boundary.log).toHaveLength(0);
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
    expect(pinch.boundary.log).toHaveLength(0);
    pinch.controller.dispose();
  });
});

describe('EditorSurfaceController read-only mode', () => {
  it('pans on every drag and never commits a document command', () => {
    const { boundary, uiStore, controller } = controllerFixture({ readOnly: true });
    const markProgress = vi.spyOn(boundary, 'markProgress');
    uiStore.setKeyboardCursor({ x: 1, y: 1 });
    expect(controller.handlePointerDown(pointer(1, 32, 32))).toBe(true);
    controller.handlePointerMove(pointer(1, 48, 40));
    controller.handlePointerUp(pointer(1, 48, 40));
    expect(controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined })).toBe(false);
    expect(controller.handleKeyDown({ key: 'Delete', preventDefault: () => undefined })).toBe(false);
    expect(controller.handleKeyDown({ key: 'c', ctrlKey: true, preventDefault: () => undefined })).toBe(false);
    expect(boundary.log).toHaveLength(0);
    expect(boundary.undoDepth).toBe(0);
    expect(markProgress).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('refuses editing tools but still zooms from the keyboard', () => {
    const { uiStore, controller } = controllerFixture({ readOnly: true });
    expect(controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } })).toBe(false);
    expect(controller.setTool({ tool: 'pan' })).toBe(true);
    const before = uiStore.getState().viewport.zoom;
    expect(controller.handleKeyDown({ key: '+', preventDefault: () => undefined })).toBe(true);
    expect(uiStore.getState().viewport.zoom).toBeGreaterThan(before);
    controller.dispose();
  });

  it('ignores the two-finger undo tap', () => {
    const { boundary, controller } = controllerFixture({ readOnly: true });
    controller.handlePointerDown(pointer(1, 20, 20, 'touch', 0, { timeStamp: 0 }));
    controller.handlePointerDown(pointer(2, 60, 20, 'touch', 0, { timeStamp: 10 }));
    controller.handlePointerUp(pointer(1, 20, 20, 'touch', 0, { timeStamp: 40 }));
    controller.handlePointerUp(pointer(2, 60, 20, 'touch', 0, { timeStamp: 50 }));
    expect(boundary.undoDepth).toBe(0);
    expect(boundary.log).toHaveLength(0);
    controller.dispose();
  });

  it('routes undo and redo keys to the progress history', () => {
    const { boundary, controller } = controllerFixture({ readOnly: true });
    const undoMark = vi.spyOn(boundary, 'undoMark');
    const redoMark = vi.spyOn(boundary, 'redoMark');
    const key = (sample: Partial<KeyboardSample>) => controller.handleKeyDown({ key: 'z', preventDefault: () => undefined, ...sample });
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({ metaKey: true, shiftKey: true })).toBe(true);
    expect(key({ key: 'y', ctrlKey: true })).toBe(true);
    expect(key({ key: 'v', ctrlKey: true })).toBe(false);
    expect(undoMark).toHaveBeenCalledTimes(1);
    expect(redoMark).toHaveBeenCalledTimes(2);
    expect(undoMark.mock.invocationCallOrder[0]).toBeLessThan(redoMark.mock.invocationCallOrder[0]);
    expect(boundary.undoDepth).toBe(0);
    controller.dispose();
  });

  it('accepts only pan and mark', () => {
    const { uiStore, controller } = controllerFixture({ readOnly: true });
    expect(controller.setTool({ tool: 'mark' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'mark' });
    expect(controller.setTool({ tool: 'eraser' })).toBe(false);
    expect(controller.setTool({ tool: 'pan' })).toBe(true);
    controller.dispose();
  });

  it('pushes the highlight color to the renderer and leaves completion to the viewer', () => {
    const { controller, calls } = controllerFixture({ readOnly: true });
    expect(calls.setStyle[0]).toMatchObject({ highlightColor: null });
    expect(calls.setStyle[0]).not.toHaveProperty('showCompletion');
    controller.setHighlightColor(2);
    expect(calls.setStyle.at(-1)).toEqual({ highlightColor: 2 });
    controller.setHighlightColor(null);
    expect(calls.setStyle.at(-1)).toEqual({ highlightColor: null });
    controller.dispose();
  });
});

describe('EditorSurfaceController mark tool', () => {
  function markFixture() {
    const document = createDocument({
      width: 8,
      height: 8,
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      palette: [{ id: 1, name: 'One', color: '#123456' }, { id: 2, name: 'Two', color: '#654321' }]
    });
    const fixture = controllerFixture({ readOnly: true }, document);
    fixture.uiStore.setViewport({ x: 0, y: 0, zoom: 16 });
    expect(fixture.controller.setTool({ tool: 'mark' })).toBe(true);
    const markProgress = vi.spyOn(fixture.boundary, 'markProgress');
    /** The marks the controller sent, in order. */
    const marks = (): ProgressCommand[] => markProgress.mock.calls.map(([command]) => command);
    return { ...fixture, markProgress, marks };
  }

  /** The screen point at a model position for the fixture's 16px-per-cell viewport. */
  const at = (x: number, y: number) => ({ x: x * 16, y: y * 16 });

  function drag(controller: EditorSurfaceController, points: ReadonlyArray<{ x: number; y: number }>, pointerType = 'mouse') {
    const [first, ...rest] = points;
    controller.handlePointerDown(pointer(1, first.x, first.y, pointerType));
    for (const point of rest) controller.handlePointerMove(pointer(1, point.x, point.y, pointerType));
    const last = points[points.length - 1];
    controller.handlePointerUp(pointer(1, last.x, last.y, pointerType));
  }

  it('toggles the one component under a tap', () => {
    const { gateway, controller, marks } = markFixture();
    gateway.execute(cell(8, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.NW, color: 1 }));
    gateway.execute(cell(8, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.NE, color: 2 }));
    const tap = at(1.75, 1.25);
    drag(controller, [tap], 'touch');
    expect(marks()).toHaveLength(1);
    const command = marks()[0];
    expect(command.operation).toBe('toggle');
    expect([...command.cells!.indices]).toEqual([9]);
    expect([...command.cells!.masks]).toEqual([1 << QuarterCorner.NE]);
    expect(command.backstitchIds).toBeUndefined();
    controller.dispose();
  });

  it('ignores a tap on an empty cell', () => {
    const { controller, marks } = markFixture();
    const tap = at(2.5, 2.5);
    drag(controller, [tap]);
    expect(marks()).toHaveLength(0);
    controller.dispose();
  });

  it('sets every stitch a drag crosses in one call and previews the marks', () => {
    const { boundary, gateway, uiStore, controller, marks } = markFixture();
    for (let x = 1; x <= 4; x += 1) gateway.execute(cell(8, { type: 'set-full', x, y: 2, color: 1 }));
    boundary.seed({ type: 'add-backstitch', start: { x: 12, y: 8 }, end: { x: 12, y: 12 }, color: 1 });
    controller.handlePointerDown(pointer(1, at(1.5, 2.5).x, at(1.5, 2.5).y));
    controller.handlePointerMove(pointer(1, at(2.5, 2.5).x, at(2.5, 2.5).y));
    const preview = uiStore.getState().overlay.pendingCellStates;
    expect(preview?.map((state) => [state.index, state.completed])).toEqual([[17, 1], [18, 1]]);
    controller.handlePointerMove(pointer(1, at(4.5, 2.5).x, at(4.5, 2.5).y));
    controller.handlePointerUp(pointer(1, at(4.5, 2.5).x, at(4.5, 2.5).y));
    expect(marks()).toHaveLength(1);
    const command = marks()[0];
    expect(command.operation).toBe('set');
    expect([...command.cells!.indices]).toEqual([17, 18, 19, 20]);
    expect([...command.cells!.masks]).toEqual([1, 1, 1, 1]);
    expect(command.backstitchIds?.length).toBe(1);
    expect(uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    expect(boundary.undoDepth).toBe(5);
    controller.dispose();
  });

  it('clears a drag when the first stitch it reaches is already done', () => {
    const { boundary, gateway, controller, markProgress, marks } = markFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 1, y: 2, color: 1 }));
    gateway.execute(cell(8, { type: 'set-full', x: 2, y: 2, color: 1 }));
    boundary.markProgress({ cells: { indices: Uint32Array.of(17), masks: Uint8Array.of(1) }, operation: 'set' });
    markProgress.mockClear();
    drag(controller, [at(1.5, 2.5), at(2.5, 2.5)]);
    expect(marks()).toHaveLength(1);
    expect(marks()[0].operation).toBe('clear');
    expect([...marks()[0].cells!.indices]).toEqual([17, 18]);
    controller.dispose();
  });

  it('marks only the highlighted color', () => {
    const { gateway, controller, marks } = markFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 1, y: 2, color: 1 }));
    gateway.execute(cell(8, { type: 'set-full', x: 2, y: 2, color: 2 }));
    gateway.execute(cell(8, { type: 'set-full', x: 3, y: 2, color: 1 }));
    gateway.execute(cell(8, { type: 'set-quarter', x: 4, y: 2, corner: QuarterCorner.NW, color: 1 }));
    gateway.execute(cell(8, { type: 'set-quarter', x: 4, y: 2, corner: QuarterCorner.SE, color: 2 }));
    controller.setHighlightColor(2);
    drag(controller, [at(1.5, 2.5), at(4.5, 2.5)]);
    expect(marks()).toHaveLength(1);
    const command = marks()[0];
    expect(command.operation).toBe('set');
    expect([...command.cells!.indices]).toEqual([18, 20]);
    expect([...command.cells!.masks]).toEqual([1, 1 << QuarterCorner.SE]);
    drag(controller, [at(1.5, 2.5)]);
    expect(marks()).toHaveLength(1);
    controller.dispose();
  });

  it('pinches instead of marking when a second finger lands', () => {
    const { gateway, uiStore, controller, marks } = markFixture();
    for (let x = 1; x <= 4; x += 1) gateway.execute(cell(8, { type: 'set-full', x, y: 2, color: 1 }));
    const before = uiStore.getState().viewport;
    controller.handlePointerDown(pointer(1, at(1.5, 2.5).x, at(1.5, 2.5).y, 'touch'));
    controller.handlePointerMove(pointer(1, at(3.5, 2.5).x, at(3.5, 2.5).y, 'touch'));
    controller.handlePointerDown(pointer(2, at(6.5, 6.5).x, at(6.5, 6.5).y, 'touch'));
    controller.handlePointerMove(pointer(2, at(7.5, 7.5).x, at(7.5, 7.5).y, 'touch'));
    expect(uiStore.getState().overlay.pendingCellStates).toBeUndefined();
    controller.handlePointerUp(pointer(2, at(7.5, 7.5).x, at(7.5, 7.5).y, 'touch'));
    controller.handlePointerUp(pointer(1, at(3.5, 2.5).x, at(3.5, 2.5).y, 'touch'));
    expect(marks()).toHaveLength(0);
    expect(uiStore.getState().viewport).not.toEqual(before);
    controller.dispose();
  });

  it('still pans with the middle button', () => {
    const { gateway, uiStore, controller, marks } = markFixture();
    gateway.execute(cell(8, { type: 'set-full', x: 1, y: 2, color: 1 }));
    const before = uiStore.getState().viewport;
    controller.handlePointerDown(pointer(1, at(1.5, 2.5).x, at(1.5, 2.5).y, 'mouse', 1));
    controller.handlePointerMove(pointer(1, at(3.5, 2.5).x, at(3.5, 2.5).y, 'mouse', 1));
    controller.handlePointerUp(pointer(1, at(3.5, 2.5).x, at(3.5, 2.5).y, 'mouse', 1));
    expect(marks()).toHaveLength(0);
    expect(uiStore.getState().viewport.x).not.toBe(before.x);
    controller.dispose();
  });
});

describe('EditorSurfaceController editor style', () => {
  it('never draws completion marks and refuses the mark tool', () => {
    const { controller, calls } = controllerFixture();
    expect(calls.setStyle[0]).toMatchObject({ showCompletion: false, highlightColor: null });
    expect(controller.setTool({ tool: 'mark' })).toBe(false);
    controller.dispose();
  });
});
