import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { clearClipboard } from './clipboard-store';
import { applyCommand, CellKind, createDocument, type LayeredDocument, type PaletteEntryInput, type PatternDocument } from '../domain';
import {
  decodeDocument,
  encodeDocument,
  type ProjectMetadata,
  type ProjectRecord,
  type SaveResult
} from '../persistence';
import { DEFAULT_CATALOG_DEFINITION, createCatalogReference } from '../catalog';
import { ProjectWorkspace } from '../application';
import type { WorkspaceRepository } from '../application/types';
import { CANVAS_CROP_OFF_HINT, type CanvasRenderer, type RenderStats, type RendererStyle, type Viewport } from './contracts';
import { getCanvasMetrics } from './coordinates';
import { EditorSurfaceController } from './controller';
import { createWorkspaceEditorGateway } from './gateway';
import { createPointerEventsAdapter, type PointerSample } from './input';
import { createUiStore } from './ui-store';

// The chart starts four cells in, so a paste hanging past its top-left edge is still on screen.
const VIEWPORT: Viewport = { x: -4, y: -4, zoom: 16 };

class MemoryRepository implements WorkspaceRepository {
  private readonly records = new Map<string, { metadata: ProjectMetadata; bytes: Uint8Array }>();

  async save(projectId: string, metadata: ProjectMetadata, document: LayeredDocument): Promise<SaveResult> {
    this.records.set(projectId, { metadata: { ...metadata }, bytes: encodeDocument(document) });
    return { committed: true, stale: false, revision: document.revision, head: { projectId, revision: document.revision, checksum: '0'.repeat(64) } };
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    if (!record) return undefined;
    const document = decodeDocument(record.bytes);
    return { metadata: { ...record.metadata }, document, head: { projectId, revision: document.revision, checksum: '0'.repeat(64) }, recovery: null, assets: [] };
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].map((record) => ({ ...record.metadata }));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }

}

function rendererFixture(): CanvasRenderer {
  let viewport: Viewport = VIEWPORT;
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

const RED = DEFAULT_CATALOG_DEFINITION.records.find((record) => record.code === '321')!;
const red = (name: string): PaletteEntryInput => ({ name, color: RED.hex, catalog: createCatalogReference(DEFAULT_CATALOG_DEFINITION, RED) });

/** Pattern A: DMC 321 as id 1 and a custom mint as id 2. */
function patternA(width = 6, height = 6): PatternDocument {
  return createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width, height, palette: [
    { id: 1, ...red('Red') },
    { id: 2, name: 'Mint', color: '#abcdef' }
  ] });
}

/** Pattern B: a custom ink as id 1 and DMC 321, under another name and hex, as id 2. */
function patternB(width = 4, height = 4): PatternDocument {
  return createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width, height, palette: [
    { id: 1, name: 'Ink', color: '#123456' },
    { id: 2, ...red('Cardinal'), color: '#cc0000' }
  ] });
}

function paint(document: PatternDocument, cells: ReadonlyArray<readonly [number, number, number]>): PatternDocument {
  let painted = document;
  for (const [x, y, color] of cells) painted = applyCommand(painted, { type: 'set-full', x, y, color }).document;
  return painted;
}

type UiStore = ReturnType<typeof createUiStore>;

/** A mouse sample at the centre of a model cell. Opening a project refits the viewport, so read it live. */
function at(uiStore: UiStore, x: number, y: number): PointerSample {
  const { viewport } = uiStore.getState();
  return { pointerId: 1, pointerType: 'mouse', screenX: (x + 0.5 - viewport.x) * viewport.zoom, screenY: (y + 0.5 - viewport.y) * viewport.zoom, button: 0, buttons: 1, isPrimary: true };
}

function drag(controller: EditorSurfaceController, uiStore: UiStore, from: { x: number; y: number }, to: { x: number; y: number }): void {
  controller.handlePointerDown(at(uiStore, from.x, from.y));
  controller.handlePointerMove(at(uiStore, to.x, to.y));
  controller.handlePointerUp({ ...at(uiStore, to.x, to.y), buttons: 0 });
}

const workspaces: ProjectWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

