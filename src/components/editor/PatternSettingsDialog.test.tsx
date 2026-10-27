import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatternSettingsDialog } from "./PatternSettingsDialog";
import { defaultEditorPreferences } from "./editor-preferences";

function setup(editorOptions: "all" | "placement" = "all", updateActiveMetadata = vi.fn().mockResolvedValue(undefined)) {
  const workspace = {
    metadata: { id: "p1", title: "Rose", notes: "n", units: "metric" },
    updateActiveMetadata,
  } as never;
  const onClose = vi.fn();
  const onPreferencesChange = vi.fn();
  render(
    <PatternSettingsDialog
      workspace={workspace}
      preferences={defaultEditorPreferences()}
      onPreferencesChange={onPreferencesChange}
      editorOptions={editorOptions}
      onClose={onClose}
    />,
  );
  return { updateActiveMetadata, onClose, onPreferencesChange };
}

describe("PatternSettingsDialog", () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  function openThemes() {
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    fireEvent.click(screen.getByRole("button", { name: /^Theme/ }));
    return screen.getByRole("listbox", { name: "Theme" });
  }

  it("applies the chosen theme immediately and remembers it", () => {
    setup("all");
    openThemes();
    fireEvent.click(screen.getByRole("option", { name: "Catppuccin Mocha (Mauve)" }));
    expect(document.documentElement.dataset.theme).toBe("mocha-mauve");
    expect(screen.queryByRole("listbox")).toBeNull();
    cleanup();
    setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByRole("button", { name: /^Theme/ })).toHaveTextContent("Catppuccin Mocha (Mauve)");
  });

  it("groups themes by family", () => {
    setup("all");
    openThemes();
    expect(screen.getByRole("group", { name: "Rosé Pine" })).toBeInTheDocument();
  });

  it("chooses a theme from the keyboard and closes on Escape", () => {
    setup("all");
    openThemes();
    const selected = screen.getByRole("option", { selected: true });
    fireEvent.keyDown(selected, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: /^Theme/ })).toHaveTextContent("System");
    fireEvent.click(screen.getByRole("button", { name: /^Theme/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: /^Theme/ })).toHaveFocus();
  });

  it("offers the theme in placement mode", () => {
    setup("placement");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByRole("button", { name: /^Theme/ })).toBeInTheDocument();
  });

  it("shows every editor option in all mode", () => {
    setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByRole("group", { name: "Control placement" })).toBeInTheDocument();
    expect(screen.getByLabelText("Show palette numbers")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable pencil mode" })).toBeInTheDocument();
  });

  it("opens the pencil mode tip on click without toggling pencil mode", () => {
    const { onPreferencesChange } = setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    const info = screen.getByRole("button", { name: "Pencil mode information" });
    expect(info).toHaveAttribute("aria-describedby", "pencil-mode-tooltip");
    expect(info).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("shows only control placement in placement mode", () => {
    const { onPreferencesChange } = setup("placement");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.queryByLabelText("Show palette numbers")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Enable pencil mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    const updater = onPreferencesChange.mock.calls[0]![0];
    expect(updater(defaultEditorPreferences()).railSide).toBe("left");
  });

  it("toggles the center guides in placement mode", () => {
    const { onPreferencesChange } = setup("placement");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    const toggle = screen.getByLabelText("Show center guides");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const updater = onPreferencesChange.mock.calls[0]![0];
    expect(updater(defaultEditorPreferences()).showCenterMark).toBe(true);
  });

  it("moves between tabs with the arrow keys", async () => {
    setup();
    const project = screen.getByRole("tab", { name: "Project" });
    fireEvent.keyDown(project, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Editor" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("tab", { name: "Editor" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
  });
});
