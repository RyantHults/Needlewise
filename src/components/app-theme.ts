import { readThemeColor } from "../rendering/theme-colors";

export const THEME_OPTIONS = [
  { id: "needlewise", label: "Needlewise", group: "Needlewise" },
  { id: "system", label: "System", group: "Needlewise" },
  { id: "latte-peach", label: "Catppuccin Latte (Peach)", group: "Catppuccin" },
  { id: "latte-mauve", label: "Catppuccin Latte (Mauve)", group: "Catppuccin" },
  { id: "frappe-peach", label: "Catppuccin Frappé (Peach)", group: "Catppuccin" },
  { id: "frappe-mauve", label: "Catppuccin Frappé (Mauve)", group: "Catppuccin" },
  { id: "macchiato-peach", label: "Catppuccin Macchiato (Peach)", group: "Catppuccin" },
  { id: "macchiato-mauve", label: "Catppuccin Macchiato (Mauve)", group: "Catppuccin" },
  { id: "mocha-peach", label: "Catppuccin Mocha (Peach)", group: "Catppuccin" },
  { id: "mocha-mauve", label: "Catppuccin Mocha (Mauve)", group: "Catppuccin" },
  { id: "rose-pine-main", label: "Rosé Pine Main", group: "Rosé Pine" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", group: "Rosé Pine" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", group: "Rosé Pine" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", group: "Gruvbox" },
  { id: "gruvbox-light", label: "Gruvbox Light", group: "Gruvbox" },
  { id: "everforest-dark", label: "Everforest Dark", group: "Everforest" },
  { id: "everforest-light", label: "Everforest Light", group: "Everforest" },
  { id: "solarized-dark", label: "Solarized Dark", group: "Solarized" },
  { id: "solarized-light", label: "Solarized Light", group: "Solarized" },
  { id: "nord", label: "Nord", group: "Nord" },
  { id: "dracula", label: "Dracula", group: "Dracula" },
  { id: "alucard", label: "Alucard", group: "Dracula" },
  { id: "tokyo-night-night", label: "Tokyo Night Night", group: "Tokyo Night" },
  { id: "tokyo-night-storm", label: "Tokyo Night Storm", group: "Tokyo Night" },
  { id: "tokyo-night-moon", label: "Tokyo Night Moon", group: "Tokyo Night" },
  { id: "tokyo-night-day", label: "Tokyo Night Day", group: "Tokyo Night" },
  { id: "kanagawa-wave", label: "Kanagawa Wave", group: "Kanagawa" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", group: "Kanagawa" },
  { id: "kanagawa-lotus", label: "Kanagawa Lotus", group: "Kanagawa" },
  { id: "one-dark", label: "One Dark", group: "One" },
  { id: "one-light", label: "One Light", group: "One" },
  { id: "github-light", label: "GitHub Light", group: "GitHub" },
  { id: "github-dark", label: "GitHub Dark", group: "GitHub" },
  { id: "github-dark-dimmed", label: "GitHub Dark Dimmed", group: "GitHub" },
] as const;

export type ThemeId = (typeof THEME_OPTIONS)[number]["id"];

export const THEME_PREFERENCE_KEY = "needlewise-theme:v1";

const DEFAULT_THEME: ThemeId = "needlewise";

const isThemeId = (value: string | null): value is ThemeId =>
  THEME_OPTIONS.some((option) => option.id === value);

/** The stored theme choice; anything missing, unknown, or unreadable is the default. */
export function readThemePreference(): ThemeId {
  try {
    const stored = globalThis.localStorage.getItem(THEME_PREFERENCE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const darkSchemeQuery = (): MediaQueryList | undefined =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;

/** Sets `data-theme` to the resolved theme and the browser chrome colour to the page colour. */
function applyTheme(theme: ThemeId): void {
  const resolved = theme === "system" ? (darkSchemeQuery()?.matches ? "mocha-peach" : "needlewise") : theme;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", readThemeColor("--color-page", meta.getAttribute("content") ?? ""));
}

/** Saves the choice and applies it. */
export function setThemePreference(theme: ThemeId): void {
  try {
    globalThis.localStorage.setItem(THEME_PREFERENCE_KEY, theme);
  } catch {
    // The choice still applies for this session when storage is blocked.
  }
  applyTheme(theme);
}

let subscribed = false;

/** Applies the stored theme, and re-resolves "system" when the colour scheme flips. */
export function installTheme(): void {
  applyTheme(readThemePreference());
  if (subscribed) return;
  subscribed = true;
  darkSchemeQuery()?.addEventListener("change", () => applyTheme(readThemePreference()));
}
