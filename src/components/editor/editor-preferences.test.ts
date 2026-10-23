import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultEditorPreferences, isEditorPreferences, normalizeEditorPreferences, useEditorPreferences, EDITOR_PREFERENCES_KEY } from "./editor-preferences";

const workspace = { metadata: { id: "p1" } } as never;
const loadPreferences = () => renderHook(() => useEditorPreferences(workspace)).result.current[0];

describe("editor preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults the half stitch direction to slash", () => {
    expect(defaultEditorPreferences().halfStitchDirection).toBe("/");
  });

  it("loads stored preferences, tolerating and dropping a retired three-quarter direction", () => {
    const stored = { version: 1, railSide: "right", paletteDisplay: { numbers: true }, halfStitchDirection: "\\", threeQuarterDirection: "\\" };
    expect(isEditorPreferences(stored)).toBe(true);
    localStorage.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(stored));
    const loaded = loadPreferences();
    expect(loaded.railSide).toBe("right");
    expect(loaded.halfStitchDirection).toBe("\\");
    expect(loaded).not.toHaveProperty("threeQuarterDirection");
  });

  it("falls back to slash for an invalid half stitch direction", () => {
    const base = defaultEditorPreferences();
    expect(normalizeEditorPreferences({ ...base, halfStitchDirection: "x" as never }).halfStitchDirection).toBe("/");
  });

  it("defaults the center mark off and accepts legacy stored preferences without it", () => {
    expect(defaultEditorPreferences().showCenterMark).toBe(false);
    const legacy = { version: 1, railSide: "left", paletteDisplay: { numbers: true } };
    expect(isEditorPreferences(legacy)).toBe(true);
  });

  it("round-trips an enabled center mark and rejects non-boolean values", () => {
    const enabled = { ...defaultEditorPreferences(), showCenterMark: true };
    localStorage.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(enabled));
    expect(loadPreferences().showCenterMark).toBe(true);
    expect(isEditorPreferences({ ...enabled, showCenterMark: "yes" })).toBe(false);
  });
});
