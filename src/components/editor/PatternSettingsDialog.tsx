import { useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../application/workspace";
import type { DisplayUnits } from "../../domain";
import { nextRovingIndex } from "../controls/roving";
import { SegmentedControl } from "../controls/SegmentedControl";
import { readThemePreference, setThemePreference } from "../app-theme";
import { InfoTip } from "../InfoTip";
import { Modal } from "../Modal";
import { useProjectUnits } from "../project-units";
import type { EditorPreferences } from "./editor-preferences";
import { ThemePicker } from "./ThemePicker";

type SettingsTab = "project" | "editor";
const TABS = [["project", "Project"], ["editor", "Editor"]] as const;
const UNIT_OPTIONS: readonly { value: DisplayUnits; label: string }[] = [{ value: "metric", label: "Metric" }, { value: "imperial", label: "Imperial" }];
const PLACEMENT_OPTIONS = [{ value: "left", label: "Left" }, { value: "right", label: "Right" }] as const;

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
  const [theme, setTheme] = useState(readThemePreference);
  const [units, applyUnits] = useProjectUnits(workspace);
  const { railSide, paletteDisplay: paletteOptions, pencilModeEnabled, showCenterMark } = preferences;

  useEffect(() => {
    setTitle(workspace.metadata?.title ?? "");
    setNotes(workspace.metadata?.notes ?? "");
  }, [
    workspace,
    workspace.metadata?.id,
    workspace.metadata?.title,
    workspace.metadata?.notes,
  ]);

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
          {TABS.map(([key, label], index) => <button
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
              const target = nextRovingIndex(event.key, index, TABS.length, 'horizontal');
              if (target === null) return;
              event.preventDefault();
              const next = TABS[target][0];
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
            <SegmentedControl aria-label="Measurement units" options={UNIT_OPTIONS} value={units} onChange={(next) => void applyUnits(next)} />
          </section>
        </div>
        <div id="settings-panel-editor" className="settings-tabpanel" role="tabpanel" aria-labelledby="settings-tab-editor" hidden={settingsTab !== 'editor'}>
          <section className="settings-section" aria-labelledby="editor-settings-heading">
            <h3 id="editor-settings-heading">Editor</h3>
            <SegmentedControl aria-label="Control placement" options={PLACEMENT_OPTIONS} value={railSide} onChange={(side) => onPreferencesChange((current) => ({ ...current, railSide: side }))} />
            <div className="theme-field">
              <span id="theme-label">Theme</span>
              <ThemePicker value={theme} onChange={(id) => { setTheme(id); setThemePreference(id); }} />
            </div>
            {editorOptions === "all" && (
              <>
                <label className="check-row palette-display-toggle">
                  Show palette numbers
                  <input
                    type="checkbox"
                    checked={paletteOptions.numbers}
                    onChange={(event) => {
                      const numbers = event.target.checked;
                      onPreferencesChange((current) => ({
                        ...current,
                        paletteDisplay: { ...current.paletteDisplay, numbers },
                      }));
                    }}
                  />
                </label>
                <label className="check-row palette-display-toggle" htmlFor="enable-pencil-mode">
                  <span className="pencil-mode-label">
                    Enable pencil mode
                    <InfoTip label="Pencil mode information" id="pencil-mode-tooltip">
                      In pencil mode, only a pencil or stylus can make changes to the pattern. Normal touch can only move or zoom.
                    </InfoTip>
                  </span>
                  <input
                    id="enable-pencil-mode"
                    type="checkbox"
                    aria-label="Enable pencil mode"
                    checked={pencilModeEnabled}
                    onChange={(event) => {
                      const pencilModeEnabled = event.target.checked;
                      onPreferencesChange((current) => ({ ...current, pencilModeEnabled }));
                    }}
                  />
                </label>
              </>
            )}
            {editorOptions === "placement" && (
              <label className="check-row palette-display-toggle">
                Show center guides
                <input
                  type="checkbox"
                  checked={showCenterMark}
                  onChange={(event) => {
                    // Read now: the updater runs after React resets the controlled input.
                    const showCenterMark = event.target.checked;
                    onPreferencesChange((current) => ({ ...current, showCenterMark }));
                  }}
                />
              </label>
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
