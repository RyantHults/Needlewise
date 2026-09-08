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
    const { controller, gateway, worker, uiStore } = fixture();
    controller.setTool({ tool: 'fill', brush: { kind: 'full', paletteId: 2 } });
    const before = gateway.commands.length;
    controller.handlePointerDown(pointer(1, 8, 8));
    expect(controller.isFillPending()).toBe(true);
    expect(uiStore.getState().overlay.fillPending).toBe(true);
    const request = worker.posted.find((message) => (message as { type?: string }).type === 'fill-request') as Parameters<typeof createFillResult>[0];
    controller.setTool({ tool: 'fill', brush: { kind: 'full', paletteId: 1 } });
    worker.emit(createFillResult(request, new Uint32Array([0, 1])));
    await Promise.resolve();
    expect(gateway.commands).toHaveLength(before + 1);
    expect(gateway.commands.at(-1)).toMatchObject({ type: 'bulk-cell', edit: { kind: 'full', color: 2 } });
    expect(uiStore.getState().overlay.fillPending).toBeUndefined();

    controller.handlePointerDown(pointer(2, 8, 8));
    expect(controller.cancelFill()).toBe(true);
    expect(controller.isFillPending()).toBe(false);
    controller.handlePointerDown(pointer(3, 8, 8));
    const staleRequest = worker.posted.filter((message) => (message as { type?: string }).type === 'fill-request').at(-1) as Parameters<typeof createFillResult>[0];
    gateway.switchProject();
    expect(controller.isFillPending()).toBe(false);
    worker.emit(createFillResult(staleRequest, new Uint32Array([0])));
    expect(gateway.commands).toHaveLength(before + 1);
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
      kind: new Uint8Array(4),
      colors: new Uint16Array(16)
    });
    const request = worker.posted.find((message) => (message as { type?: string }).type === 'fill-request') as Parameters<typeof createFillResult>[0];
    worker.emit(createFillResult(request, new Uint32Array([0])));
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
