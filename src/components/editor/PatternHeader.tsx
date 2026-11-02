import { Link } from "react-router-dom";
import { BrandMark } from "../controls/BrandLink";
import { EditableTitle } from "./EditableTitle";
import { ExportButton, HeaderIconButton, SettingsButton } from "./PatternHeaderActions";
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
  hidden: boolean;
  onToggleHidden: () => void;
}

/** The header shared by a pattern's Edit and Track pages. */
export function PatternHeader({ titleId, title, onRenameTitle, view, onNavigate, undo, redo, onExport, onSettings, hidden, onToggleHidden }: Props) {
  const toggleLabel = hidden ? "Show top bar" : "Hide top bar";
  const toggle = (
    <button type="button" className="pattern-header-toggle" aria-label={toggleLabel} title={toggleLabel} aria-expanded={!hidden} onClick={onToggleHidden}>
      <span className="pattern-header-toggle-grip" aria-hidden="true" />
    </button>
  );
  const history = (
    <>
      <HeaderIconButton icon="undo" label={undo.label} disabled={undo.disabled} onClick={undo.onClick} />
      <HeaderIconButton icon="redo" label={redo.label} disabled={redo.disabled} onClick={redo.onClick} />
    </>
  );
  const actions = (
    <>
      <ExportButton onClick={onExport} />
      <SettingsButton onClick={onSettings} />
    </>
  );
  return (
    <>
      {hidden ? (
        <h2 id={titleId} className="visually-hidden">
          {title}
        </h2>
      ) : (
        <header className="editor-heading">
          <div className="editor-heading-start">
            <Link className="editor-brand" to="/patterns" aria-label="Needlewise home">
              <BrandMark />
              <span>Needlewise</span>
            </Link>
            <div className="editor-heading-controls">
              {history}
              {actions}
            </div>
          </div>
          <div className="editor-heading-project">
            {onRenameTitle ? <EditableTitle value={title} headingId={titleId} onCommit={onRenameTitle} /> : <h2 id={titleId}>{title}</h2>}
          </div>
          <div className="editor-heading-info">
            <ViewSwitch current={view} onNavigate={onNavigate} />
          </div>
        </header>
      )}
      {hidden ? (
        <div className="pattern-header-strip">
          <div className="pattern-header-strip-start">
            <Link className="pattern-header-logo" to="/patterns" aria-label="Needlewise home">
              <BrandMark />
            </Link>
            {history}
          </div>
          {toggle}
          <div className="pattern-header-strip-end">{actions}</div>
        </div>
      ) : (
        toggle
      )}
    </>
  );
}
