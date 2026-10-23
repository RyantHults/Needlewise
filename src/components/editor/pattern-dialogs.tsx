import { useState } from "react";
import type { PatternDocument } from "../../domain";
import type { ProjectWorkspace } from "../../application/workspace";
import { ExportDialog } from "../export/ExportPanel";
import { createExportPdf } from "../export/export-pdf";
import { PatternSettingsDialog } from "./PatternSettingsDialog";
import type { EditorPreferences } from "./editor-preferences";

interface PatternDialogsOptions {
  workspace: ProjectWorkspace;
  document: PatternDocument;
  title: string;
  preferences: EditorPreferences;
  onPreferencesChange: (updater: (current: EditorPreferences) => EditorPreferences) => void;
  /** Which editor preferences the settings dialog offers on this page. */
  editorOptions: "all" | "placement";
}

/** The Export and Settings dialogs a pattern page's header opens; render `dialogs` once in the page. */
export function usePatternDialogs({ workspace, document, title, preferences, onPreferencesChange, editorOptions }: PatternDialogsOptions) {
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialogs = (
    <>
      {exportOpen && (
        <ExportDialog
          document={document}
          title={title}
          workspace={workspace}
          exportPdf={createExportPdf(document, workspace, title)}
          onClose={() => setExportOpen(false)}
        />
      )}
      {settingsOpen && (
        <PatternSettingsDialog
          workspace={workspace}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
          editorOptions={editorOptions}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
  return { openExport: () => setExportOpen(true), openSettings: () => setSettingsOpen(true), dialogs };
}
