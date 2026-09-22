import { describe, expect, it } from 'vitest';
import {
  CellKind,
  createDocument,
  createEditor,
  type CommandResult,
  type DomainCommand,
  type PatternDocument
} from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { createFillWorkerClient, createFillResult, type FillWorkerClient, type FillWorkerLike } from './fill';
import { EditorSurfaceController } from './controller';
import { createUiStore } from './ui-store';
import type {
  CanvasRenderer,
  RendererStyle,
  RenderStats,
  Viewport
} from './contracts';
import type { EditorRevisionToken, EditorTransaction, WorkspaceEditorGateway, WorkspaceEditorSnapshot } from './gateway';
import type { PointerSample } from './input';

class FakeGateway implements WorkspaceEditorGateway {
  private editor: ReturnType<typeof createEditor>;
  private projectId = 'project-a';
  private readonly listeners = new Set<(snapshot: WorkspaceEditorSnapshot) => void>();
  readonly commands: DomainCommand[] = [];

  constructor(document: PatternDocument) {
    this.editor = createEditor(document);
  }

  getSnapshot(): WorkspaceEditorSnapshot {
    return { projectId: this.projectId, revision: this.editor.revision, document: this.editor.document };
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
        if (committed) throw new Error('Transaction already committed.');
        committed = true;
        return this.execute(command, token);
      },
      commitBatch: (commands) => {
        if (committed) throw new Error('Transaction already committed.');
        committed = true;
        return this.executeBatch(commands, token);
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
    this.commands.push(...commands);
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
    this.projectId = 'project-b';
    this.editor = createEditor(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    this.emit();
  }

  replaceDocument(document: PatternDocument): void {
    this.editor = createEditor(document);
    this.emit();
  }

  dispose(): void {}

  private token(): EditorRevisionToken {
    return { projectId: this.projectId, revision: this.editor.revision };
  }

  private assertToken(expected: EditorRevisionToken | undefined): void {
    const actual = this.token();
    if (expected && (expected.projectId !== actual.projectId || expected.revision !== actual.revision)) throw new Error('stale');
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

class FakeWorker implements FillWorkerLike {
  readonly posted: unknown[] = [];
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.set(_type, listener as unknown as (event: unknown) => void);
  }

  emit(message: unknown): void {
    this.listeners.get('message')?.({ data: message });
  }
}

function rendererFixture(): CanvasRenderer {
  let viewport: Viewport = { x: 0, y: 0, zoom: 16 };
  const renderer = {
    lastStats: { lod: 'detail', visitedCells: 0, drawnCells: 0, drawnBackstitches: 0, baseRendered: false, overlayRendered: false } as RenderStats,
    getDocument: () => undefined,
    getViewport: () => viewport,
    getStyle: () => ({}) as RendererStyle,
    setDocument: () => undefined,
    setViewport: (next: Viewport) => { viewport = next; },
    setMetrics: () => undefined,
    setStyle: () => undefined,
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

function pointer(pointerId: number, screenX: number, screenY: number): PointerSample {
  return { pointerId, pointerType: 'mouse', screenX, screenY, button: 0, buttons: 1, isPrimary: true };
}

function documentWithStitches(): PatternDocument {
  const editor = createEditor(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 8, height: 8, palette: [
    { id: 1, name: 'Red', color: '#d33' },
    { id: 2, name: 'Blue', color: '#36c' }
  ] }));
  editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
  editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
  editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: 0, color: 1 });
  editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: 1, color: 2 });
  editor.execute({ type: 'set-quarter', x: 2, y: 0, corner: 2, color: 1 });
  editor.execute({ type: 'set-quarter', x: 2, y: 0, corner: 3, color: 2 });
  return editor.document;
}

function fixture(document = documentWithStitches(), providedFillClient?: FillWorkerClient) {
  const gateway = new FakeGateway(document);
  const uiStore = createUiStore();
  const worker = new FakeWorker();
  const fillClient = providedFillClient ?? createFillWorkerClient({ workerFactory: () => worker, requestIdFactory: () => `fill-${String(worker.posted.length)}` });
  const controller = new EditorSurfaceController({ gateway, uiStore, renderer: rendererFixture(), fillClient });
  controller.start();
  controller.handleFocus();
  return { gateway, uiStore, worker, controller };
}

