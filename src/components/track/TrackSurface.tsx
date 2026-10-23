import { useEffect, useRef, useState } from 'react';
import { type PaletteEntry, type PatternDocument, type PatternMetrics } from '../../domain';
import type { EditorSurfaceController, EditorUiState } from '../../editor';
import type { ProjectWorkspace } from '../../application/workspace';
import { paletteProgress } from '../../application/progress';
import type { PatternView } from '../editor/ViewSwitch';
import { ViewSettings } from '../editor/ViewSettings';
import { CanvasControls } from '../editor/CanvasControls';
import { ActionSection } from '../editor/ActionSection';
import { PatternHeader } from '../editor/PatternHeader';
import { paletteCodeFor } from '../editor/palette-code';
import { patternDimensionInfo } from '../editor/pattern-dimensions';
import { usePatternDialogs } from '../editor/pattern-dialogs';
import { useEditorPreferences } from '../editor/editor-preferences';
import { DockPopover, useMobileDock } from '../editor/mobile-dock';
import { ToolButton } from '../controls/ToolButton';
import { PatternViewer } from './PatternViewer';
import { ProgressStrip, progressPercent } from './ProgressStrip';
import { TrackPalette } from './TrackPalette';
import panIcon from '../../assets/editor-tools/pan.svg';
import markIcon from '../../assets/editor-tools/mark.svg';
import './track.css';

type TrackTool = 'pan' | 'mark';

interface Props {
  workspace: ProjectWorkspace;
  /** The flattened visible composite. */
  document: PatternDocument;
  title: string;
  metrics: PatternMetrics | null;
  onNavigate?: (view: PatternView) => void;
  onRenameTitle?: (title: string) => void;
}

/**
 * The Track page: mark stitches done while stitching. It shares the editor's
 * layout, tool actions, view settings, canvas controls and mobile dock. Marks
 * change only stitch progress, never the pattern, and their undo history
 * lasts while this page is open.
 */
export function TrackSurface({ workspace, document, title, metrics, onNavigate, onRenameTitle }: Props) {
  const [tool, setTool] = useState<TrackTool>('mark');
  const [highlightColor, setHighlightColor] = useState<number | null>(null);
  const [ui, setUi] = useState<EditorUiState | null>(null);
  const controllerRef = useRef<EditorSurfaceController | null>(null);
  const [preferences, setPreferences] = useEditorPreferences(workspace);
  const { openExport, openSettings, dialogs } = usePatternDialogs({ workspace, document, title, preferences, onPreferencesChange: setPreferences, editorOptions: 'placement' });
  const railSide = preferences.railSide;
  const dock = useMobileDock();

  // Track's mark history never outlives the page, so it never holds marks from before an edit.
  useEffect(() => () => workspace.clearMarkHistory(), [workspace]);

  const focused = highlightColor !== null ? document.palette.find((entry) => entry.id === highlightColor) ?? null : null;
  const progress = metrics ? paletteProgress(metrics, focused?.id ?? null) : null;
  const dimensionSummary = patternDimensionInfo(workspace, document).summary;
  const catalogs = workspace.availableCatalogs();
  const codeFor = (entry: PaletteEntry) => paletteCodeFor(entry, document.palette, catalogs).label;
  const focusedCode = focused ? codeFor(focused) : 'Total';
  const focusedPercent = progress ? progressPercent(progress.completedComponents, progress.totalComponents) : 0;
  const triggerLabel = `Color completion: ${focusedCode}, ${focusedPercent}% done`;

  return (
    <section className="editor-workspace track-workspace" aria-labelledby="track-title">
      <PatternHeader
        titleId="track-title"
        title={title}
        onRenameTitle={onRenameTitle}
        view="track"
        info={<p className="editor-dimensions">{dimensionSummary}</p>}
        onNavigate={onNavigate}
        undo={{ label: 'Undo mark', disabled: !workspace.canUndoMark, onClick: () => workspace.undoMark() }}
        redo={{ label: 'Redo mark', disabled: !workspace.canRedoMark, onClick: () => workspace.redoMark() }}
        onExport={openExport}
        onSettings={openSettings}
      />
      <div className={`editor-layout track-layout rail-${railSide}`}>
        <aside ref={dock.dockRef} className="editor-rail-shell" aria-label="Track controls">
          <DockPopover dock={dock} panel="colors">
            <div className="track-colors">
              <ProgressStrip label={focused?.name ?? 'All colors'} code={focused ? codeFor(focused) : undefined} color={focused?.color} completed={progress?.completedComponents ?? 0} total={progress?.totalComponents ?? 0} />
              <TrackPalette codeFor={codeFor} palette={document.palette} metrics={metrics} focused={focused?.id ?? null} onFocus={setHighlightColor} />
            </div>
          </DockPopover>
        </aside>
        <div className="canvas-column">
          <div className="canvas-actions">
            <ActionSection id="tool-actions-label" label="Tools" className="track-tools">
              <div role="group" aria-label="Track tools">
                <ToolButton label="Pan" pressed={tool === 'pan'} onClick={() => setTool('pan')}>
                  <img data-icon="pan" src={panIcon} alt="" aria-hidden="true" />
                </ToolButton>
                <ToolButton label="Mark" pressed={tool === 'mark'} onClick={() => setTool('mark')}>
                  <img data-icon="mark" src={markIcon} alt="" aria-hidden="true" />
                </ToolButton>
              </div>
            </ActionSection>
            <ViewSettings
              mode={ui?.mode}
              threadView={ui?.threadView ?? false}
              onChartMode={(mode) => controllerRef.current?.setChartMode(mode)}
              onThreadView={() => controllerRef.current?.setThreadView(true)}
            />
            <CanvasControls onCommand={(key) => controllerRef.current?.handleKeyDown({ key })} />
          </div>
          <PatternViewer
            workspace={workspace}
            document={document}
            showCompletion
            showCenterMark={preferences.showCenterMark}
            tool={tool}
            highlightColor={focused?.id ?? null}
            onReady={(controller) => { controllerRef.current = controller; }}
            onUiState={setUi}
          />
          <p className="mobile-dock-title">Color completion</p>
          <div className="mobile-dock-card">
            <div className="mobile-dock-triggers" aria-label="Open track controls">
              <button ref={dock.colorsTriggerRef} className="mobile-dock-trigger mobile-colors-trigger mobile-completion-trigger" type="button" aria-label={triggerLabel} title={triggerLabel} aria-expanded={dock.panel === 'colors'} aria-controls="mobile-colors-popover" onClick={() => dock.setPanel(dock.panel === 'colors' ? null : 'colors')}>
                {focused && <span className="mobile-dock-color-swatch" style={{ backgroundColor: focused.color }} aria-hidden="true" />}
                <span className="mobile-completion-code" aria-hidden="true">{focusedCode}</span>
                <span className="mobile-completion-percent" aria-hidden="true">{focusedPercent}%</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      {dialogs}
    </section>
  );
}
