import { describe, expect, it } from 'vitest';
import {
  CellKind,
  createDocument,
  createEditor,
  type CommandResult,
  type DomainCommand,
  type PatternDocument
} from '../domain';
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
    this.editor = createEditor(createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
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
  const editor = createEditor(createDocument({ width: 8, height: 8, palette: [
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
    const editor = createEditor(createDocument({ width: 2, height: 2, palette: [
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
    controller.handlePointerUp({ ...pointer(3, 24, 8), shiftKey: false });
    expect(controller.getSelectionIndices()).toEqual(new Uint32Array([0, 1, 2, 8, 9, 10, 16, 17, 18]));

    controller.handlePointerDown({ ...pointer(4, 24, 8), shiftKey: true, altKey: true });
    controller.handlePointerUp({ ...pointer(4, 24, 8), shiftKey: false, altKey: false });
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

    sparse.gateway.replaceDocument(createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    expect(sparse.controller.getSelection()).toBeUndefined();
    expect(sparse.controller.getSelectionIndices()).toBeUndefined();
    expect(sparse.uiStore.getState().overlay.selection).toBeUndefined();
    expect(sparse.controller.copySelection()).toBeUndefined();
    expect(sparse.controller.deleteSelection()).toBe(false);
    sparse.controller.dispose();

    const legacy = fixture();
    legacy.controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });
    expect(legacy.controller.getSelection()).toEqual({ x: 1, y: 1, width: 2, height: 2 });
    legacy.gateway.replaceDocument(createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    expect(legacy.controller.getSelection()).toBeUndefined();
    expect(legacy.uiStore.getState().overlay.selection).toBeUndefined();
    expect(legacy.controller.deleteSelection()).toBe(false);
    legacy.controller.dispose();

    const direct = fixture();
    direct.controller.setSelection({ x: 1, y: 1 });
    direct.controller.setDocument(createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    expect(direct.controller.getSelection()).toBeUndefined();
    expect(direct.uiStore.getState().overlay.selection).toBeUndefined();
    direct.controller.dispose();

    const cropped = fixture();
    cropped.controller.setSelection({ x: 1, y: 1 });
    cropped.gateway.execute({ type: 'crop', x: 0, y: 0, width: 4, height: 4 });
    expect(cropped.controller.getSelection()).toBeUndefined();
    cropped.controller.dispose();

    const rotated = fixture(createDocument({ width: 8, height: 4, palette: [{ id: 1, name: 'Thread', color: '#123456' }] }));
    rotated.controller.setSelection({ x: 1, y: 1 });
    rotated.gateway.execute({ type: 'rotate-cw' });
    expect(rotated.controller.getSelection()).toBeUndefined();
    rotated.controller.dispose();
  });

  it('copies a local transparent fragment without completion and pastes in one transaction', () => {
    const { controller, gateway } = fixture();
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 });
    expect(controller.handleKeyDown({ key: 'c', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
    expect(controller.getClipboard()).toBeDefined();
    expect('completed' in (controller.getClipboard() ?? {})).toBe(false);
    controller.clearSelection();
    controller.handleKeyDown({ key: 'ArrowRight', preventDefault: () => undefined });
    const before = gateway.commands.length;
    expect(controller.handleKeyDown({ key: 'v', ctrlKey: true, preventDefault: () => undefined })).toBe(true);
    expect(gateway.commands).toHaveLength(before + 1);
    expect(gateway.commands.at(-1)?.type).toBe('paste-fragment');
    expect(gateway.getSnapshot().document?.completed[1]).toBe(0);
    controller.handleBlur();
    expect(controller.handleKeyDown({ key: 'c', ctrlKey: true })).toBe(false);
    gateway.switchProject();
    expect(controller.getClipboard()).toBeUndefined();
    controller.dispose();
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
    const document = createDocument({ width: 2, height: 1, palette: [
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

    const legacy = createDocument({ width: 1, height: 1, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ] });
    legacy.kind[0] = CellKind.Quarters;
    legacy.colors.set([1, 2, 1, 2]);
    legacy.completed[0] = 13;
    await exercise(legacy, 12, 4, 2, 2, [1, 2, 1, 2], [1, 3, 1, 2], 13);

    const northwestSoutheast = createDocument({ width: 1, height: 1, palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ] });
    northwestSoutheast.kind[0] = CellKind.ThreeQuarterPair;
    northwestSoutheast.colors.set([1, 0, 2, 0]);
    northwestSoutheast.completed[0] = 5;
    await exercise(northwestSoutheast, 4, 4, 1, 1, [1, 0, 2, 0], [3, 0, 2, 0], 5);

    const northeastSouthwest = createDocument({ width: 1, height: 1, palette: [
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
    const document = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
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

  it('isolates clipboard storage and reports an out-of-bounds paste without throwing', () => {
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
    expect(controller.pasteClipboard()).toBe(false);
    expect(gateway.getSnapshot().revision).toBe(beforeRevision);
    expect(uiStore.getState().status).toBe('Paste unavailable');
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
    const document = createDocument({ width: 500, height: 500, palette: [{ id: 1, name: 'Thread', color: '#123456' }] });
    const { controller } = fixture(document);
    controller.setSelection({ x: 499, y: 499 }, { x: 0, y: 0 });
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    controller.clearSelection();
    controller.dispose();
  });
});
