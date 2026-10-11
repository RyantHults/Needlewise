import { useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../application/workspace";
import type { DisplayUnits } from "../../domain";
import { Modal } from "../Modal";
import type { EditorPreferences } from "./editor-preferences";

type SettingsTab = "project" | "editor";
const TABS = [["project", "Project"], ["editor", "Editor"]] as const;

export interface PatternSettingsDialogProps {
  workspace: Pick<ProjectWorkspace, "metadata" | "updateActiveMetadata">;
  preferences: EditorPreferences;
  onPreferencesChange: (updater: (current: EditorPreferences) => EditorPreferences) => void;
  editorOptions: "all" | "placement";
  onClose: () => void;
}

export function PatternSettingsDialog({
  workspace,
  preferences,
  onPreferencesChange,
  editorOptions,
  onClose,
}: PatternSettingsDialogProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("project");
  const [title, setTitle] = useState(workspace.metadata?.title ?? "");
  const [notes, setNotes] = useState(workspace.metadata?.notes ?? "");
  const [units, setUnits] = useState<DisplayUnits>(workspace.metadata?.units ?? "metric");
  const { railSide, paletteDisplay: paletteOptions, pencilModeEnabled } = preferences;

  useEffect(() => {
    setTitle(workspace.metadata?.title ?? "");
    setNotes(workspace.metadata?.notes ?? "");
    setUnits(workspace.metadata?.units ?? "metric");
  }, [
    workspace,
    workspace.metadata?.id,
    workspace.metadata?.title,
    workspace.metadata?.notes,
    workspace.metadata?.units,
  ]);

  const applyUnits = (next: DisplayUnits) => {
    setUnits(next);
    void Promise.resolve(workspace.updateActiveMetadata({ units: next })).catch(
      () => undefined,
    );
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await workspace.updateActiveMetadata({
      title: title.trim() || "Untitled sampler",
      notes,
      units,
    });
    onClose();
  };

  return (
    <Modal
      className="details-dialog"
      closeLabel="Close settings"
      title="Settings"
      titleId="settings-heading"
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map(([key, label]) => <button
            key={key}
            id={`settings-tab-${key}`}
            className="settings-tab"
            type="button"
            role="tab"
            aria-selected={settingsTab === key}
            aria-controls={`settings-panel-${key}`}
            tabIndex={settingsTab === key ? 0 : -1}
            onClick={() => setSettingsTab(key)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const keys = ['project', 'editor'] as const;
              const current = keys.indexOf(key);
              const target = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
              const next = keys[target]!;
              setSettingsTab(next);
              window.setTimeout(() => globalThis.document.getElementById(`settings-tab-${next}`)?.focus(), 0);
            }}
          >{label}</button>)}
        </div>
        <div id="settings-panel-project" className="settings-tabpanel" role="tabpanel" aria-labelledby="settings-tab-project" hidden={settingsTab !== 'project'}>
          <section className="settings-section" aria-labelledby="project-settings-heading">
            <h3 id="project-settings-heading">Project</h3>
            <label htmlFor="details-title-input">
              Title
              <input
                id="details-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label htmlFor="details-notes">
              Notes
              <textarea
                id="details-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <div className="trace-mode-row" role="group" aria-label="Measurement units">
              <button
                type="button"
                className="trace-mode-button"
                aria-pressed={units === "metric"}
                onClick={() => applyUnits("metric")}
              >
                Metric
              </button>
              <button
                type="button"
                className="trace-mode-button"
                aria-pressed={units === "imperial"}
                onClick={() => applyUnits("imperial")}
              >
                Imperial
              </button>
            </div>
          </section>
        </div>
        <div id="settings-panel-editor" className="settings-tabpanel" role="tabpanel" aria-labelledby="settings-tab-editor" hidden={settingsTab !== 'editor'}>
          <section className="settings-section" aria-labelledby="editor-settings-heading">
            <h3 id="editor-settings-heading">Editor</h3>
            <div className="trace-mode-row" role="group" aria-label="Control placement">
              <button
                type="button"
                className="trace-mode-button"
                aria-pressed={railSide === "left"}
                onClick={() => onPreferencesChange((current) => ({ ...current, railSide: "left" }))}
              >
                Left
              </button>
              <button
                type="button"
                className="trace-mode-button"
                aria-pressed={railSide === "right"}
                onClick={() => onPreferencesChange((current) => ({ ...current, railSide: "right" }))}
              >
                Right
              </button>
            </div>
            {editorOptions === "all" && (
              <>
                <label className="check-row palette-display-toggle">
                  Show palette numbers
                  <input
                    type="checkbox"
                    checked={paletteOptions.numbers}
                    onChange={(event) =>
                      onPreferencesChange((current) => ({
                        ...current,
                        paletteDisplay: { ...current.paletteDisplay, numbers: event.target.checked },
                      }))
                    }
                  />
                </label>
                <label className="check-row palette-display-toggle" htmlFor="enable-pencil-mode">
                  <span className="pencil-mode-label">
                    Enable pencil mode
                    <span className="settings-info-wrap">
                      <button
                        className="settings-info-button"
                        type="button"
                        aria-label="Pencil mode information"
                        aria-describedby="pencil-mode-tooltip"
                      >
                        i
                      </button>
                      <span id="pencil-mode-tooltip" className="settings-info-tooltip" role="tooltip">
                        In pencil mode, only a pencil or stylus can make changes to the pattern. Normal touch can only move or zoom.
                      </span>
                    </span>
                  </span>
                  <input
                    id="enable-pencil-mode"
                    type="checkbox"
                    aria-label="Enable pencil mode"
                    checked={pencilModeEnabled}
                    onChange={(event) =>
                      onPreferencesChange((current) => ({
                        ...current,
                        pencilModeEnabled: event.target.checked,
                      }))
                    }
                  />
                </label>
              </>
            )}
          </section>
        </div>
        <button className="button button-primary" type="submit">
          Save settings
        </button>
      </form>
    </Modal>
  );
}