/** A real workspace and session behind the editor gateway, with pattern A open. */
async function layeredFixture(source: PatternDocument) {
  let next = 0;
  const workspace = new ProjectWorkspace({ repository: new MemoryRepository(), clock: { now: () => 100 }, projectIdFactory: () => `project-${String(next += 1)}`, debounceMs: 0 });
  workspaces.push(workspace);
  await workspace.createProject({ id: 'pattern-a', document: source });
  const notices: string[] = [];
  /** A controller over the workspace's active project, as EditorSurface mounts one per project. */
  const mount = () => {
    const uiStore = createUiStore({ viewport: VIEWPORT, tool: { tool: 'select' } });
    const controller = new EditorSurfaceController({ gateway: createWorkspaceEditorGateway(workspace), uiStore, renderer: rendererFixture(), metrics: getCanvasMetrics(320, 320), onNotice: (message) => notices.push(message) });
    controller.start();
    return { controller, uiStore };
  };
  const { controller, uiStore } = mount();
  const session = () => workspace.session!;
  const cell = (x: number, y: number) => {
    const document = session().document;
    const index = y * document.width + x;
    return { kind: document.kind[index], color: document.colors[index * 4] };
  };
  return { workspace, controller, uiStore, mount, notices, session, cell, open: (document: PatternDocument, id = 'pattern-b') => workspace.createProject({ id, document }) };
}

// The clipboard outlives controllers, so each case starts without one.
beforeEach(clearClipboard);

