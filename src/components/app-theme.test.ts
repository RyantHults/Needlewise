import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = () => void;

function stubColorScheme(dark: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches: dark,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (next: boolean) => {
    query.matches = next;
    for (const listener of listeners) listener();
  };
}

const loadTheme = async () => {
  vi.resetModules();
  return import("./app-theme");
};

const appliedTheme = () => document.documentElement.dataset.theme;

describe("app theme", () => {
  beforeEach(() => {
    stubColorScheme(false);
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies the stored choice", async () => {
    const { installTheme, setThemePreference } = await loadTheme();
    setThemePreference("frappe-mauve");
    delete document.documentElement.dataset.theme;
    installTheme();
    expect(appliedTheme()).toBe("frappe-mauve");
  });

  it("falls back to needlewise for a missing or unknown choice", async () => {
    const { installTheme, readThemePreference } = await loadTheme();
    installTheme();
    expect(appliedTheme()).toBe("needlewise");
    localStorage.setItem("needlewise-theme:v1", "solarized");
    installTheme();
    expect(readThemePreference()).toBe("needlewise");
    expect(appliedTheme()).toBe("needlewise");
  });

  it("resolves system from the colour scheme and follows its changes", async () => {
    const flip = stubColorScheme(true);
    const { installTheme, setThemePreference } = await loadTheme();
    setThemePreference("system");
    installTheme();
    expect(appliedTheme()).toBe("mocha-peach");
    flip(false);
    expect(appliedTheme()).toBe("needlewise");
    flip(true);
    expect(appliedTheme()).toBe("mocha-peach");
  });

  it("still applies when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { installTheme, setThemePreference } = await loadTheme();
    installTheme();
    expect(appliedTheme()).toBe("needlewise");
    setThemePreference("latte-peach");
    expect(appliedTheme()).toBe("latte-peach");
  });

  it("keeps a saved choice across a re-read", async () => {
    const first = await loadTheme();
    first.setThemePreference("mocha-mauve");
    const second = await loadTheme();
    expect(second.readThemePreference()).toBe("mocha-mauve");
  });
});