describe('advanced headless editor tools', () => {
  it('erases whole cells and quarter components, including keyboard Delete mode', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'eraser', mode: 'whole-cell' });
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([{ index: 0, kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 }]);
    controller.handlePointerUp(pointer(1, 8, 8));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'mixed-erase', wholeCellIndices: new Uint32Array([0]) });

    controller.setTool({ tool: 'eraser', mode: 'component', corner: 1 });
    controller.handlePointerDown(pointer(2, 28, 4));
    expect(uiStore.getState().overlay.pendingCellStates).toMatchObject([{ index: 1, kind: CellKind.Quarters, colors: [1, 0, 0, 0] }]);
    controller.handlePointerUp(pointer(2, 28, 4));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'mixed-erase', componentCellIndices: new Uint32Array([1]), componentCorners: new Uint8Array([1]) });

    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    const commandCountBeforeNoop = gateway.commands.length;
    controller.handleKeyDown({ key: 'Delete', preventDefault: () => undefined });
    expect(gateway.commands).toHaveLength(commandCountBeforeNoop);
    controller.dispose();
  });

  it('uses every configured corner for keyboard component erasing and publishes the corner status', () => {
    const editor = createEditor(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' },
      { id: 4, name: 'Green', color: '#2a5' }
    ] }));
    editor.execute({ type: 'set-quarter', x: 0, y: 0, corner: 0, color: 1 });
    editor.execute({ type: 'set-quarter', x: 0, y: 0, corner: 1, color: 2 });
    editor.execute({ type: 'set-quarter', x: 0, y: 0, corner: 2, color: 3 });
    editor.execute({ type: 'set-quarter', x: 0, y: 0, corner: 3, color: 4 });
    const { controller, gateway, uiStore } = fixture(editor.document);
    controller.setTool({ tool: 'eraser', mode: 'component' });
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    for (const corner of [0, 1, 2, 3] as const) {
      controller.setEraserCorner(corner);
      controller.handleKeyDown({ key: 'Backspace', preventDefault: () => undefined });
      expect(gateway.getSnapshot().document?.colors[corner]).toBe(0);
      expect(uiStore.getState().status).toContain(`quarter ${String(corner)}`);
    }
    expect(gateway.commands.filter((command) => command.type === 'bulk-cell')).toHaveLength(4);
    controller.dispose();
  });

  it('uses one mixed-erase command and one history entry across primary and differently-cornered quarters', () => {
    const { controller, gateway } = fixture();
    controller.setTool({ tool: 'eraser', mode: 'component' });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 28, 4));
    controller.handlePointerMove(pointer(1, 44, 12));
    controller.handlePointerUp(pointer(1, 44, 12));
    expect(gateway.commands).toHaveLength(1);
    expect(gateway.commands[0]).toMatchObject({ type: 'mixed-erase' });
    expect(gateway.commands[0].wholeCellIndices).toEqual(new Uint32Array([0]));
    expect(gateway.commands[0].componentCellIndices).toEqual(new Uint32Array([1, 2]));
    expect(gateway.commands[0].componentCorners).toEqual(new Uint8Array([1, 2]));
    expect(gateway.undoDepth).toBe(1);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.colors.slice(4, 8)).toEqual(new Uint16Array([1, 0, 0, 0]));
    expect(gateway.getSnapshot().document?.colors.slice(8, 12)).toEqual(new Uint16Array([0, 0, 0, 2]));

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.undoDepth).toBe(0);
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.colors.slice(4, 8)).toEqual(new Uint16Array([1, 2, 0, 0]));
    expect(gateway.getSnapshot().document?.colors.slice(8, 12)).toEqual(new Uint16Array([0, 0, 1, 2]));
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('normalizes selection rectangles, supports Shift-arrow extension, and clears with Escape', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.handlePointerDown(pointer(1, 56, 40));
    controller.handlePointerMove(pointer(1, 24, 8));
    controller.handlePointerUp(pointer(1, 24, 8));
    expect(controller.getSelection()).toEqual({ x: 1, y: 0, width: 3, height: 3 });
    expect(uiStore.getState().overlay.selection).toMatchObject({ x: 1, y: 0, width: 3, height: 3 });
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(controller.getSelection()).toBeUndefined();

    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    controller.handleKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault: () => undefined });
    expect(controller.getSelection()).toEqual({ x: 1, y: 0, width: 1, height: 2 });
    controller.dispose();
  });

  it('clears an existing selection after a valid-cell Select click', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });

    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(controller.handlePointerUp(pointer(1, 8, 8))).toBe(true);
    expect(controller.getSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.selection).toBeUndefined();
    controller.dispose();
  });

  it('clears an existing selection after an outside-pattern Select click', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });

    expect(controller.handlePointerDown(pointer(1, 136, 8))).toBe(true);
    expect(controller.handlePointerUp(pointer(1, 136, 8))).toBe(false);
    expect(controller.getSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.selection).toBeUndefined();
    controller.dispose();
  });

  it('preserves drag selection behavior when replacing an existing selection', () => {
    const { controller } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 6, y: 6 }, { x: 7, y: 7 });

    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 40, 24));
    expect(controller.handlePointerUp(pointer(1, 40, 24))).toBe(true);
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 3, height: 2 });
    controller.dispose();
  });

  it('captures lasso selection modifiers at pointer-down and preserves selection while cancelled', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'lasso' });
    controller.setSelection({ x: 6, y: 6 });
    const before = controller.getSelection();

    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(uiStore.getState().overlay.lassoPath).toMatchObject({ points: [{ x: 0.5, y: 0.5 }] });
    expect(controller.getSelection()).toEqual(before);
    controller.handlePointerMove(pointer(1, 0, 0));
    controller.handlePointerMove(pointer(1, 48, 0));
    controller.handlePointerMove(pointer(1, 48, 48));
    controller.handlePointerMove(pointer(1, 0, 48));
    controller.handlePointerCancel(pointer(1, 0, 48));
    expect(controller.getSelection()).toEqual(before);
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();

    controller.handlePointerDown(pointer(2, 8, 8));
    controller.handlePointerMove(pointer(2, 0, 0));
    controller.handlePointerMove(pointer(2, 48, 0));
    controller.handlePointerMove(pointer(2, 48, 48));
    controller.handlePointerMove(pointer(2, 0, 48));
    controller.handlePointerUp(pointer(2, 0, 48));
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 3, height: 3 });
    expect(controller.getSelectionIndices()).toEqual(new Uint32Array([0, 1, 2, 8, 9, 10, 16, 17, 18]));
    expect(uiStore.getState().overlay.selection).toMatchObject({ kind: 'sparse', indices: [0, 1, 2, 8, 9, 10, 16, 17, 18] });

    controller.handlePointerDown({ ...pointer(3, 24, 8), shiftKey: true });
    controller.handlePointerMove({ ...pointer(3, 40, 8), shiftKey: true });
    controller.handlePointerUp({ ...pointer(3, 24, 8), shiftKey: false });
    expect(controller.getSelectionIndices()).toEqual(new Uint32Array([0, 1, 2, 8, 9, 10, 16, 17, 18]));

    controller.handlePointerDown({ ...pointer(4, 24, 8), shiftKey: true, altKey: true });
    controller.handlePointerMove({ ...pointer(4, 40, 8), shiftKey: true, altKey: true });
    controller.handlePointerUp({ ...pointer(4, 40, 8), shiftKey: false, altKey: false });
    expect(controller.getSelectionIndices()).toEqual(new Uint32Array([0, 2, 8, 9, 10, 16, 17, 18]));

    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    expect(controller.getSelection()).toBeUndefined();
    controller.handleKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault: () => undefined });
    expect(controller.getSelection()).toEqual({ x: 1, y: 0, width: 1, height: 2 });
    controller.dispose();
  });

  it('routes sparse copy and delete through ordered cell-set domain operations', () => {
    const { controller, gateway } = fixture();
    controller.setTool({ tool: 'lasso' });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 8, 8));
    controller.handlePointerDown({ ...pointer(2, 40, 8), shiftKey: true });
    controller.handlePointerUp(pointer(2, 40, 8));
    expect(controller.getSelectionIndices()).toEqual(new Uint32Array([0, 2]));
    expect(controller.copySelection()).toBeDefined();
    expect(Array.from(controller.getClipboard()!.kind)).toEqual([CellKind.Full, CellKind.Empty, CellKind.Quarters]);

    expect(controller.deleteSelection()).toBe(true);
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'delete-cell-set', indices: new Uint32Array([0, 2]) });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[1]).toBe(CellKind.Quarters);
    expect(gateway.getSnapshot().document?.kind[2]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('defers selected-cell actions for mouse and pen while preserving drag gestures', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });

    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.touchCopyRequest).toMatchObject({ cell: { x: 0, y: 0 }, screenX: 8, screenY: 8 });
    controller.dismissTouchCopyRequest();

    controller.handlePointerDown({ ...pointer(2, 8, 8), pointerType: 'pen' });
    controller.handlePointerMove({ ...pointer(2, 40, 8), pointerType: 'pen' });
    controller.handlePointerUp({ ...pointer(2, 40, 8), pointerType: 'pen' });
    expect(uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 3, height: 1 });
    controller.dispose();
  });

  it('applies a release beyond slop when mouse or pen has not emitted a move', () => {
    const mouse = fixture();
    mouse.controller.setTool({ tool: 'select' });
    mouse.controller.setSelection({ x: 0, y: 0 });
    mouse.controller.handlePointerDown(pointer(1, 8, 8));
    mouse.controller.handlePointerUp(pointer(1, 40, 8));
    expect(mouse.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(mouse.controller.getSelection()).toEqual({ x: 0, y: 0, width: 3, height: 1 });
    mouse.controller.dispose();

    const pen = fixture();
    pen.controller.setTool({ tool: 'select' });
    pen.controller.setSelection({ x: 0, y: 0 });
    pen.controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'pen' });
    pen.controller.handlePointerUp({ ...pointer(1, 40, 8), pointerType: 'pen' });
    expect(pen.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(pen.controller.getSelection()).toEqual({ x: 0, y: 0, width: 3, height: 1 });
    pen.controller.dispose();
  });

  it('renders copy-time selection geometry when pasting from a different selection', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });
    controller.copySelection();
    controller.setSelection({ x: 5, y: 5 });

    expect(controller.pasteSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({
      destination: { x: 5, y: 5, width: 2, height: 2 },
      copySelection: { kind: 'rect', rect: { x: 1, y: 1, width: 2, height: 2 } }
    });
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(controller.getSelection()).toEqual({ x: 5, y: 5, width: 1, height: 1 });
    controller.dispose();
  });

  it('retains the immutable sparse copy outline reference while dragging a floating paste', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'lasso' });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 8, 8));
    controller.handlePointerDown({ ...pointer(2, 40, 8), shiftKey: true });
    controller.handlePointerUp({ ...pointer(2, 40, 8), shiftKey: false });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 3, y: 3 });
    expect(controller.pasteSelection()).toBe(true);
    const initial = uiStore.getState().overlay.floatingPaste?.copySelection;
    const initialBoundaries = initial?.boundaries;
    expect(initial?.kind).toBe('sparse');

    controller.handlePointerDown(pointer(3, 56, 56));
    controller.handlePointerMove(pointer(3, 72, 56));
    controller.handlePointerUp(pointer(3, 72, 56));
    const afterDrag = uiStore.getState().overlay.floatingPaste?.copySelection;
    expect(afterDrag).toBe(initial);
    expect(afterDrag?.boundaries).toBe(initialBoundaries);
    controller.dispose();
  });

  it('clears selected B after commit and restores B for no-op or recoverable failure', () => {
    const committed = fixture();
    committed.controller.setTool({ tool: 'select' });
    committed.controller.setSelection({ x: 0, y: 0 });
    committed.controller.copySelection();
    committed.controller.setSelection({ x: 5, y: 5 });
    expect(committed.controller.pasteSelection()).toBe(true);
    committed.controller.handlePointerDown(pointer(1, 8, 8));
    expect(committed.controller.getSelection()).toBeUndefined();
    expect(committed.uiStore.getState().overlay.selection).toBeUndefined();
    committed.controller.dispose();

    const noOp = fixture();
    noOp.controller.setTool({ tool: 'select' });
    noOp.controller.setSelection({ x: 4, y: 4 });
    noOp.controller.copySelection();
    noOp.controller.setSelection({ x: 5, y: 5 });
    const noOpCommandCount = noOp.gateway.commands.length;
    expect(noOp.controller.pasteSelection()).toBe(true);
    expect(noOp.uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 5, y: 5 } });
    noOp.controller.handlePointerDown(pointer(1, 8, 8));
    expect(noOp.gateway.commands).toHaveLength(noOpCommandCount);
    expect(noOp.uiStore.getState().status).toBe('No change');
    expect(noOp.controller.getSelection()).toEqual({ x: 5, y: 5, width: 1, height: 1 });
    expect(noOp.uiStore.getState().overlay.floatingPaste).toBeUndefined();
    noOp.controller.dispose();

    const failed = fixture();
    failed.controller.setTool({ tool: 'select' });
    failed.controller.setSelection({ x: 0, y: 0 });
    failed.controller.copySelection();
    failed.controller.setSelection({ x: 5, y: 5 });
    expect(failed.controller.pasteSelection()).toBe(true);
    failed.gateway.getSnapshot().document!.palette.length = 0;
    failed.controller.handlePointerDown(pointer(1, 8, 8));
    expect(failed.uiStore.getState().overlay.floatingPaste).toBeDefined();
    expect(failed.controller.getSelection()).toBeUndefined();
    failed.controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(failed.controller.getSelection()).toEqual({ x: 5, y: 5, width: 1, height: 1 });
    failed.controller.dispose();
  });

  it('clears sparse and legacy selections before a same-project dimension change', () => {
    const unchanged = fixture();
    unchanged.controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });
    unchanged.gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    expect(unchanged.controller.getSelection()).toEqual({ x: 1, y: 1, width: 2, height: 2 });
    unchanged.controller.dispose();

    const sparse = fixture();
    sparse.controller.setTool({ tool: 'lasso' });
    sparse.controller.handlePointerDown(pointer(1, 8, 8));
    sparse.controller.handlePointerUp(pointer(1, 8, 8));
    expect(sparse.controller.getSelectionIndices()).toEqual(new Uint32Array([0]));

    sparse.gateway.replaceDocument(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    expect(sparse.controller.getSelection()).toBeUndefined();
    expect(sparse.controller.getSelectionIndices()).toBeUndefined();
    expect(sparse.uiStore.getState().overlay.selection).toBeUndefined();
    expect(sparse.controller.copySelection()).toBeUndefined();
    expect(sparse.controller.deleteSelection()).toBe(false);
    sparse.controller.dispose();

    const legacy = fixture();
    legacy.controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });
    expect(legacy.controller.getSelection()).toEqual({ x: 1, y: 1, width: 2, height: 2 });
    legacy.gateway.replaceDocument(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    expect(legacy.controller.getSelection()).toBeUndefined();
    expect(legacy.uiStore.getState().overlay.selection).toBeUndefined();
    expect(legacy.controller.deleteSelection()).toBe(false);
    legacy.controller.dispose();

    const direct = fixture();
    direct.controller.setSelection({ x: 1, y: 1 });
    direct.controller.setDocument(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    expect(direct.controller.getSelection()).toBeUndefined();
    expect(direct.uiStore.getState().overlay.selection).toBeUndefined();
    direct.controller.dispose();

    const cropped = fixture();
    cropped.controller.setSelection({ x: 1, y: 1 });
    cropped.gateway.execute({ type: 'crop', x: 0, y: 0, width: 4, height: 4 });
    expect(cropped.controller.getSelection()).toBeUndefined();
    cropped.controller.dispose();

    const rotated = fixture(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 8, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    rotated.controller.setSelection({ x: 1, y: 1 });
    rotated.gateway.execute({ type: 'rotate-cw' });
    expect(rotated.controller.getSelection()).toBeUndefined();
    rotated.controller.dispose();
  });

  it('copies a local transparent fragment without completion and pastes in one transaction', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.handleKeyDown({ key: 'c', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
    expect(controller.getClipboard()).toBeDefined();
    expect('completed' in (controller.getClipboard() ?? {})).toBe(false);
    controller.clearSelection();
    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    const before = gateway.commands.length;
    expect(controller.handleKeyDown({ key: 'v', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
    expect(gateway.commands).toHaveLength(before);
    expect(controller.getSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 1, y: 0, width: 1, height: 1 } });
    controller.handlePointerDown(pointer(1, 8, 40));
    expect(gateway.commands).toHaveLength(before + 1);
    expect(gateway.commands.at(-1)?.type).toBe('paste-fragment');
    expect(gateway.getSnapshot().document?.completed[1]).toBe(0);
    controller.handleBlur();
    expect(controller.handleKeyDown({ key: 'c', ctrlKey: true })).toBe(false);
    gateway.switchProject();
    expect(controller.getClipboard()).toBeUndefined();
    controller.dispose();
  });

  it('moves a completed rectangular selection through one floating command with undo and redo', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    gateway.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({
      mode: 'move',
      destination: { x: 0, y: 0, width: 1, height: 1 },
      sourceSelection: { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }
    });
    expect(Array.from(uiStore.getState().overlay.floatingPaste?.completion ?? [])).toEqual([1]);

    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 40, 8));
    controller.handlePointerUp(pointer(1, 40, 8));
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 2, y: 0 } });
    controller.handlePointerDown(pointer(2, 120, 120));
    expect(gateway.commands.filter((command) => command.type === 'move-fragment')).toHaveLength(1);
    expect(controller.getSelection()).toBeUndefined();
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.kind[2]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.completed[2]).toBe(1);

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Full);
    expect(gateway.getSnapshot().document?.kind[2]).toBe(CellKind.Quarters);
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.kind[0]).toBe(CellKind.Empty);
    expect(gateway.getSnapshot().document?.completed[2]).toBe(1);
    controller.dispose();
  });

  it('captures sparse move geometry and restores the source on cancel or recoverable failure', () => {
    const cancelled = fixture();
    cancelled.controller.setTool({ tool: 'lasso' });
    cancelled.controller.handlePointerDown(pointer(1, 8, 8));
    cancelled.controller.handlePointerUp(pointer(1, 8, 8));
    cancelled.controller.handlePointerDown({ ...pointer(2, 40, 8), shiftKey: true });
    cancelled.controller.handlePointerUp({ ...pointer(2, 40, 8), shiftKey: false });
    expect(cancelled.controller.moveSelection()).toBe(true);
    expect(cancelled.uiStore.getState().overlay.floatingPaste).toMatchObject({
      mode: 'move',
      copySelection: { kind: 'sparse', rect: { x: 0, y: 0, width: 3, height: 1 } },
      sourceSelection: { kind: 'sparse', rect: { x: 0, y: 0, width: 3, height: 1 } }
    });
    cancelled.controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(cancelled.controller.getSelectionIndices()).toEqual(new Uint32Array([0, 2]));
    expect(cancelled.uiStore.getState().overlay.floatingPaste).toBeUndefined();
    cancelled.controller.dispose();

    const failed = fixture();
    failed.controller.setTool({ tool: 'select' });
    failed.gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    failed.controller.setSelection({ x: 0, y: 0 });
    expect(failed.controller.moveSelection()).toBe(true);
    failed.gateway.getSnapshot().document!.palette.length = 0;
    failed.controller.handlePointerDown(pointer(1, 120, 120));
    expect(failed.uiStore.getState().overlay.floatingPaste).toBeDefined();
    expect(failed.controller.getSelection()).toBeUndefined();
    failed.controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(failed.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    failed.controller.dispose();
  });

  it('discards a stale move preview and restores its source selection', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    gateway.execute({ type: 'set-full', x: 7, y: 7, color: 1 });
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    controller.dispose();
  });

  it('captures mixed cell/backstitch move state and restores a transparent no-op without changing clipboard/history', () => {
    const mixed = fixture();
    mixed.controller.setTool({ tool: 'select' });
    mixed.gateway.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    mixed.gateway.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    mixed.gateway.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 2 });
    mixed.gateway.execute({ type: 'set-backstitch-completion', id: 1, completed: true });
    mixed.controller.setSelection({ x: 0, y: 0 });
    mixed.controller.copySelection();
    const clipboard = mixed.controller.getClipboard();
    const historyBefore = mixed.gateway.undoDepth;
    expect(mixed.controller.moveSelection()).toBe(true);
    expect(mixed.uiStore.getState().overlay.floatingPaste).toMatchObject({ mode: 'move', completion: new Uint8Array([1]) });
    expect(mixed.uiStore.getState().overlay.floatingPaste?.backstitches).toMatchObject({
      ids: new Uint32Array([1]),
      x1: new Uint32Array([0]),
      x2: new Uint32Array([4]),
      colors: new Uint16Array([2]),
      completed: new Uint8Array([1])
    });
    mixed.controller.handlePointerDown(pointer(1, 8, 8));
    mixed.controller.handlePointerMove(pointer(1, 40, 8));
    mixed.controller.handlePointerUp(pointer(1, 40, 8));
    mixed.controller.handlePointerDown(pointer(1, 120, 120));
    expect(mixed.gateway.commands.filter((command) => command.type === 'move-fragment')).toHaveLength(1);
    expect(mixed.gateway.undoDepth).toBe(historyBefore + 1);
    expect(mixed.controller.getSelection()).toBeUndefined();
    expect(mixed.controller.getClipboard()?.kind).toEqual(clipboard?.kind);
    mixed.controller.dispose();

    const noop = fixture();
    noop.controller.setTool({ tool: 'select' });
    noop.controller.setSelection({ x: 0, y: 0 });
    noop.controller.copySelection();
    const noopClipboard = noop.controller.getClipboard();
    noop.controller.setSelection({ x: 4, y: 4 });
    const noopHistory = noop.gateway.undoDepth;
    expect(noop.controller.moveSelection()).toBe(true);
    noop.controller.handlePointerDown(pointer(1, 120, 120));
    expect(noop.gateway.undoDepth).toBe(noopHistory);
    expect(noop.controller.getSelection()).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    expect(noop.controller.getClipboard()?.kind).toEqual(noopClipboard?.kind);
    expect(noop.uiStore.getState().overlay.floatingPaste).toBeUndefined();
    noop.controller.dispose();
  });

  it('keeps floating paste out of document history until commit and supports replacement, cancel, and clamped anchors', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 4, y: 4 });
    const revision = gateway.getSnapshot().revision;
    expect(controller.pasteSelection()).toBe(true);
    expect(gateway.getSnapshot().revision).toBe(revision);
    expect(gateway.commands.at(-1)?.type).not.toBe('paste-fragment');
    expect(uiStore.getState().canPaste).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 4, y: 4, width: 1, height: 1 } });

    uiStore.setKeyboardCursor({ x: 7, y: 7 });
    expect(controller.pasteSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 7, y: 7, width: 1, height: 1 } });
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(controller.getSelection()).toBeUndefined();
    expect(gateway.getSnapshot().revision).toBe(revision);

    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 7, y: 7 });
    expect(controller.pasteSelection()).toBe(true);
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 6, y: 6, width: 2, height: 2 } });
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(gateway.commands.at(-1)?.type).toBe('paste-fragment');
    expect(controller.getSelection()).toBeUndefined();
    expect(gateway.undoDepth).toBe(1);
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(gateway.undoDepth).toBe(1);
    controller.dispose();
  });

  it('moves floating paste with pointer input, reverts on a second touch, and exposes touch Copy only on release', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.pasteSelection();
    const previewFragment = uiStore.getState().overlay.floatingPaste?.fragment;
    controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'touch' });
    controller.handlePointerMove({ ...pointer(1, 40, 8), pointerType: 'touch' });
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 2, y: 0 } });
    expect(uiStore.getState().overlay.floatingPaste?.fragment).toBe(previewFragment);
    controller.handlePointerDown({ ...pointer(2, 60, 8), pointerType: 'touch' });
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 0, y: 0 } });
    controller.handlePointerUp({ ...pointer(2, 60, 8), pointerType: 'touch' });
    controller.handlePointerUp({ ...pointer(1, 40, 8), pointerType: 'touch' });
    expect(gateway.commands.filter((command) => command.type === 'paste-fragment')).toHaveLength(0);
    controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });

    controller.setSelection({ x: 0, y: 0 });
    controller.handlePointerDown({ ...pointer(3, 8, 8), pointerType: 'touch' });
    expect(uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    controller.handlePointerUp({ ...pointer(3, 8, 8), pointerType: 'touch' });
    expect(uiStore.getState().overlay.touchCopyRequest).toMatchObject({
      cell: { x: 0, y: 0 },
      selection: { x: 0, y: 0, width: 1, height: 1 },
      screenX: 8,
      screenY: 8
    });
    controller.copySelection();
    expect(uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    controller.dispose();
  });

  it('retains a floating preview for recoverable command failure and discards it when the token goes stale', () => {
    const failed = fixture();
    failed.controller.setTool({ tool: 'select' });
    failed.controller.setSelection({ x: 0, y: 0 });
    failed.controller.copySelection();
    failed.controller.clearSelection();
    failed.uiStore.setKeyboardCursor({ x: 0, y: 0 });
    failed.controller.pasteSelection();
    failed.gateway.getSnapshot().document!.palette.length = 0;
    failed.controller.handlePointerDown(pointer(1, 120, 120));
    expect(failed.uiStore.getState().overlay.floatingPaste).toBeDefined();
    expect(failed.uiStore.getState().status).toBe('Paste unavailable');
    failed.controller.dispose();

    const stale = fixture();
    stale.controller.setTool({ tool: 'select' });
    stale.controller.setSelection({ x: 0, y: 0 });
    stale.controller.copySelection();
    stale.controller.clearSelection();
    stale.uiStore.setKeyboardCursor({ x: 0, y: 0 });
    stale.controller.pasteSelection();
    stale.gateway.execute({ type: 'set-full', x: 7, y: 7, color: 1 });
    expect(stale.uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(stale.controller.getSelection()).toBeUndefined();
    stale.controller.dispose();
  });

  it('keeps floating paste through keyboard Enter, Space/middle navigation, and post-pinch pan', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.pasteSelection();
    const revision = gateway.getSnapshot().revision;
    controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(gateway.getSnapshot().revision).toBe(revision);

    const beforeSpace = uiStore.getState().viewport;
    controller.handleKeyDown({ key: 'Space', preventDefault: () => undefined });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 40, 8));
    controller.handlePointerUp(pointer(1, 40, 8));
    controller.handleKeyUp({ key: 'Space' });
    expect(uiStore.getState().viewport).not.toEqual(beforeSpace);
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();

    const beforeMiddle = uiStore.getState().viewport;
    controller.handlePointerDown({ ...pointer(2, 8, 8), button: 1, buttons: 4 });
    controller.handlePointerMove({ ...pointer(2, 40, 8), button: 1, buttons: 4 });
    controller.handlePointerUp({ ...pointer(2, 40, 8), button: 1, buttons: 0 });
    expect(uiStore.getState().viewport).not.toEqual(beforeMiddle);

    const beforePinch = uiStore.getState().viewport;
    controller.handlePointerDown({ ...pointer(3, 48, 48), pointerType: 'touch' });
    controller.handlePointerDown({ ...pointer(4, 64, 48), pointerType: 'touch' });
    controller.handlePointerMove({ ...pointer(4, 80, 48), pointerType: 'touch' });
    controller.handlePointerUp({ ...pointer(3, 48, 48), pointerType: 'touch' });
    controller.handlePointerMove({ ...pointer(4, 96, 48), pointerType: 'touch' });
    controller.handlePointerUp({ ...pointer(4, 96, 48), pointerType: 'touch' });
    expect(uiStore.getState().viewport).not.toEqual(beforePinch);
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    expect(gateway.getSnapshot().revision).toBe(revision);
    controller.dispose();
  });

  it('ignores adapter lost-capture notifications that arrive after a floating pointer has already released', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.pasteSelection();
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerUp(pointer(1, 8, 8));
    controller.handlePointerLostCapture(pointer(1, 8, 8));
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    controller.dispose();
  });

  it('lets unrelated Space, middle-button, pinch, and post-pinch cancellation clean up normally', () => {
    const { controller, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    controller.copySelection();
    controller.clearSelection();
    uiStore.setKeyboardCursor({ x: 0, y: 0 });
    controller.pasteSelection();

    controller.handleKeyDown({ key: 'Space', preventDefault: () => undefined });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 40, 8));
    controller.handlePointerCancel(pointer(1, 40, 8));
    controller.handleKeyUp({ key: 'Space' });
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();

    controller.handlePointerDown({ ...pointer(2, 8, 8), button: 1, buttons: 4 });
    controller.handlePointerMove({ ...pointer(2, 40, 8), button: 1, buttons: 4 });
    controller.handlePointerLostCapture({ ...pointer(2, 40, 8), button: 1, buttons: 4 });
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();

    controller.handlePointerDown({ ...pointer(3, 48, 48), pointerType: 'touch' });
    controller.handlePointerDown({ ...pointer(4, 64, 48), pointerType: 'touch' });
    controller.handlePointerMove({ ...pointer(4, 80, 48), pointerType: 'touch' });
    controller.handlePointerCancel({ ...pointer(3, 48, 48), pointerType: 'touch' });
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    controller.handlePointerCancel({ ...pointer(4, 80, 48), pointerType: 'touch' });
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    controller.dispose();
  });

  it('falls back from touch Copy to Select or Pan movement according to touch policy', () => {
    const editing = fixture();
    editing.controller.setTool({ tool: 'select' });
    editing.controller.setSelection({ x: 0, y: 0 });
    editing.controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'touch' });
    editing.controller.handlePointerMove({ ...pointer(1, 24, 8), pointerType: 'touch' });
    editing.controller.handlePointerUp({ ...pointer(1, 24, 8), pointerType: 'touch' });
    expect(editing.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(editing.controller.getSelection()).toEqual({ x: 0, y: 0, width: 2, height: 1 });
    editing.controller.dispose();

    const releaseFallback = fixture();
    releaseFallback.controller.setTool({ tool: 'select' });
    releaseFallback.controller.setSelection({ x: 0, y: 0 });
    releaseFallback.controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'touch' });
    releaseFallback.controller.handlePointerUp({ ...pointer(1, 40, 8), pointerType: 'touch' });
    expect(releaseFallback.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(releaseFallback.controller.getSelection()).toEqual({ x: 0, y: 0, width: 3, height: 1 });
    releaseFallback.controller.dispose();

    const movementOnly = fixture();
    movementOnly.controller.setTool({ tool: 'select' });
    movementOnly.controller.setSelection({ x: 0, y: 0 });
    const before = movementOnly.uiStore.getState().viewport;
    movementOnly.controller.setTouchMovementOnly(true);
    movementOnly.controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'touch' });
    movementOnly.controller.handlePointerUp({ ...pointer(1, 40, 8), pointerType: 'touch' });
    expect(movementOnly.uiStore.getState().viewport).not.toEqual(before);
    expect(movementOnly.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    movementOnly.controller.dispose();
  });

  it('cancels selected-cell candidates before and after movement fallback', () => {
    const beforeCancel = fixture();
    beforeCancel.controller.setTool({ tool: 'select' });
    beforeCancel.controller.setSelection({ x: 0, y: 0 });
    beforeCancel.controller.handlePointerDown(pointer(1, 8, 8));
    beforeCancel.controller.handlePointerCancel(pointer(1, 8, 8));
    expect(beforeCancel.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(beforeCancel.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    beforeCancel.controller.handlePointerDown(pointer(2, 8, 8));
    beforeCancel.controller.handlePointerLostCapture(pointer(2, 8, 8));
    expect(beforeCancel.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    beforeCancel.controller.dispose();

    const afterFallback = fixture();
    afterFallback.controller.setTool({ tool: 'select' });
    afterFallback.controller.setSelection({ x: 0, y: 0 });
    afterFallback.controller.handlePointerDown(pointer(1, 8, 8));
    afterFallback.controller.handlePointerMove(pointer(1, 40, 8));
    afterFallback.controller.handlePointerCancel(pointer(1, 40, 8));
    expect(afterFallback.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    afterFallback.controller.handlePointerDown(pointer(2, 8, 8));
    afterFallback.controller.handlePointerMove(pointer(2, 40, 8));
    afterFallback.controller.handlePointerLostCapture(pointer(2, 40, 8));
    expect(afterFallback.controller.getSelection()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    afterFallback.controller.dispose();
  });

  it('keeps inside-selection two- and three-touch history gestures out of the action menu', () => {
    const undo = fixture();
    undo.controller.setTool({ tool: 'select' });
    undo.controller.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 });
    undo.gateway.execute({ type: 'set-full', x: 7, y: 7, color: 1 });
    undo.controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'touch' });
    undo.controller.handlePointerDown({ ...pointer(2, 24, 8), pointerType: 'touch' });
    undo.controller.handlePointerUp({ ...pointer(2, 24, 8), pointerType: 'touch' });
    undo.controller.handlePointerUp({ ...pointer(1, 8, 8), pointerType: 'touch' });
    expect(undo.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(undo.gateway.getSnapshot().document?.kind[7 * 8 + 7]).toBe(CellKind.Empty);
    undo.controller.dispose();

    const redo = fixture();
    redo.controller.setTool({ tool: 'select' });
    redo.controller.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 });
    redo.gateway.execute({ type: 'set-full', x: 7, y: 7, color: 1 });
    redo.gateway.undo({ projectId: 'project-a', revision: redo.gateway.getSnapshot().revision! });
    redo.controller.handlePointerDown({ ...pointer(1, 8, 8), pointerType: 'touch' });
    redo.controller.handlePointerDown({ ...pointer(2, 24, 8), pointerType: 'touch' });
    redo.controller.handlePointerDown({ ...pointer(3, 40, 8), pointerType: 'touch' });
    redo.controller.handlePointerUp({ ...pointer(3, 40, 8), pointerType: 'touch' });
    redo.controller.handlePointerUp({ ...pointer(2, 24, 8), pointerType: 'touch' });
    redo.controller.handlePointerUp({ ...pointer(1, 8, 8), pointerType: 'touch' });
    expect(redo.uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    expect(redo.gateway.getSnapshot().document?.kind[7 * 8 + 7]).toBe(CellKind.Full);
    redo.controller.dispose();
  });

  it('preserves movement-only pinch and two/three-finger history gestures', () => {
    const undo = fixture();
    undo.controller.setTouchMovementOnly(true);
    undo.controller.setTool({ tool: 'select' });
    undo.controller.setSelection({ x: 0, y: 0 });
    undo.gateway.execute({ type: 'set-full', x: 7, y: 7, color: 1 });
    undo.controller.handlePointerDown({ ...pointer(1, 20, 20), pointerType: 'touch' });
    undo.controller.handlePointerDown({ ...pointer(2, 60, 20), pointerType: 'touch' });
    undo.controller.handlePointerUp({ ...pointer(2, 60, 20), pointerType: 'touch' });
    undo.controller.handlePointerUp({ ...pointer(1, 20, 20), pointerType: 'touch' });
    expect(undo.gateway.getSnapshot().document?.kind[63]).toBe(CellKind.Empty);
    undo.controller.dispose();

    const redo = fixture();
    redo.controller.setTouchMovementOnly(true);
    redo.controller.setTool({ tool: 'select' });
    redo.controller.setSelection({ x: 0, y: 0 });
    redo.gateway.execute({ type: 'set-full', x: 7, y: 7, color: 1 });
    redo.gateway.undo({ projectId: 'project-a', revision: redo.gateway.getSnapshot().revision! });
    redo.controller.handlePointerDown({ ...pointer(1, 20, 20), pointerType: 'touch' });
    redo.controller.handlePointerDown({ ...pointer(2, 60, 20), pointerType: 'touch' });
    redo.controller.handlePointerDown({ ...pointer(3, 40, 60), pointerType: 'touch' });
    redo.controller.handlePointerUp({ ...pointer(2, 60, 20), pointerType: 'touch' });
    redo.controller.handlePointerUp({ ...pointer(1, 20, 20), pointerType: 'touch' });
    redo.controller.handlePointerUp({ ...pointer(3, 40, 60), pointerType: 'touch' });
    expect(redo.gateway.getSnapshot().document?.kind[63]).toBe(CellKind.Full);
    redo.controller.dispose();

    const pinch = fixture();
    pinch.controller.setTouchMovementOnly(true);
    pinch.controller.setTool({ tool: 'select' });
    pinch.controller.setSelection({ x: 0, y: 0 });
    const before = pinch.uiStore.getState().viewport;
    pinch.controller.handlePointerDown({ ...pointer(1, 20, 20), pointerType: 'touch' });
    pinch.controller.handlePointerDown({ ...pointer(2, 60, 20), pointerType: 'touch' });
    pinch.controller.handlePointerMove({ ...pointer(2, 100, 20), pointerType: 'touch' });
    expect(pinch.uiStore.getState().viewport).not.toEqual(before);
    pinch.controller.handlePointerUp({ ...pointer(1, 20, 20), pointerType: 'touch' });
    pinch.controller.handlePointerUp({ ...pointer(2, 100, 20), pointerType: 'touch' });
    pinch.controller.dispose();
  });

  it('runs fill with immutable planes, exposes pending state, and rejects cancellation/project switches', async () => {
    const document = documentWithStitches();
    const { controller, gateway, worker, uiStore } = fixture(document);
    uiStore.setPaletteId(2);
    controller.setTool({ tool: 'fill' });
    const before = gateway.commands.length;
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(controller.isFillPending()).toBe(true);
    expect(uiStore.getState().overlay.fillPending).toBe(true);
    const request = worker.posted.find((message) => (message as { type?: string }).type === 'fill-request') as Parameters<typeof createFillResult>[0];
    worker.emit(createFillResult(request, new Uint32Array([0]), new Uint8Array([1])));
    await Promise.resolve();
    expect(gateway.commands).toHaveLength(before + 1);
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-recolor', fromColor: 1, toColor: 2 });
    expect(uiStore.getState().overlay.fillPending).toBeUndefined();

    uiStore.setPaletteId(1);
    controller.handlePointerDown(pointer(2, 8, 8));
    expect(controller.cancelFill()).toBe(true);
    expect(controller.isFillPending()).toBe(false);
    controller.handlePointerDown(pointer(3, 8, 8));
    const staleRequest = worker.posted.filter((message) => (message as { type?: string }).type === 'fill-request').at(-1) as Parameters<typeof createFillResult>[0];
    gateway.switchProject();
    expect(controller.isFillPending()).toBe(false);
    worker.emit(createFillResult(staleRequest, new Uint32Array([0]), new Uint8Array([1])));
    expect(gateway.commands).toHaveLength(before + 1);
    controller.dispose();
  });

  it('uses the selected palette for contiguous Full recolor regardless of brush geometry', async () => {
    const document = documentWithStitches();
    document.kind[1] = CellKind.Full;
    document.colors.set([1, 0, 0, 0], 4);
    document.completed[1] = 1;
    document.kind[2] = CellKind.Full;
    document.colors.set([2, 0, 0, 0], 8);
    const { controller, gateway, worker, uiStore } = fixture(document);
    uiStore.setPaletteId(2);
    controller.setTool({ tool: 'fill' });
    controller.handlePointerDown(pointer(1, 8, 8));
    const request = worker.posted.find((message) => (message as { type?: string }).type === 'fill-request') as Parameters<typeof createFillResult>[0];
    worker.emit(createFillResult(request, new Uint32Array([0, 1]), new Uint8Array([1, 1])));
    await Promise.resolve();
    expect(gateway.commands.at(-1)).toMatchObject({
      type: 'bulk-recolor',
      indices: new Uint32Array([0, 1]),
      fromColor: 1,
      toColor: 2
    });
    expect(uiStore.getState().overlay.fillPending).toBeUndefined();
    controller.dispose();
  });

  it('recolors a Full region to the selected palette as one undoable operation', async () => {
    const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 1, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' }
    ] });
    document.kind.fill(CellKind.Full);
    document.colors[0] = 1;
    document.colors[4] = 1;
    document.completed[0] = 1;
    const fillClient = createFillWorkerClient({ workerFactory: () => null, requestIdFactory: () => 'controller-fill' });
    const { controller, gateway } = fixture(document, fillClient);

    controller.selectPalette(2);
    controller.setTool({ tool: 'fill' });
    const undoDepthBeforeRecolor = gateway.undoDepth;
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    const committed = gateway.getSnapshot().document!;
    expect(Array.from(committed.colors.slice(0, 8))).toEqual([2, 0, 0, 0, 2, 0, 0, 0]);
    expect(committed.kind.every((kind) => kind === CellKind.Full)).toBe(true);
    expect(committed.completed).toEqual(new Uint8Array([1, 0]));
    expect(gateway.undoDepth).toBe(undoDepthBeforeRecolor + 1);
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-recolor', fromColor: 1, toColor: 2 });

    expect(controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
    expect(gateway.undoDepth).toBe(undoDepthBeforeRecolor);
    expect(gateway.getSnapshot().document?.colors[0]).toBe(1);
    expect(gateway.getSnapshot().document?.completed[0]).toBe(1);
    fillClient.dispose();
    controller.dispose();
  });

  it('pointer-fills legacy quarters and both paired three-quarter axes with captured component masks', async () => {
    const exercise = async (
      document: PatternDocument,
      screenX: number,
      screenY: number,
      expectedStartMask: number,
      expectedFromColor: number,
      beforeColors: readonly number[],
      afterColors: readonly number[],
      completion: number
    ): Promise<void> => {
      const { controller, gateway, worker, uiStore } = fixture(document);
      uiStore.setPaletteId(3);
      controller.setTool({ tool: 'fill' });
      expect(controller.handlePointerDown(pointer(1, screenX, screenY))).toBe(true);
      const request = worker.posted.find((message) => (message as { type?: string }).type === 'fill-request') as Parameters<typeof createFillResult>[0];
      expect(request.startMask).toBe(expectedStartMask);
      // Change the selection while the worker is in flight. The command must
      // use the destination captured when the pointer gesture began.
      uiStore.setPaletteId(1);
      worker.emit(createFillResult(request, new Uint32Array([0]), new Uint8Array([expectedStartMask])));
      await Promise.resolve();
      expect(gateway.commands.at(-1)).toMatchObject({
        type: 'bulk-recolor',
        masks: new Uint8Array([expectedStartMask]),
        fromColor: expectedFromColor,
        toColor: 3
      });
      const committed = gateway.getSnapshot().document!;
      expect(Array.from(committed.colors)).toEqual(afterColors);
      expect(committed.kind[0]).toBe(document.kind[0]);
      expect(committed.completed[0]).toBe(completion);
      expect(gateway.undoDepth).toBe(1);
      expect(controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
      expect(gateway.undoDepth).toBe(0);
      expect(Array.from(gateway.getSnapshot().document!.colors)).toEqual(beforeColors);
      expect(gateway.getSnapshot().document!.completed[0]).toBe(completion);
      controller.dispose();
    };

    const legacy = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ] });
    legacy.kind[0] = CellKind.Quarters;
    legacy.colors.set([1, 2, 1, 2]);
    legacy.completed[0] = 13;
    await exercise(legacy, 12, 4, 2, 2, [1, 2, 1, 2], [1, 3, 1, 2], 13);

    const northwestSoutheast = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ] });
    northwestSoutheast.kind[0] = CellKind.ThreeQuarterPair;
    northwestSoutheast.colors.set([1, 0, 2, 0]);
    northwestSoutheast.completed[0] = 5;
    await exercise(northwestSoutheast, 4, 4, 1, 1, [1, 0, 2, 0], [3, 0, 2, 0], 5);

    const northeastSouthwest = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ] });
    northeastSouthwest.kind[0] = CellKind.ThreeQuarterPair;
    northeastSouthwest.colors.set([0, 1, 0, 2]);
    northeastSouthwest.completed[0] = 10;
    await exercise(northeastSouthwest, 4, 4, 2, 1, [0, 1, 0, 2], [0, 3, 0, 2], 10);
  });

  it('treats a selected-source Full fill as a no-op without starting the worker', () => {
    const document = documentWithStitches();
    const { controller, gateway, worker, uiStore } = fixture(document);
    uiStore.setPaletteId(1);
    controller.setTool({ tool: 'fill' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(true);
    expect(worker.posted).toHaveLength(0);
    expect(gateway.commands).toHaveLength(0);
    expect(uiStore.getState().status).toBe('No change');
    controller.dispose();
  });

  it('treats an empty fill hit as an immediate no-op', () => {
    const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const { controller, gateway, worker, uiStore } = fixture(document);
    uiStore.setPaletteId(1);
    controller.setTool({ tool: 'fill' });
    expect(controller.handlePointerDown(pointer(1, 8, 8))).toBe(false);
    expect(worker.posted).toHaveLength(0);
    expect(gateway.commands).toHaveLength(0);
    controller.dispose();
  });

  it('captures the current palette for successive Full-region recolor fills', async () => {
    const document = documentWithStitches();
    document.palette.push({ ...document.palette[0], id: 3, name: 'Green', color: '#3c6', symbol: 'G' });
    document.nextPaletteId = 4;
    document.kind[1] = CellKind.Full;
    document.colors.set([1, 0, 0, 0], 4);
    document.completed[0] = 1;
    const { controller, gateway, worker, uiStore } = fixture(document);
    uiStore.setPaletteId(2);
    controller.setTool({ tool: 'fill' });

    controller.handlePointerDown(pointer(1, 8, 8));
    let request = worker.posted.filter((message) => (message as { type?: string }).type === 'fill-request').at(-1) as Parameters<typeof createFillResult>[0];
    worker.emit(createFillResult(request, new Uint32Array([0, 1]), new Uint8Array([1, 1])));
    await Promise.resolve();
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-recolor', fromColor: 1, toColor: 2 });

    // The domain recolor command owns this mutation; mirror its result here so
    // the second invocation exercises the next source color in this lane.
    const recolored = gateway.getSnapshot().document!;
    recolored.colors[0] = 2;
    recolored.colors[4] = 2;
    uiStore.setPaletteId(3);
    controller.handlePointerDown(pointer(2, 8, 8));
    request = worker.posted.filter((message) => (message as { type?: string }).type === 'fill-request').at(-1) as Parameters<typeof createFillResult>[0];
    worker.emit(createFillResult(request, new Uint32Array([0, 1]), new Uint8Array([1, 1])));
    await Promise.resolve();
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-recolor', fromColor: 2, toColor: 3 });
    expect(recolored.completed[0]).toBe(1);
    controller.dispose();
  });

  it('creates, hit-selects, snaps, moves, and deletes incomplete backstitches', () => {
    const { controller, gateway } = fixture();
    controller.setTool({ tool: 'backstitch' });
    controller.handlePointerDown(pointer(1, 8, 8));
    controller.handlePointerMove(pointer(1, 40, 24));
    controller.handlePointerUp(pointer(1, 40, 24));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 8 } });
    expect(gateway.getSnapshot().document?.backstitches.completed[0]).toBe(0);

    controller.handlePointerDown(pointer(2, 24, 16));
    expect(controller.getSelectedBackstitchId()).toBe(1);
    controller.handlePointerUp(pointer(2, 24, 16));
    controller.handlePointerDown(pointer(3, 40, 24));
    controller.handlePointerMove(pointer(3, 56, 24));
    controller.handlePointerUp(pointer(3, 56, 24));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'move-backstitch', id: 1, end: { x: 12, y: 8 } });
    expect(gateway.getSnapshot().document?.backstitches.completed[0]).toBe(0);
    controller.handleKeyDown({ key: 'Backspace', preventDefault: () => undefined });
    expect(gateway.getSnapshot().document?.backstitches.ids).toHaveLength(0);
    controller.dispose();
  });

  it('rejects out-of-document backstitch starts and uses the final pointer-up sample', () => {
    const { controller, gateway } = fixture();
    controller.setTool({ tool: 'backstitch' });
    expect(controller.handlePointerDown(pointer(1, -8, 8))).toBe(false);
    expect(gateway.commands).toHaveLength(0);
    controller.handlePointerDown(pointer(2, 8, 8));
    controller.handlePointerUp(pointer(2, 40, 24));
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 8 } });
    controller.dispose();
  });

  it('supports keyboard backstitch anchor/finish, zero-length prevention, cancel, and undo/redo', () => {
    const first = fixture();
    first.controller.setTool({ tool: 'backstitch' });
    first.uiStore.setKeyboardCursor({ x: 1, y: 1 });
    first.controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(first.gateway.commands).toHaveLength(0);
    expect(first.uiStore.getState().status).toContain('Backstitch start anchored at (4, 4)');
    first.controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(first.gateway.commands).toHaveLength(0);
    expect(first.uiStore.getState().status).toContain('Move the cursor');
    first.controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    first.controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    expect(first.gateway.commands.at(-1)).toMatchObject({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 4 } });
    expect(first.uiStore.getState().status).toBe('Created backstitch');
    first.controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(first.gateway.getSnapshot().document?.backstitches.ids).toHaveLength(0);
    first.controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: () => undefined });
    expect(first.gateway.getSnapshot().document?.backstitches.ids).toHaveLength(1);
    first.controller.dispose();

    const cancelled = fixture();
    cancelled.controller.setTool({ tool: 'backstitch' });
    cancelled.uiStore.setKeyboardCursor({ x: 1, y: 1 });
    cancelled.controller.handleKeyDown({ key: 'Enter', preventDefault: () => undefined });
    cancelled.controller.handleKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(cancelled.gateway.commands).toHaveLength(0);
    expect(cancelled.uiStore.getState().overlay.backstitchPreview).toBeUndefined();
    expect(cancelled.uiStore.getState().status).toBe('Backstitch start cancelled');
    cancelled.controller.dispose();
  });

  it('isolates clipboard storage and clamps an oversized destination without throwing', () => {
    const { controller, gateway, uiStore } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    const copied = controller.copySelection();
    expect(copied).toBeDefined();
    copied!.kind[0] = CellKind.Full;
    copied!.colors[0] = 2;
    expect(controller.getClipboard()?.kind[0]).toBe(CellKind.Full);
    expect(controller.getClipboard()?.colors[0]).toBe(1);
    controller.setSelection({ x: 7, y: 7 });
    const beforeRevision = gateway.getSnapshot().revision;
    expect(controller.pasteClipboard()).toBe(true);
    expect(gateway.getSnapshot().revision).toBe(beforeRevision);
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ destination: { x: 6, y: 6, width: 2, height: 2 } });
    controller.dispose();
  });

  it('does not dispose an injected shared fill client with its controller', async () => {
    const worker = new FakeWorker();
    const shared = createFillWorkerClient({ workerFactory: () => worker, requestIdFactory: () => 'shared-request' });
    const first = fixture(documentWithStitches(), shared);
    first.controller.dispose();
    const job = shared.submit({
      projectId: 'project-a',
      baseRevision: 0,
      width: 2,
      height: 2,
      startIndex: 0,
      startMask: 1,
      kind: Uint8Array.from([CellKind.Full, 0, 0, 0]),
      colors: Uint16Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    });
    const request = worker.posted.find((message) => (message as { type?: string }).type === 'fill-request') as Parameters<typeof createFillResult>[0];
    worker.emit(createFillResult(request, new Uint32Array([0]), new Uint8Array([1])));
    await expect(job.promise).resolves.toMatchObject({ requestId: 'shared-request' });
    shared.dispose();
  });

  it('keeps bounded selection interactions practical on a 500×500 document', () => {
    const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 500, height: 500, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
    const { controller } = fixture(document);
    controller.setSelection({ x: 499, y: 499 }, { x: 0, y: 0 });
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    controller.clearSelection();
    controller.dispose();
  });
});