describe('cross-pattern paste', () => {
  it('keeps the clipboard across a project switch and pastes with remapped colors as one undo step', async () => {
    const { controller, uiStore, session, cell, open } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 0, 2]]));
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.copySelection()).toBeDefined();
    await open(patternB());
    expect(controller.getClipboard()).toBeDefined();
    expect(uiStore.getState().canPaste).toBe(true);

    uiStore.setKeyboardCursor({ x: 1, y: 1 });
    expect(controller.pasteSelection()).toBe(true);
    const floating = uiStore.getState().overlay.floatingPaste!;
    // DMC 321 matches B's id 2 by code although name and hex differ; the custom mint is new.
    expect(Array.from(floating.fragment.colors.filter((_, index) => index % 4 === 0))).toEqual([2, 3]);
    expect(floating.pendingPalette).toEqual([expect.objectContaining({ id: 3, name: 'Mint', color: '#abcdef', active: true })]);
    expect(session().document.palette).toHaveLength(2);

    const undoDepth = session().historyUndoDepth;
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(session().historyUndoDepth).toBe(undoDepth + 1);
    expect(session().document.palette.find((entry) => entry.id === 3)).toMatchObject({ name: 'Mint', color: '#abcdef', symbol: floating.pendingPalette![0].symbol });
    expect(cell(1, 1)).toEqual({ kind: CellKind.Full, color: 2 });
    expect(cell(2, 1)).toEqual({ kind: CellKind.Full, color: 3 });

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(session().document.palette.map((entry) => entry.id)).toEqual([1, 2]);
    expect(cell(1, 1).kind).toBe(CellKind.Empty);
    expect(cell(2, 1).kind).toBe(CellKind.Empty);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(session().document.palette.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(cell(2, 1)).toEqual({ kind: CellKind.Full, color: 3 });
    controller.dispose();
  });

  it('keeps the clipboard when the app mounts a new controller for the next project', async () => {
    const { controller, uiStore, mount, session, cell, open } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 0, 2]]));
    expect(uiStore.getState().canPaste).toBe(false);
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    controller.copySelection();
    controller.dispose();
    await open(patternB());

    const next = mount();
    expect(next.uiStore.getState().canPaste).toBe(true);
    next.controller.handleFocus();
    next.uiStore.setKeyboardCursor({ x: 0, y: 2 });
    expect(next.controller.handleKeyDown({ key: 'v', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
    expect(next.uiStore.getState().overlay.floatingPaste?.pendingPalette).toEqual([expect.objectContaining({ id: 3, name: 'Mint' })]);
    expect(next.controller.confirmFloatingPaste()).toBe(true);
    expect(cell(0, 2)).toEqual({ kind: CellKind.Full, color: 2 });
    expect(cell(1, 2)).toEqual({ kind: CellKind.Full, color: 3 });
    expect(session().document.palette.map((entry) => entry.id)).toEqual([1, 2, 3]);
    next.controller.dispose();
  });

  it('enables Paste in every live controller when any of them copies, and not in a disposed one', async () => {
    const { controller, uiStore, mount } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    const other = mount();
    const disposed = mount();
    disposed.controller.dispose();
    expect(other.uiStore.getState().canPaste).toBe(false);
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    expect(uiStore.getState().canPaste).toBe(true);
    expect(other.uiStore.getState().canPaste).toBe(true);
    expect(disposed.uiStore.getState().canPaste).toBe(false);
    controller.dispose();
    other.controller.dispose();
  });

  it('pastes within one pattern with no new palette entries', async () => {
    const { controller, uiStore, session } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 0, 2]]));
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    controller.copySelection();
    uiStore.setKeyboardCursor({ x: 0, y: 2 });
    expect(controller.pasteSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste?.pendingPalette).toBeUndefined();
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(session().document.palette).toHaveLength(2);
    controller.dispose();
  });

  it('floats an oversized fragment whole, drags it off the edge and back without loss, and commits only the part on the chart', async () => {
    const { controller, uiStore, session, cell, open } = await layeredFixture(paint(patternA(), [[0, 0, 1], [3, 3, 1], [3, 0, 2]]));
    controller.setSelection({ x: 0, y: 0 }, { x: 3, y: 3 });
    controller.copySelection();
    await open(patternB(3, 3));
    expect(controller.pasteSelection()).toBe(true);
    const original = uiStore.getState().overlay.floatingPaste!;
    expect(original.destination).toEqual({ x: 0, y: 0, width: 4, height: 4 });

    drag(controller, uiStore, { x: 1, y: 1 }, { x: -1, y: 1 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toEqual({ x: -2, y: 0, width: 4, height: 4 });
    // At least one column stays on the chart.
    drag(controller, uiStore, { x: 0, y: 1 }, { x: -6, y: 1 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: -3, y: 0 });
    // The hidden part cannot be grabbed.
    drag(controller, uiStore, { x: -2, y: 1 }, { x: 1, y: 1 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: -3, y: 0 });
    drag(controller, uiStore, { x: 0, y: 1 }, { x: 3, y: 1 });
    const back = uiStore.getState().overlay.floatingPaste!;
    expect(back.destination).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(Array.from(back.fragment.kind)).toEqual(Array.from(original.fragment.kind));
    expect(Array.from(back.fragment.colors)).toEqual(Array.from(original.fragment.colors));

    // Up and left one cell: the fragment's (3,3) lands at (2,2) and its first row and column fall off.
    drag(controller, uiStore, { x: 1, y: 1 }, { x: 0, y: 0 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: -1, y: -1 });
    const undoDepth = session().historyUndoDepth;
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(session().historyUndoDepth).toBe(undoDepth + 1);
    expect(cell(2, 2)).toEqual({ kind: CellKind.Full, color: 2 });
    expect(Array.from(session().document.kind).filter((kind) => kind !== CellKind.Empty)).toHaveLength(1);
    // The mint at fragment (3,0) fell off with the top row, so B gains no color.
    expect(session().document.palette).toHaveLength(2);
    expect(uiStore.getState().status).toBe('Pasted 3×3 cells');
    controller.dispose();
  });

  it('still clamps a floating move inside the chart', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 1, 1]]));
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(controller.moveSelection()).toBe(true);
    drag(controller, uiStore, { x: 1, y: 1 }, { x: -2, y: -2 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    drag(controller, uiStore, { x: 1, y: 1 }, { x: 9, y: 9 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toEqual({ x: 4, y: 4, width: 2, height: 2 });
    controller.dispose();
  });

  it('pastes only the focus color under Focus Color, and creates no palette entry it does not use', async () => {
    const { controller, uiStore, session, cell, open } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 0, 2]]));
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    controller.copySelection();
    await open(patternB());
    uiStore.setState({ paletteId: 2 });
    controller.setFocusColor(true);
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    expect(controller.pasteSelection()).toBe(true);
    // The preview already matches what a commit pastes: the remapped focus color only.
    expect(Array.from(uiStore.getState().overlay.floatingPaste!.fragment.kind)).toEqual([CellKind.Full, CellKind.Empty]);
    const undoDepth = session().historyUndoDepth;
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(session().historyUndoDepth).toBe(undoDepth + 1);
    expect(cell(0, 0)).toEqual({ kind: CellKind.Full, color: 2 });
    expect(cell(1, 0).kind).toBe(CellKind.Empty);
    expect(session().document.palette).toHaveLength(2);
    controller.dispose();
  });

  it('refuses to open a paste when the target palette has no room for its new colors', async () => {
    const { controller, uiStore, notices, open } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 0, 2]]));
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    controller.copySelection();
    await open(createDocument({ catalog: { ...DEFAULT_CATALOG_DEFINITION.association, colorCount: 2 }, width: 4, height: 4, palette: [
      { id: 1, name: 'Ink', color: '#123456' },
      { id: 2, name: 'Snow', color: '#ffffff' }
    ] }));
    expect(controller.pasteSelection()).toBe(false);
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(notices).toEqual(['This pattern has no room for 2 more colors']);
    expect(uiStore.getState().status).toBe('Paste unavailable');
    controller.dispose();
  });
});

