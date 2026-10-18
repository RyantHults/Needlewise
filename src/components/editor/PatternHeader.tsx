import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { EditableTitle } from "./EditableTitle";
import { ExportButton, SettingsButton } from "./PatternHeaderActions";
import { ViewSwitch, type PatternView } from "./ViewSwitch";

interface HistoryAction {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

interface Props {
  titleId: string;
  title: string;
  onRenameTitle?: (title: string) => void;
  view: PatternView;
  onNavigate?: (view: PatternView) => void;
  undo: HistoryAction;
  redo: HistoryAction;
  onExport: () => void;
  onSettings: () => void;
  info?: ReactNode;
}

/** The header shared by a pattern's Edit and Track pages. */
export function PatternHeader({ titleId, title, onRenameTitle, view, onNavigate, undo, redo, onExport, onSettings, info }: Props) {
  return (
    <header className="editor-heading">
      <Link className="editor-brand" to="/patterns" aria-label="Needlewise home">
        <span className="brand-mark" aria-hidden="true">
          ✣
        </span>
        <span>Needlewise</span>
      </Link>
      <div className="editor-heading-controls">
        <button className="icon-button" type="button" aria-label={undo.label} title={undo.label} disabled={undo.disabled} onClick={undo.onClick}>
          ↶
        </button>
        <button className="icon-button" type="button" aria-label={redo.label} title={redo.label} disabled={redo.disabled} onClick={redo.onClick}>
          ↷
        </button>
        <ExportButton onClick={onExport} />
        <SettingsButton onClick={onSettings} />
      </div>
      <div className="editor-heading-project">
        {onRenameTitle ? (
          <EditableTitle value={title} headingId={titleId} onCommit={onRenameTitle} />
        ) : (
          <h2 id={titleId}>{title}</h2>
        )}
      </div>
      <div className="editor-heading-info">
        {info}
        <ViewSwitch current={view} onNavigate={onNavigate} />
      </div>
    </header>
  );
}
