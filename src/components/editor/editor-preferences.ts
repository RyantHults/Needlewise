import { useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../application/workspace";
import { DEFAULT_HALF_DIRECTION, type HalfStitchBrush } from "../../editor/contracts";

export const EDITOR_PREFERENCES_KEY = "needlewise-editor-preferences:v1";

export type HalfStitchDirection = NonNullable<HalfStitchBrush["direction"]>;

export type EditorPreferences = {
  version: 1;
  railSide: "left" | "right";
  paletteDisplay: { numbers: boolean };
  /** Restrict finger touch to movement controls; pen input still edits. */
  pencilModeEnabled: boolean;
  /** Which diagonal a half stitch is stamped along. */
  halfStitchDirection: HalfStitchDirection;
  /** Draws the pattern's center guides on the Track canvas. The editor never draws them. */
  showCenterMark: boolean;
};

export const defaultEditorPreferences = (): EditorPreferences => ({
  version: 1,
  railSide: "left",
  paletteDisplay: { numbers: true },
  pencilModeEnabled: false,
  halfStitchDirection: DEFAULT_HALF_DIRECTION,
  showCenterMark: false,
});

export const isEditorPreferences = (value: unknown): value is EditorPreferences => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Omit<Partial<EditorPreferences>, "paletteDisplay"> & {
    paletteDisplay?: { symbols?: unknown; numbers?: unknown };
    touchEditingEnabled?: unknown;
  };
  const paletteDisplay = candidate.paletteDisplay;
  return (
    candidate.version === 1 &&
    (candidate.railSide === "left" || candidate.railSide === "right") &&
    !!paletteDisplay &&
    typeof paletteDisplay === "object" &&
    (paletteDisplay.symbols === undefined ||
      typeof paletteDisplay.symbols === "boolean") &&
    typeof paletteDisplay.numbers === "boolean" &&
    (candidate.pencilModeEnabled === undefined ||
      typeof candidate.pencilModeEnabled === "boolean") &&
    (candidate.showCenterMark === undefined ||
      typeof candidate.showCenterMark === "boolean") &&
    (candidate.touchEditingEnabled === undefined ||
      typeof candidate.touchEditingEnabled === "boolean")
  );
};

export const normalizeEditorPreferences = (value: EditorPreferences): EditorPreferences => {
  const legacy = value as EditorPreferences & { touchEditingEnabled?: boolean };
  return {
    version: value.version,
    railSide: value.railSide,
    // Symbols follow the view mode now; a stored symbols flag is dropped.
    paletteDisplay: { numbers: value.paletteDisplay.numbers },
    // The earlier uncommitted envelope named the inverse setting.
    pencilModeEnabled:
      value.pencilModeEnabled ??
      (legacy.touchEditingEnabled === undefined
        ? false
        : !legacy.touchEditingEnabled),
    halfStitchDirection: value.halfStitchDirection === "\\" || value.halfStitchDirection === "/" ? value.halfStitchDirection : DEFAULT_HALF_DIRECTION,
    showCenterMark: value.showCenterMark === true,
  };
};

const readEditorPreferences = (workspaceId: string): EditorPreferences => {
  const defaults = defaultEditorPreferences();
  try {
    const stored = globalThis.localStorage.getItem(EDITOR_PREFERENCES_KEY);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored) as unknown;
        return isEditorPreferences(parsed)
          ? normalizeEditorPreferences(parsed)
          : defaults;
      } catch {
        return defaults;
      }
    }

    const legacy = globalThis.localStorage.getItem(
      `needlewise-editor-palette:${workspaceId}`,
    );
    if (legacy === null) return defaults;

    try {
      const parsed = JSON.parse(legacy) as unknown;
      if (!parsed || typeof parsed !== "object") return defaults;
      const candidate = parsed as Partial<{ symbols: boolean; numbers: boolean }>;
      if (
        (candidate.symbols !== undefined && typeof candidate.symbols !== "boolean") ||
        (candidate.numbers !== undefined && typeof candidate.numbers !== "boolean")
      )
        return defaults;
      return {
        ...defaults,
        paletteDisplay: { numbers: candidate.numbers ?? true },
      };
    } catch {
      return defaults;
    }
  } catch {
    return defaults;
  }
};

const writeEditorPreferences = (preferences: EditorPreferences): void => {
  try {
    globalThis.localStorage.setItem(
      EDITOR_PREFERENCES_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Preferences are a convenience; private browsing must not block editing.
  }
};

/** The editor preferences a pattern page shows, read once when it opens and written back on every change. */
export function useEditorPreferences(workspace: Pick<ProjectWorkspace, "metadata">): [EditorPreferences, (update: EditorPreferences | ((current: EditorPreferences) => EditorPreferences)) => void] {
  const [preferences, setPreferences] = useState(() => readEditorPreferences(workspace.metadata?.id ?? "default"));
  useEffect(() => {
    writeEditorPreferences(preferences);
  }, [preferences]);
  return [preferences, setPreferences];
}