describe('clipboard shortcuts from another tool', () => {
  const key = (controller: EditorSurfaceController, letter: string) => controller.handleKeyDown({ key: letter, ctrlKey: true, preventDefault: () => undefined });

  it('switches to Select and opens the paste on Ctrl+V', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    controller.handleFocus();
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.clearSelection();
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    uiStore.setKeyboardCursor({ x: 2, y: 2 });
    expect(key(controller, 'v')).toBe(true);
    expect(uiStore.getState().tool.tool).toBe('select');
    // The switch came first, so it did not discard the new paste.
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: 2, y: 2 });
    expect(uiStore.getState().status).toBe('Paste ready');
    controller.dispose();
  });

  it('keeps Lasso active, as a Select tool, on Ctrl+V', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    controller.handleFocus();
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.setTool({ tool: 'lasso' });
    expect(key(controller, 'v')).toBe(true);
    expect(uiStore.getState().tool.tool).toBe('lasso');
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    controller.dispose();
  });

  it('does not paste when Select is unavailable on the active layer', async () => {
    const { workspace, controller, uiStore, notices } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    controller.handleFocus();
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.setTool({ tool: 'pan' });
    workspace.setActiveLayer('canvas');
    expect(key(controller, 'v')).toBe(true);
    expect(uiStore.getState().tool.tool).toBe('pan');
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(notices).toEqual([CANVAS_CROP_OFF_HINT]);
    controller.dispose();
  });

  it('switches to Select and copies a lingering selection on Ctrl+C', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1], [1, 0, 2]]));
    controller.handleFocus();
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(key(controller, 'c')).toBe(true);
    expect(uiStore.getState().tool.tool).toBe('select');
    expect(uiStore.getState().status).toBe('Copied 2×1 cells');
    expect(uiStore.getState().canPaste).toBe(true);
    controller.dispose();
  });

  it('pulses Copy or Paste only for a shortcut that registered', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    controller.handleFocus();
    expect(key(controller, 'v')).toBe(false);
    expect(key(controller, 'c')).toBe(false);
    expect(uiStore.getState().clipboardPulse).toBeNull();
    controller.setSelection({ x: 0, y: 0 });
    expect(key(controller, 'c')).toBe(true);
    expect(uiStore.getState().clipboardPulse).toEqual({ action: 'copy', seq: 1 });
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(key(controller, 'v')).toBe(true);
    expect(uiStore.getState().clipboardPulse).toEqual({ action: 'paste', seq: 2 });
    controller.dispose();
  });

  it('reaches the controller through the input adapter from a focused tool button', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    // EditorSurface's layout: rail buttons share the keyboard surface and are excluded from routing.
    const root = document.createElement('section');
    const frame = document.createElement('div');
    const stitch = document.createElement('button');
    stitch.setAttribute('aria-label', 'Stitch');
    root.append(stitch, frame);
    document.body.append(root);
    const adapter = createPointerEventsAdapter(frame, controller, {
      keyboardSurface: root,
      shouldExcludeTarget: (target) => target instanceof Element && Boolean(target.closest('button[aria-label="Stitch"]'))
    });
    try {
      stitch.focus();
      stitch.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
      expect(uiStore.getState().tool.tool).toBe('select');
      expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    } finally {
      adapter.dispose();
      root.remove();
      controller.dispose();
    }
  });

  it('leaves the tool alone when there is nothing to copy or paste', async () => {
    const { controller, uiStore } = await layeredFixture(paint(patternA(), [[0, 0, 1]]));
    controller.handleFocus();
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    expect(key(controller, 'v')).toBe(false);
    expect(key(controller, 'c')).toBe(false);
    expect(uiStore.getState().tool.tool).toBe('paint');
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    controller.dispose();
  });
});
