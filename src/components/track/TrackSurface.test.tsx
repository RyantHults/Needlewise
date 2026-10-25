import { act, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computePatternMetrics, createDocument, type PatternDocument } from '../../domain';
import { markCellComplete, applyCommand, cell } from '../../domain/test-fixtures';
import { DEFAULT_CATALOG_DEFINITION } from '../../catalog';
import type { ProjectWorkspace } from '../../application/workspace';
import { ChartPresentationMode, type EditorUiState } from '../../editor';
import { TrackSurface } from './TrackSurface';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: MemoryRouter });

// The export and settings dialogs have their own suites; here only that the page opens them.
vi.mock('../export/ExportPanel', () => ({
  ExportDialog: ({ title, onClose }: { title: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Export stub">{title}<button type="button" onClick={onClose}>Close export</button></div>
  )
}));
vi.mock('../editor/PatternSettingsDialog', () => ({
  PatternSettingsDialog: ({ editorOptions, onClose }: { editorOptions: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Settings stub" data-options={editorOptions}><button type="button" onClick={onClose}>Close settings</button></div>
  )
}));
vi.mock('../export/export-pdf', () => ({ createExportPdf: () => vi.fn() }));

// The canvas viewer is covered by the controller and renderer suites; here it
// records what the page asks of it and hands the page a stand-in controller.
const viewer = vi.hoisted(() => ({
  props: [] as Record<string, unknown>[],
  controller: { setChartMode: vi.fn(), setThreadView: vi.fn(), handleKeyDown: vi.fn() }
}));
vi.mock('./PatternViewer', () => ({
  PatternViewer: (props: { onReady?: (controller: unknown) => void } & Record<string, unknown>) => {
    viewer.props.push(props);
    useEffect(() => {
      props.onReady?.(viewer.controller);
    }, []);
    return <div data-testid="pattern-viewer" />;
  }
}));

const lastViewerProps = () => viewer.props[viewer.props.length - 1];
const publishUiState = (state: Partial<EditorUiState>) =>
  act(() => (lastViewerProps().onUiState as (state: EditorUiState) => void)(state as EditorUiState));

function trackedDocument(): PatternDocument {
  let pattern = createDocument({
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    width: 3,
    height: 2,
    palette: [
      { id: 7, name: 'Ruby', color: '#AA0000' },
      { id: 2, name: 'Sky', color: '#3366CC' },
      { id: 4, name: 'Unused', color: '#00AA00' }
    ]
  });
  const apply = (command: Parameters<typeof applyCommand>[1]) => {
    pattern = applyCommand(pattern, command).document;
  };
  for (let x = 0; x < 3; x += 1) apply(cell(3, { type: 'set-full', x, y: 0, color: 7 }));
  apply(cell(3, { type: 'set-full', x: 0, y: 1, color: 7 }));
  apply(cell(3, { type: 'set-full', x: 1, y: 1, color: 2 }));
  apply(cell(3, { type: 'set-full', x: 2, y: 1, color: 2 }));
  for (const [x, y] of [[0, 0], [1, 1], [2, 1]]) pattern = markCellComplete(pattern, x, y);
  return pattern;
}

function setup(progressState: { canUndoMark?: boolean; canRedoMark?: boolean } = {}, onRenameTitle?: (title: string) => void) {
  const workspace = {
    canUndoMark: progressState.canUndoMark ?? false,
    canRedoMark: progressState.canRedoMark ?? false,
    undoMark: vi.fn(),
    redoMark: vi.fn(),
    clearMarkHistory: vi.fn(),
    availableCatalogs: () => []
  };
  const document = trackedDocument();
  const onNavigate = vi.fn();
  const view = render(
    <TrackSurface workspace={workspace as unknown as ProjectWorkspace} document={document} title="Garden sampler" metrics={computePatternMetrics(document)} onNavigate={onNavigate} onRenameTitle={onRenameTitle} />
  );
  return { workspace, onNavigate, view };
}

beforeEach(() => {
  viewer.props.length = 0;
  vi.clearAllMocks();
});

describe('TrackSurface', () => {
  it('shows overall progress and opens with the Mark tool and completion drawn', () => {
    setup();

    const strip = screen.getByRole('region', { name: 'Progress' });
    expect(strip).toHaveTextContent('All colors');
    expect(strip).toHaveTextContent('50%');
    expect(strip).toHaveTextContent('3 of 6 stitches done');
    expect(screen.getByRole('button', { name: 'Mark' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastViewerProps()).toMatchObject({ tool: 'mark', showCompletion: true, highlightColor: null });
  });

  it('lists only the colors in use, each with its percent', () => {
    setup();

    const colors = screen.getByRole('list', { name: 'Colors' });
    expect(within(colors).getByRole('button', { name: '#AA0000 Ruby, 25% done' })).toBeInTheDocument();
    expect(within(colors).getByRole('button', { name: '#3366CC Sky, 100% done' })).toBeInTheDocument();
    expect(within(colors).queryByRole('button', { name: /^Unused/ })).not.toBeInTheDocument();
  });

  it('focuses a color on tap, shows its percent, and clears it on a second tap', () => {
    setup();
    const ruby = screen.getByRole('button', { name: '#AA0000 Ruby, 25% done' });

    fireEvent.click(ruby);
    expect(ruby).toHaveAttribute('aria-pressed', 'true');
    expect(lastViewerProps()).toMatchObject({ highlightColor: 7 });
    const strip = screen.getByRole('region', { name: 'Progress' });
    expect(strip).toHaveTextContent('#AA0000 · Ruby');
    expect(strip).toHaveTextContent('25%');
    expect(strip).toHaveTextContent('1 of 4 stitches done');

    fireEvent.click(ruby);
    expect(ruby).toHaveAttribute('aria-pressed', 'false');
    expect(lastViewerProps()).toMatchObject({ highlightColor: null });
    expect(screen.getByRole('region', { name: 'Progress' })).toHaveTextContent('All colors');
  });

  it('switches between Pan and Mark from the Tools section of the canvas actions', () => {
    setup();
    const tools = screen.getByRole('region', { name: 'Tools' });
    const pan = within(tools).getByRole('button', { name: 'Pan' });

    fireEvent.click(pan);
    expect(pan).toHaveAttribute('aria-pressed', 'true');
    expect(lastViewerProps()).toMatchObject({ tool: 'pan' });
    fireEvent.click(within(tools).getByRole('button', { name: 'Mark' }));
    expect(within(tools).getByRole('button', { name: 'Mark' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastViewerProps()).toMatchObject({ tool: 'mark' });
  });

  it("drives view settings through the viewer's controller and shows its UI state", () => {
    setup();
    const view = screen.getByRole('group', { name: 'View settings' });

    fireEvent.click(within(view).getByRole('button', { name: 'Symbol' }));
    expect(viewer.controller.setChartMode).toHaveBeenCalledWith(ChartPresentationMode.Symbol);
    fireEvent.click(within(view).getByRole('button', { name: 'Render' }));
    expect(viewer.controller.setThreadView).toHaveBeenCalledWith(true);

    publishUiState({ mode: ChartPresentationMode.Symbol, threadView: false });
    expect(within(view).getByRole('button', { name: 'Symbol' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(view).getByRole('button', { name: 'Color' })).toHaveAttribute('aria-pressed', 'false');
    publishUiState({ mode: ChartPresentationMode.Symbol, threadView: true });
    expect(within(view).getByRole('button', { name: 'Render' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(view).getByRole('button', { name: 'Symbol' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('zooms with the canvas controls', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(viewer.controller.handleKeyDown.mock.calls.map(([event]) => event)).toEqual([{ key: '+' }, { key: '-' }, { key: '0' }]);
  });

  it('opens the Colors popover from the mobile completion button', () => {
    setup();
    const total = screen.getByRole('button', { name: 'Color completion: Total, 50% done' });

    fireEvent.click(total);
    expect(total).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('dialog', { name: 'Colors' })).getByRole('list', { name: 'Colors' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(total).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the focused color code, swatch and percent on the mobile completion button', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: '#AA0000 Ruby, 25% done' }));
    const trigger = screen.getByRole('button', { name: 'Color completion: #AA0000, 25% done' });
    expect(trigger).toHaveTextContent('#AA0000');
    expect(trigger).toHaveTextContent('25%');
  });

  it('opens the export and settings dialogs from the header', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Export pattern' }));
    expect(screen.getByRole('dialog', { name: 'Export stub' })).toHaveTextContent('Garden sampler');
    fireEvent.click(screen.getByRole('button', { name: 'Close export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings stub' })).toHaveAttribute('data-options', 'placement');
  });

  it('shows the same dimension summary as the editor in the header', () => {
    setup();

    expect(screen.getByText('3 × 2 stitches · 0.54 cm × 0.36 cm')).toBeInTheDocument();
  });

  it('renames the pattern from the header title', () => {
    const onRenameTitle = vi.fn();
    setup({}, onRenameTitle);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Garden sampler' }));
    const input = screen.getByRole('textbox', { name: 'Rename pattern Garden sampler' });
    fireEvent.change(input, { target: { value: 'Winter sampler' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameTitle).toHaveBeenCalledWith('Winter sampler');
  });

  it('undoes and redoes marks through the workspace', () => {
    const { workspace } = setup({ canUndoMark: true, canRedoMark: true });

    fireEvent.click(screen.getByRole('button', { name: 'Undo mark' }));
    expect(workspace.undoMark).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Redo mark' }));
    expect(workspace.redoMark).toHaveBeenCalledOnce();
  });

  it('disables undo and redo when there is nothing to replay', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Undo mark' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo mark' })).toBeDisabled();
  });

  it('navigates to Edit from the header switch', () => {
    const { onNavigate } = setup();
    const nav = screen.getByRole('navigation', { name: 'Pattern view' });

    expect(within(nav).getByRole('button', { name: 'Track' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(nav).getByRole('button', { name: 'Edit' }));
    expect(onNavigate).toHaveBeenCalledWith('edit');
  });

  it('clears the Track undo history when the page unmounts', () => {
    const { workspace, view } = setup();

    expect(workspace.clearMarkHistory).not.toHaveBeenCalled();
    view.unmount();
    expect(workspace.clearMarkHistory).toHaveBeenCalledOnce();
  });
});
