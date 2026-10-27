import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CellKind, createDocument, type PatternDocument } from '../../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../../catalog';
import type { ProjectWorkspace } from '../../application/workspace';
import { PatternViewer } from './PatternViewer';

// The real UI store runs; the controller, renderer and pointer adapter are stand-ins
// that record the order the canvas is started and torn down in.
const f = vi.hoisted(() => {
  const calls: string[] = [];
  const controller = {
    start: vi.fn(() => calls.push('start')),
    setMetrics: vi.fn(),
    handleKeyDown: vi.fn((sample: { key: string }) => calls.push(`key ${sample.key}`)),
    setDocument: vi.fn(),
    setTool: vi.fn(),
    setHighlightColor: vi.fn(),
    dispose: vi.fn(() => calls.push('controller dispose'))
  };
  return {
    calls,
    controller,
    renderer: { setStyle: vi.fn(), dispose: vi.fn(() => calls.push('renderer dispose')) },
    createRenderer: vi.fn(),
    controllerOptions: null as Record<string, unknown> | null
  };
});
vi.mock('../../rendering/context', () => ({ createCanvasTarget: vi.fn(() => ({ context: {} })) }));
vi.mock('../../rendering/renderer', () => ({ createCanvasRenderer: f.createRenderer }));
vi.mock('../../editor', async () => {
  const actual = await vi.importActual<typeof import('../../editor')>('../../editor');
  return {
    ...actual,
    createWorkspaceEditorGateway: vi.fn(() => ({ dispose: vi.fn(() => f.calls.push('gateway dispose')) })),
    createPointerEventsAdapter: vi.fn(() => ({ dispose: vi.fn(() => f.calls.push('adapter dispose')) })),
    createEditorSurfaceController: vi.fn((options: Record<string, unknown>) => {
      f.controllerOptions = options;
      const store = options.uiStore as { subscribe: (listener: unknown) => () => void };
      const subscribe = store.subscribe.bind(store);
      store.subscribe = (listener) => {
        const unsubscribe = subscribe(listener);
        return () => {
          f.calls.push('unsubscribe');
          unsubscribe();
        };
      };
      return f.controller;
    })
  };
});

const workspace = { availableCatalogs: () => [] } as unknown as ProjectWorkspace;

function twoColorPattern(): PatternDocument {
  return createDocument({
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    width: 3,
    height: 2,
    palette: [
      { id: 1, name: 'Ruby', color: '#AA0000' },
      { id: 2, name: 'Sky', color: '#0000AA' }
    ]
  });
}

function pattern(): PatternDocument {
  return createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 3, height: 2, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  f.calls.length = 0;
  f.controllerOptions = null;
  f.createRenderer.mockImplementation(() => f.renderer);
});

describe('PatternViewer', () => {
  it('starts a read-only controller, fits the pattern, and hands it and the UI state to the page', () => {
    const onReady = vi.fn();
    const onUiState = vi.fn();
    render(<PatternViewer workspace={workspace} document={pattern()} showCompletion onReady={onReady} onUiState={onUiState} />);

    expect(f.controllerOptions).toMatchObject({ readOnly: true });
    expect(f.createRenderer).toHaveBeenCalledWith(expect.objectContaining({ style: { showCompletion: true } }));
    expect(f.calls).toEqual(['start', 'key 0']);
    expect(onReady).toHaveBeenCalledWith(f.controller);
    expect(onUiState).toHaveBeenCalledWith(expect.objectContaining({ tool: { tool: 'pan' }, paletteId: null }));
    expect(screen.getByRole('group', { name: 'Pattern preview canvas' })).toHaveClass('canvas-frame', 'viewer-canvas');
  });

  it('passes document, style, tool and highlight changes to the running canvas', () => {
    const view = render(<PatternViewer workspace={workspace} document={pattern()} />);
    const next = pattern();
    view.rerender(<PatternViewer workspace={workspace} document={next} showCenterMark tool="mark" highlightColor={1} />);

    expect(f.controller.setDocument).toHaveBeenLastCalledWith(next, { layer: 'all', full: true, reason: 'external-document' });
    expect(f.renderer.setStyle).toHaveBeenCalledWith({ showCenterMark: true });
    expect(f.controller.setTool).toHaveBeenLastCalledWith({ tool: 'mark' });
    expect(f.controller.setHighlightColor).toHaveBeenLastCalledWith(1);
  });

  it('names the stitch under the pointer', () => {
    const document = pattern();
    document.kind[1] = 1;
    document.colors[4] = 1;
    render(<PatternViewer workspace={workspace} document={document} />);
    const frame = screen.getByRole('group', { name: 'Pattern preview canvas' });

    // The store's default viewport draws a cell 16 pixels wide from the origin.
    fireEvent.pointerMove(frame, { clientX: 20, clientY: 4 });
    expect(screen.getByText(/#AA0000 Ruby · Full stitch · column 2, row 1/)).toBeInTheDocument();
    fireEvent.pointerLeave(frame);
    expect(screen.queryByText(/column 2/)).not.toBeInTheDocument();
  });

  it('reports the triangle of a three-quarter pair under the pointer', () => {
    const document = twoColorPattern();
    document.kind[1] = CellKind.ThreeQuarterPair;
    document.colors[5] = 1;
    document.colors[7] = 2;
    render(<PatternViewer workspace={workspace} document={document} />);
    const frame = screen.getByRole('group', { name: 'Pattern preview canvas' });

    fireEvent.pointerMove(frame, { clientX: 28, clientY: 2 });
    expect(screen.getByText(/#AA0000 Ruby · Three-quarter stitch · column 2, row 1/)).toBeInTheDocument();
    fireEvent.pointerMove(frame, { clientX: 20, clientY: 14 });
    expect(screen.getByText(/#0000AA Sky · Three-quarter stitch · column 2, row 1/)).toBeInTheDocument();
  });

  it('unsubscribes and tells the page the controller is gone before disposing it', () => {
    const onReady = vi.fn((controller: unknown) => f.calls.push(controller ? 'ready' : 'ready null'));
    const view = render(<PatternViewer workspace={workspace} document={pattern()} onReady={onReady} />);
    f.calls.length = 0;
    view.unmount();

    expect(f.calls).toEqual(['unsubscribe', 'ready null', 'adapter dispose', 'controller dispose', 'gateway dispose', 'renderer dispose']);
  });

  it('shows the fallback message when the canvas cannot be created', () => {
    f.createRenderer.mockImplementation(() => {
      throw new Error('no canvas');
    });
    render(<PatternViewer workspace={workspace} document={pattern()} />);

    expect(screen.getByText(/Canvas preview is unavailable/)).toBeInTheDocument();
  });
});
