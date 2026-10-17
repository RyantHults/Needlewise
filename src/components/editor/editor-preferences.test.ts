import { beforeEach, describe, expect, it } from "vitest";
import { defaultEditorPreferences, isEditorPreferences, normalizeEditorPreferences, readEditorPreferences, EDITOR_PREFERENCES_KEY } from "./editor-preferences";

describe("editor preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults the half stitch direction to slash", () => {
    expect(defaultEditorPreferences().halfStitchDirection).toBe("/");
  });

  it("loads stored preferences, tolerating and dropping a retired three-quarter direction", () => {
    const stored = { version: 1, railSide: "right", paletteDisplay: { numbers: true }, halfStitchDirection: "\\", threeQuarterDirection: "\\" };
    expect(isEditorPreferences(stored)).toBe(true);
    localStorage.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(stored));
    const loaded = readEditorPreferences("p1");
    expect(loaded.railSide).toBe("right");
    expect(loaded.halfStitchDirection).toBe("\\");
    expect(loaded).not.toHaveProperty("threeQuarterDirection");
  });

  it("falls back to slash for an invalid half stitch direction", () => {
    const base = defaultEditorPreferences();
    expect(normalizeEditorPreferences({ ...base, halfStitchDirection: "x" as never }).halfStitchDirection).toBe("/");
  });

  it("defaults the center mark off and reads legacy stored preferences as off", () => {
    expect(defaultEditorPreferences().showCenterMark).toBe(false);
    const legacy = { version: 1, railSide: "left", paletteDisplay: { numbers: true } };
    expect(isEditorPreferences(legacy)).toBe(true);
    localStorage.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(legacy));
    expect(readEditorPreferences("p1").showCenterMark).toBe(false);
  });

  it("round-trips an enabled center mark and rejects non-boolean values", () => {
    const enabled = { ...defaultEditorPreferences(), showCenterMark: true };
    localStorage.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(enabled));
    expect(readEditorPreferences("p1").showCenterMark).toBe(true);
    expect(isEditorPreferences({ ...enabled, showCenterMark: "yes" })).toBe(false);
  });
});
